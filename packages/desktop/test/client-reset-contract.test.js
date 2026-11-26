import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('切换服务器前的检查命令只对本地登录页开放', () => {
  const main = JSON.parse(read('packages/desktop/src-tauri/capabilities/main.json'))
  assert.ok(main.permissions.includes('allow-desktop-login-preflight'))

  const board = JSON.parse(
    read('packages/desktop/src-tauri/capabilities/board-local-association.json'),
  )
  assert.equal(
    board.permissions.includes('allow-desktop-login-preflight'),
    false,
    '远程 Board 不得触发本地数据清理',
  )

  assert.match(
    read('packages/desktop/src-tauri/permissions/desktop.toml'),
    /identifier = "allow-desktop-login-preflight"[\s\S]*?commands\.allow = \["desktop_login_preflight"\]/,
  )
  assert.match(read('packages/desktop/src-tauri/src/main.rs'), /desktop_login_preflight,/)
})

test('清理范围固定为登录与绑定数据，运行环境不在清单里', () => {
  const reset = read('packages/desktop/src-tauri/src/client_reset.rs')
  assert.match(
    reset,
    /pub const RESET_ITEMS: \[&str; 3\] = \["client\.json", "agent", "desktop-plugins"\]/,
  )
  assert.doesNotMatch(reset, /RESET_ITEMS[^;]*"runtime"/)
  assert.doesNotMatch(reset, /RESET_ITEMS[^;]*"npm-global"/)
})

test('desktop_login 只有拿到显式确认才会备份并清理', () => {
  const main = read('packages/desktop/src-tauri/src/main.rs')
  assert.match(main, /switch_server: Option<bool>/)
  assert.match(
    main,
    /if switched && switch_server != Some\(true\) \{\s*return Err\(/,
    '未确认时必须直接报错，不能静默清库',
  )
  assert.match(main, /client_reset::backup_and_clear/)
  assert.match(main, /client_reset::restore/, '登录失败必须从备份恢复')
})

test('登录页先检查再弹确认，取消时不发起登录', () => {
  const login = read('packages/web/src/desktop/LoginApp.tsx')
  const preflightAt = login.indexOf("invoke<LoginPreflight>('desktop_login_preflight'")
  const loginAt = login.indexOf("await invoke('desktop_login'")
  assert.ok(preflightAt > 0, 'LoginApp must call desktop_login_preflight')
  assert.ok(loginAt > preflightAt, 'preflight must run before desktop_login')
  assert.match(login, /switchServer: preflight\.requiresReset === true/)
  assert.match(login, /切换会清除旧服务器的登录数据与项目绑定数据/)
  assert.match(login, /tone: 'danger'/)
  assert.match(
    read('packages/web/src/desktop/main-index.tsx'),
    /<ConfirmDialogProvider>/,
    '登录页需要 ConfirmDialogProvider 才能弹确认框',
  )
})
