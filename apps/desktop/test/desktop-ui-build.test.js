import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('desktop webviews are built from apps/web/desktop into apps/desktop/ui', () => {
  const tauri = JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json'))
  assert.equal(tauri.build.frontendDist, '../ui')
  assert.equal(tauri.app.withGlobalTauri, true)
  assert.match(tauri.app.security.csp, /script-src 'self'/)
  assert.match(tauri.app.security.csp, /style-src 'self'/)

  const pkg = JSON.parse(read('apps/web/package.json'))
  assert.equal(pkg.scripts['build:desktop'], 'tsc -b && vite build --config vite.desktop.config.ts')
  assert.match(read('apps/web/tsconfig.node.json'), /vite\.desktop\.config\.ts/)

  for (const page of ['index', 'control']) {
    const html = read(`apps/web/desktop/${page}.html`)
    assert.match(html, new RegExp(`src="\\.\\./src/desktop/main-${page}\\.tsx"`))
    assert.match(html, /<div id="root"><\/div>/)
  }
  assert.match(read('apps/web/desktop/control.html'), /Content-Security-Policy/)
})

test('built desktop pages load only relative assets and stay CSP-safe', () => {
  for (const page of ['index', 'control']) {
    const built = path.join(root, `apps/desktop/ui/${page}.html`)
    assert.ok(
      fs.existsSync(built),
      `apps/desktop/ui/${page}.html missing: run npm run build:desktop`,
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
  assert.match(read('.gitignore'), /^apps\/desktop\/ui\/$/m)
  for (const legacy of [
    'apps/desktop/ui/setup.js',
    'apps/desktop/ui/styles.css',
    'apps/desktop/ui/control.js',
    'apps/desktop/ui/control.css',
  ]) {
    assert.equal(fs.existsSync(path.join(root, legacy)), false, `${legacy} must not exist`)
  }
})

test('desktop logout uses a board-only command and forgets the saved password', () => {
  const permissions = read('apps/desktop/src-tauri/permissions/desktop.toml')
  const capability = JSON.parse(
    read('apps/desktop/src-tauri/capabilities/board-local-association.json'),
  )
  const main = read('apps/desktop/src-tauri/src/main.rs')
  const boardPage = read('apps/web/src/pages/board/BoardPage.tsx')
  const loginApp = read('apps/web/src/desktop/LoginApp.tsx')

  assert.match(permissions, /identifier = "allow-desktop-logout"/)
  assert.match(permissions, /commands\.allow = \["desktop_logout"\]/)
  assert.ok(capability.permissions.includes('allow-desktop-logout'))
  assert.match(main, /async fn desktop_logout\(/)
  assert.match(main, /ensure_board_caller\(&app, &window\)\?/)
  assert.match(main, /clear_desktop_session\(&app, &auth, true\)\.await/)
  assert.match(main, /forget_saved_password\(\);/)
  assert.match(main, /config\.password\.take\(\)\.is_none\(\)/)
  assert.match(main, /desktop_logout,\s+desktop_login,/)
  assert.match(boardPage, /await desktopInvoke\('desktop_logout'\)/)
  assert.match(boardPage, /await logout\(\)/)
  assert.match(loginApp, /app\.serverUrl && app\.username && app\.password/)
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
    nodeTests.indexOf('npm run build:desktop') > 0 &&
      nodeTests.indexOf('npm run build:desktop') < nodeTests.indexOf('run: npm run test:all'),
    'node-tests must build the desktop ui before npm run test:all',
  )

  const desktopBuild = job('desktop-build')
  assert.ok(
    desktopBuild.indexOf('npm run build:desktop') > 0 &&
      desktopBuild.indexOf('npm run build:desktop') < desktopBuild.indexOf('run: tauri build'),
    'desktop-build must build the desktop ui before tauri build',
  )
})
