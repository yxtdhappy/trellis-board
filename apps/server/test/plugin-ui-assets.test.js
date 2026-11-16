import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { serveStatic } from '../http-common.js'

const UI_DIR = fileURLToPath(new URL('../plugin-ui', import.meta.url))
const ROOT = fileURLToPath(new URL('../../..', import.meta.url))

// 直接把 serveStatic 当成 /plugin-ui/<file> 的处理器来测：宿主路由用的是同一份实现，
// 这里覆盖内容类型、缓存头与目录穿越。
function serve(pathname, method = 'GET') {
  const response = new PassThrough()
  const chunks = []
  response.on('data', (chunk) => chunks.push(chunk))
  const ended = new Promise((resolve) => response.on('end', resolve))
  const result = { status: 0, headers: {}, body: '', failed: false }
  response.writeHead = (status, headers) => {
    result.status = status
    result.headers = headers
  }
  const reject = (status, body, headers = {}) => {
    result.status = status
    result.body = body
    result.headers = headers
    result.failed = true
  }
  serveStatic({
    request: { method },
    response,
    pathname,
    publicDir: UI_DIR,
    invalidPath: () => reject(400, 'Bad request'),
    methodNotAllowed: () => reject(405, 'Method not allowed', { allow: 'GET, HEAD' }),
    forbidden: () => reject(403, 'Forbidden'),
    notFound: () => reject(404, 'Not found'),
  })
  if (result.failed) return Promise.resolve(result)
  return ended.then(() => ({ ...result, body: Buffer.concat(chunks).toString('utf8') }))
}

test('/plugin-ui/v1 提供事件组件脚本与样式', async () => {
  const script = await serve('/v1/combo.js')
  assert.equal(script.status, 200)
  assert.match(script.headers['content-type'], /text\/javascript/)
  assert.match(script.headers['cache-control'], /max-age/)
  assert.match(script.body, /TrellisCombo/)

  const style = await serve('/v1/combo.css')
  assert.equal(style.status, 200)
  assert.match(style.headers['content-type'], /text\/css/)
  assert.match(style.body, /\.combo-menu/)
})

test('/plugin-ui 拒绝目录穿越与非 GET', async () => {
  const escaped = await serve('/..%2findex.js')
  assert.equal(escaped.status, 403)

  const missing = await serve('/nope.js')
  assert.equal(missing.status, 404)

  const post = await serve('/v1/combo.js', 'POST')
  assert.equal(post.status, 405)
  assert.equal(post.headers.allow, 'GET, HEAD')
})

test('/plugin-ui/v1 提供设计令牌、基础样式、桥接与组件脚本', async () => {
  const expectations = [
    ['/v1/tokens.css', /text\/css/, /--tb-accent/],
    ['/v1/base.css', /text\/css/, /--tb-font/],
    ['/v1/ui.css', /text\/css/, /\.tb-table/],
    ['/v1/ui.js', /text\/javascript/, /TrellisUI/],
    ['/v1/bridge.js', /text\/javascript/, /trellis:request/],
    ['/v1/demo.html', /text\/html/, /面板组件库/],
  ]
  for (const [pathname, contentType, marker] of expectations) {
    const asset = await serve(pathname)
    assert.equal(asset.status, 200, pathname)
    assert.match(asset.headers['content-type'], contentType, pathname)
    assert.match(asset.body, marker, pathname)
  }
})

test('demo 页把 v1 的样式与脚本都引全', async () => {
  const demo = await serve('/v1/demo.html')
  for (const file of [
    'tokens.css',
    'base.css',
    'ui.css',
    'combo.css',
    'bridge.js',
    'ui.js',
    'combo.js',
  ]) {
    assert.match(demo.body, new RegExp(`/plugin-ui/v1/${file.replace('.', '\\.')}`), file)
  }
})

test('面板共用组件放在宿主侧，不从插件目录加载', () => {
  // 防止又把共用 UI 塞回某个插件：那样插件被禁用/目录重构就会断。
  assert.equal(fs.existsSync(path.join(ROOT, 'plugins/accounts-core/panel/widget/combo.js')), false)
  for (const panel of [
    'plugins/accounts-core/panel/index.html',
    'plugins/jenkins-ops/panel/index.html',
  ]) {
    const html = fs.readFileSync(path.join(ROOT, panel), 'utf8')
    assert.match(html, /src="\/plugin-ui\/v1\/combo\.js"/)
    assert.doesNotMatch(html, /panel\/widget\/combo\.js/)
  }
})

test('已迁移的面板按 v1 约定引入令牌、桥接与组件', () => {
  const html = fs.readFileSync(path.join(ROOT, 'plugins/accounts-core/panel/index.html'), 'utf8')
  for (const file of ['tokens.css', 'base.css', 'ui.css']) {
    assert.match(html, new RegExp(`/plugin-ui/v1/${file.replace('.', '\\.')}`), file)
  }
  assert.match(html, /src="\/plugin-ui\/v1\/bridge\.js"/)
  assert.match(html, /src="\/plugin-ui\/v1\/ui\.js"/)
  // 面板自己的样式只留布局，颜色必须走 --tb-*
  const css = fs.readFileSync(path.join(ROOT, 'plugins/accounts-core/panel/app.css'), 'utf8')
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,6}\b/)
  assert.match(css, /--tb-border/)
})
