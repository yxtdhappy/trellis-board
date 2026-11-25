import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('desktop webviews are built from packages/web/desktop into packages/desktop/ui', () => {
  const tauri = JSON.parse(read('packages/desktop/src-tauri/tauri.conf.json'))
  assert.equal(tauri.build.frontendDist, '../ui')
  assert.equal(tauri.app.withGlobalTauri, true)
  assert.match(tauri.app.security.csp, /script-src 'self'/)
  assert.match(tauri.app.security.csp, /style-src 'self'/)

  const pkg = JSON.parse(read('packages/web/package.json'))
  assert.equal(pkg.scripts['build:desktop'], 'tsc -b && vite build --config vite.desktop.config.ts')
  assert.match(read('packages/web/tsconfig.node.json'), /vite\.desktop\.config\.ts/)

  const html = read('packages/web/desktop/index.html')
  assert.match(html, /src="\.\.\/src\/desktop\/main-index\.tsx"/)
  assert.match(html, /<div id="root"><\/div>/)

  assert.deepEqual(tauri.app.security.capabilities, ['main', 'board-local-association'])
  assert.equal(
    fs.existsSync(path.join(root, 'packages/desktop/src-tauri/capabilities/live-control.json')),
    false,
    'live-control capability must stay deleted: 确认弹窗在主窗口内渲染',
  )
})

