import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('desktop webviews are built from web/desktop into desktop/ui', () => {
  const tauri = JSON.parse(read('desktop/src-tauri/tauri.conf.json'))
  assert.equal(tauri.build.frontendDist, '../ui')
  assert.equal(tauri.app.withGlobalTauri, true)
  assert.match(tauri.app.security.csp, /script-src 'self'/)
  assert.match(tauri.app.security.csp, /style-src 'self'/)

  const pkg = JSON.parse(read('web/package.json'))
  assert.equal(pkg.scripts['build:desktop'], 'tsc -b && vite build --config vite.desktop.config.ts')
  assert.match(read('web/tsconfig.node.json'), /vite\.desktop\.config\.ts/)

  for (const page of ['index', 'control']) {
    const html = read(`web/desktop/${page}.html`)
    assert.match(html, new RegExp(`src="\\.\\./src/desktop/main-${page}\\.tsx"`))
    assert.match(html, /<div id="root"><\/div>/)
  }
  assert.match(read('web/desktop/control.html'), /Content-Security-Policy/)
})

test('built desktop pages load only relative assets and stay CSP-safe', () => {
  for (const page of ['index', 'control']) {
    const built = path.join(root, `desktop/ui/${page}.html`)
    assert.ok(
      fs.existsSync(built),
      `desktop/ui/${page}.html missing: run npm --prefix web run build:desktop`,
    )
    const html = fs.readFileSync(built, 'utf8')
    assert.match(
      html,
      /src="\.\/assets\//,
      `${page}.html must use relative asset URLs (vite base './')`,
    )
    assert.match(html, /href="\.\/assets\//, `${page}.html must use relative stylesheet URLs`)
    assert.doesNotMatch(
      html,
      /(?:src|href)="\/assets\//,
      `${page}.html must not use root-absolute asset URLs`,
    )
    assert.doesNotMatch(
      html,
      /<script(?![^>]*\ssrc=)[^>]*>/i,
      `${page}.html must not inline scripts (CSP)`,
    )
  }
})

test('desktop ui output is ignored and hand-written pages are gone', () => {
  assert.match(read('.gitignore'), /^desktop\/ui\/$/m)
  for (const legacy of [
    'desktop/ui/setup.js',
    'desktop/ui/styles.css',
    'desktop/ui/control.js',
    'desktop/ui/control.css',
  ]) {
    assert.equal(fs.existsSync(path.join(root, legacy)), false, `${legacy} must not exist`)
  }
})

test('windows workflows build the desktop ui before the client is bundled or tested', () => {
  const workflow = read('.github/workflows/windows.yml')
  const jobs = workflow.split(/\n {2}(?=\w[\w-]*:\n)/)
  const job = (name) => {
    const found = jobs.find((block) => block.startsWith(`${name}:`))
    assert.ok(found, `workflow job ${name} missing`)
    return found
  }

  const nodeTests = job('node-tests')
  assert.ok(
    nodeTests.indexOf('npm --prefix web run build:desktop') > 0 &&
      nodeTests.indexOf('npm --prefix web run build:desktop') < nodeTests.indexOf('run: npm test'),
    'node-tests must build the desktop ui before npm test',
  )

  const desktopBuild = job('desktop-build')
  assert.ok(
    desktopBuild.indexOf('npm --prefix web run build:desktop') > 0 &&
      desktopBuild.indexOf('npm --prefix web run build:desktop') <
        desktopBuild.indexOf('run: tauri build'),
    'desktop-build must build the desktop ui before tauri build',
  )
})