test('built desktop pages load only relative assets and stay CSP-safe', () => {
  const built = path.join(root, 'packages/desktop/ui/index.html')
  assert.ok(
    fs.existsSync(built),
    'packages/desktop/ui/index.html missing: run yarn build --target=desktop-ui',
  )
  const html = fs.readFileSync(built, 'utf8')
  assert.match(
    html,
    /src="\.\/assets\//,
    'index.html must use relative asset URLs (vite base "./")',
  )
  assert.match(html, /href="\.\/assets\//, 'index.html must use relative stylesheet URLs')
  assert.doesNotMatch(
    html,
    /(?:src|href)="\/assets\//,
    'index.html must not use root-absolute asset URLs',
  )
  assert.doesNotMatch(
    html,
    /<script(?![^>]*\ssrc=)[^>]*>/i,
    'index.html must not inline scripts (CSP)',
  )
})

test('desktop ui output is ignored and hand-written pages are gone', () => {
  assert.match(read('.gitignore'), /^packages\/desktop\/ui\/$/m)
  for (const legacy of [
    'packages/desktop/ui/setup.js',
    'packages/desktop/ui/styles.css',
    'packages/desktop/ui/control.js',
    'packages/desktop/ui/control.css',
  ]) {
    assert.equal(fs.existsSync(path.join(root, legacy)), false, `${legacy} must not exist`)
  }
})

test('control sync errors show project and branch without repo paths', () => {
  const taskSync = [
    'packages/desktop/src-tauri/src/agent/task_sync.rs',
    'packages/desktop/src-tauri/src/agent/task_sync/bindings.rs',
    'packages/desktop/src-tauri/src/agent/task_sync/errors.rs',
  ]
    .map(read)
    .join('\n')
  const control = [
    'packages/web/src/desktop/LiveSyncControlDialog.tsx',
    'packages/web/src/desktop/live-control/control-event.ts',
  ]
    .map(read)
    .join('\n')

  assert.match(taskSync, /event\["projectName"\]/)
  assert.match(taskSync, /event\["branchName"\]/)
  assert.match(taskSync, /binding\.display_name/)
  assert.match(taskSync, /binding\.branch_name/)
  assert.doesNotMatch(taskSync, /"repoPath":/)
  assert.doesNotMatch(taskSync, /服务端任务目录越界/)
  assert.match(control, /projectName\?: string/)
  assert.match(control, /branchName\?: string/)
  assert.match(control, /event\.projectName/)
  assert.match(control, /event\.taskSpaceId/)
  assert.match(control, /event\.taskDir/)
})

test('desktop state refresh uses events, ETag and visible fallbacks', () => {
  const capability = JSON.parse(
    read('packages/desktop/src-tauri/capabilities/board-local-association.json'),
  )
  const projectRail = read('packages/web/src/components/layout/ProjectRail.tsx')
  const control = read('packages/web/src/desktop/LiveSyncControlDialog.tsx')
  const useBoard = read('packages/web/src/hooks/useBoard.ts')
  const boardApi = read('packages/web/src/api/board.ts')
  const taskSync = [
    'packages/desktop/src-tauri/src/agent/task_sync.rs',
    'packages/desktop/src-tauri/src/agent/task_sync/bindings.rs',
    'packages/desktop/src-tauri/src/agent/task_sync/errors.rs',
  ]
    .map(read)
    .join('\n')
  const agentService = read('packages/desktop/src-tauri/src/agent_service.rs')

  assert.ok(capability.permissions.includes('core:event:allow-listen'))
  assert.ok(capability.permissions.includes('core:event:allow-unlisten'))
  assert.match(projectRail, /desktop-state-changed/)
  assert.match(projectRail, /10_000/)
  assert.doesNotMatch(projectRail, /setInterval\([^)]*3_000/)
  assert.match(control, /live-control-changed/)
  assert.match(control, /10_000/)
  assert.doesNotMatch(control, /setInterval\([^)]*750/)
  assert.match(boardApi, /if-none-match/)
  assert.match(boardApi, /notModified: true/)
  assert.match(useBoard, /teamStatusEtag/)
  assert.match(useBoard, /filters\.taskSpaceId === 'all'/)
  assert.match(taskSync, /desktop-state-changed|notify_state_changed/)
  assert.match(agentService, /desktop-state-changed/)
  assert.match(agentService, /live-control-changed/)
})

test('desktop logout uses a board-only command and forgets the saved password', () => {
  const permissions = read('packages/desktop/src-tauri/permissions/desktop.toml')
  const capability = JSON.parse(
    read('packages/desktop/src-tauri/capabilities/board-local-association.json'),
  )
  const localCapability = JSON.parse(read('packages/desktop/src-tauri/capabilities/main.json'))
  const main = read('packages/desktop/src-tauri/src/main.rs')
  const boardPage = read('packages/web/src/pages/board/BoardPage.tsx')
  const loginApp = read('packages/web/src/desktop/LoginApp.tsx')

  assert.match(permissions, /identifier = "allow-desktop-logout"/)
  assert.match(permissions, /commands\.allow = \["desktop_logout"\]/)
  assert.ok(capability.permissions.includes('allow-desktop-logout'))
  assert.ok(!localCapability.permissions.includes('allow-desktop-logout'))
  assert.match(main, /async fn desktop_logout\(/)
  assert.match(main, /ensure_board_caller\(&app, &window\)\?/)
  assert.match(main, /clear_desktop_session\(&app, &auth, true\)\.await/)
  assert.match(main, /forget_saved_password\(\);/)
  assert.match(main, /config\.password\.take\(\)\.is_none\(\)/)
  assert.match(main, /desktop_logout,\s+desktop_login,/)
  assert.match(main, /webview::PageLoadEvent/)
  assert.match(main, /\.on_page_load\(move \|_, payload\|/)
  assert.match(main, /payload\.event\(\) == PageLoadEvent::Started/)
  assert.match(main, /payload\.url\(\)\.scheme\(\) != "about"/)
  assert.match(main, /navigation::is_local_page\(payload\.url\(\)\)/)
  assert.match(main, /local_url = Some\(payload\.url\(\)\.clone\(\)\)/)
  assert.doesNotMatch(main, /let Ok\(url\) = window\.url\(\)/)
  assert.match(boardPage, /await desktopInvoke\('desktop_logout'\)/)
  assert.match(boardPage, /await logout\(\)/)
  assert.match(loginApp, /app\.serverUrl && app\.username && app\.password/)
})

test('desktop board shows the product name and version from a board-only command', () => {
  const permissions = read('packages/desktop/src-tauri/permissions/desktop.toml')
  const capability = JSON.parse(
    read('packages/desktop/src-tauri/capabilities/board-local-association.json'),
  )
  const localCapability = JSON.parse(read('packages/desktop/src-tauri/capabilities/main.json'))
  const tauri = JSON.parse(read('packages/desktop/src-tauri/tauri.conf.json'))
  const main = read('packages/desktop/src-tauri/src/main.rs')
  const boardPage = read('packages/web/src/pages/board/BoardPage.tsx')
  const adminPage = read('packages/web/src/pages/admin/AdminPage.tsx')
  const loginPage = read('packages/web/src/pages/login/LoginPage.tsx')
  const loginApp = read('packages/web/src/desktop/LoginApp.tsx')
  const topBar = read('packages/web/src/components/layout/TopBar.tsx')
  const portableScript = read('packages/desktop/package-portable.ps1')

  assert.equal(tauri.productName, 'Board')
  assert.equal(tauri.identifier, 'com.trellisboard.client')
  assert.match(permissions, /identifier = "allow-client-identity"/)
  assert.match(permissions, /commands\.allow = \["client_identity"\]/)
  assert.ok(capability.permissions.includes('allow-client-identity'))
  assert.ok(!localCapability.permissions.includes('allow-client-identity'))
  assert.match(main, /fn client_identity\(/)
  assert.match(main, /ensure_board_caller\(&app, &window\)\?;/)
  assert.match(main, /app_display_name\(app\.config\(\)\.product_name\.as_deref\(\)\)/)
  assert.match(main, /env!\("CARGO_PKG_VERSION"\)/)
  assert.match(main, /app_status,\s+client_identity,\s+desktop_logout,/)
  assert.match(boardPage, /desktopInvoke\('client_identity'\)/)
  assert.match(boardPage, /resolveAppName\(\{/)
  assert.match(boardPage, /document\.title = brandName \|\| '看板'/)
  assert.match(adminPage, /resolveAppName\(\{/)
  assert.match(loginPage, /resolveAppName\(\{/)
  assert.match(loginApp, /resolveAppName\(\{/)
  assert.doesNotMatch(loginApp, /TRELLIS DESKTOP/)
  assert.match(topBar, /aria-label=\{brandName \? `\$\{brandName\} 首页` : '首页'\}/)
  assert.match(topBar, /v\{displayVersion\}/)
  assert.match(portableScript, /trellis-board-client\.exe/)
  assert.match(portableScript, /\$packageName = "TrellisBoard_\$\{version\}_x64-portable"/)
})

test('desktop board can drain a task share link opened through the protocol handler', () => {
  const permissions = read('packages/desktop/src-tauri/permissions/desktop.toml')
  const capability = JSON.parse(
    read('packages/desktop/src-tauri/capabilities/board-local-association.json'),
  )
  const localCapability = JSON.parse(read('packages/desktop/src-tauri/capabilities/main.json'))
  const tauri = JSON.parse(read('packages/desktop/src-tauri/tauri.conf.json'))
  const main = read('packages/desktop/src-tauri/src/main.rs')
  const shareLink = read('packages/desktop/src-tauri/src/share_link.rs')
  const shareLinkLib = read('packages/web/src/lib/share-link.ts')
  const hook = read('packages/web/src/features/board/useShareLinkOpen.ts')
  const boardPage = read('packages/web/src/pages/board/BoardPage.tsx')

  assert.match(permissions, /identifier = "allow-take-pending-share-link"/)
  assert.match(permissions, /commands\.allow = \["take_pending_share_link"\]/)
  assert.ok(capability.permissions.includes('allow-take-pending-share-link'))
  assert.ok(!localCapability.permissions.includes('allow-take-pending-share-link'))
  assert.match(shareLink, /pub enum PendingShare/)
  assert.match(shareLink, /Invalid,/)
  assert.match(shareLink, /fn take_pending_share_link\(/)
  assert.match(shareLink, /ensure_board_caller\(&app, &window\)\?/)
  assert.match(shareLink, /navigation::board_server_url\(&server\)/)
  assert.match(shareLink, /spec-board/)
  assert.match(shareLinkLib, /spec-board:\/\/task/)
  assert.match(main, /plugin_host::desktop_plugin_asset,\s+share_link::take_pending_share_link/)
  assert.match(main, /share_link::clear\(&mut value\)/)
  assert.match(main, /register_share_link\(&handle\);/)
  assert.match(main, /deep_link\.on_open_url/)
  assert.deepEqual(tauri.plugins['deep-link'].desktop.schemes, ['spec-board'])
  assert.match(hook, /if \(!enabled \|\| !invokeCommand \|\| !listenEvent\) return/)
  assert.match(hook, /invokeCommand<PendingShare \| null>\('take_pending_share_link'\)/)
  assert.match(hook, /pending\.kind === 'invalid'/)
  assert.match(hook, /isSameShareServer\(target\.server,\s*appOriginWithBase\(\)\)/)
  assert.match(hook, /\/api\/tasks\?\$\{query\}/)
  assert.match(hook, /if \(!active \|\| sequence !== latest\) return/)
  assert.match(
    hook,
    /listenEvent\('share-link-open',\s*\(\)\s*=>\s*\{[\s\S]*?takePending\(\)[\s\S]*?\}\)\s*\.then\([\s\S]*?takePending\(\)/,
  )
  assert.match(
    boardPage,
    /useShareLinkOpen\(\{[\s\S]*?enabled:\s*Boolean\(runtime\)\s*&&\s*!mustChangePassword/,
  )
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
    nodeTests.indexOf('yarn build --target=desktop-ui') > 0 &&
      nodeTests.indexOf('yarn build --target=desktop-ui') <
        nodeTests.indexOf('run: yarn test --scope=all'),
    'node-tests must build the desktop ui before yarn test --scope=all',
  )

  const desktopBuild = job('desktop-build')
  assert.ok(
    desktopBuild.indexOf('yarn build --target=desktop-ui') > 0 &&
      desktopBuild.indexOf('yarn build --target=desktop-ui') <
        desktopBuild.indexOf('run: yarn build --target=desktop --skip-ui'),
    'desktop-build must build the desktop ui before yarn build --target=desktop --skip-ui',
  )
})

test('desktop local plugin commands stay board-only and lazy', () => {
  const permissions = read('packages/desktop/src-tauri/permissions/desktop.toml')
  const capability = JSON.parse(
    read('packages/desktop/src-tauri/capabilities/board-local-association.json'),
  )
  const localCapability = JSON.parse(read('packages/desktop/src-tauri/capabilities/main.json'))
  const main = read('packages/desktop/src-tauri/src/main.rs')
  const host = read('packages/desktop/src-tauri/src/plugin_host.rs')
  const boardPage = read('packages/web/src/pages/board/BoardPage.tsx')
  const adapter = read('packages/web/src/api/desktop-plugins.ts')
  const transport = read('packages/web/src/api/plugin-transport.ts')

  const commands = [
    ['desktop-plugins-list', 'desktop_plugins_list'],
    ['desktop-plugin-set-enabled', 'desktop_plugin_set_enabled'],
    ['desktop-plugin-reorder', 'desktop_plugin_reorder'],
    ['desktop-plugin-logs', 'desktop_plugin_logs'],
    ['desktop-plugin-panels', 'desktop_plugin_panels'],
    ['desktop-plugin-request', 'desktop_plugin_request'],
    ['desktop-plugin-asset', 'desktop_plugin_asset'],
  ]
  for (const [identifier, command] of commands) {
    assert.match(permissions, new RegExp(`identifier = "allow-${identifier}"`))
    assert.match(permissions, new RegExp(`commands\\.allow = \\["${command}"\\]`))
    assert.ok(capability.permissions.includes(`allow-${identifier}`))
    assert.ok(!localCapability.permissions.includes(`allow-${identifier}`))
    assert.match(main, new RegExp(`${command},?`))
    assert.match(host, new RegExp(`pub async fn ${command}\\(`))
  }

  // 每个命令先校验调用方 origin，再触碰宿主状态。
  assert.match(host, /caller\(&app, &window\)\?;/)
  assert.match(host, /ensure_board_caller/)
  assert.match(host, /if !entries\.any_enabled\(\) \{\s+return Ok\(false\);/)
  assert.match(host, /desktop-plugins/)
  assert.match(host, /kill_process_tree/)
  assert.match(boardPage, /isClient \? \[DESKTOP_PLUGIN_NAV\] : \[\]/)
  assert.match(boardPage, /fetchDesktopPanels/)
  assert.match(adapter, /desktopAvailable = transport\.pluginTransportAvailable\(\)/)
  assert.match(transport, /desktop_plugin_request/)
})
