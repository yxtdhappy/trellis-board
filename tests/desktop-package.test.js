import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createUser } from '../server/team/auth.js'
import { createTeamRuntime } from '../server/team/http.js'
import {
  enrollDesktopDevice,
  readAgentIdentity,
  revokeDesktopDevice,
  validateDeviceName,
} from '../desktop/sidecar/desktop-device.js'
import { createSeaConfig } from '../desktop/sidecar/bundle.mjs'
import { resolveTrellisRuntime } from '../desktop/sidecar/trellis-runtime.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DESKTOP = path.join(ROOT, 'desktop')
const PUBLIC_ORIGIN = 'http://127.0.0.1:4317'
const SILENT_LOGGER = { info() {}, warn() {}, error() {} }

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8')
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath))
}

function testConfig(origin = PUBLIC_ORIGIN, port = 0) {
  return {
    mode: 'team',
    bindHost: '127.0.0.1',
    port,
    publicUrl: new URL(origin),
    publicOrigin: origin,
    sessionTtlMs: 12 * 60 * 60 * 1000,
    agentStaleMs: 60_000,
    cookieSecure: false,
    trustProxy: false,
    allowLocalGitRemotes: false,
  }
}

function request(runtime, pathname, { method = 'GET', body = null, cookie = null } = {}) {
  const address = runtime.address()
  const origin = runtime.testOrigin || PUBLIC_ORIGIN
  const originUrl = new URL(origin)
  const payload = body == null ? null : JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const headers = { host: originUrl.host }
    if (payload != null) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(payload)
    }
    if (method !== 'GET' && method !== 'HEAD') headers.origin = origin
    if (cookie) headers.cookie = cookie
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: address.port,
        path: pathname,
        method,
        headers,
      },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          if (text) {
            try {
              json = JSON.parse(text)
            } catch {
              json = text
            }
          }
          resolve({ status: response.statusCode, headers: response.headers, body: json })
        })
      },
    )
    req.on('error', reject)
    if (payload != null) req.write(payload)
    req.end()
  })
}

function cookieOf(response) {
  return String((response.headers['set-cookie'] || [])[0] || '').split(';')[0]
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function startRuntime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-desktop-package-'))
  const port = await freePort()
  const serverUrl = `http://127.0.0.1:${port}`
  const runtime = await createTeamRuntime({
    config: testConfig(serverUrl, port),
    databaseFile: path.join(root, 'data', 'board.sqlite'),
    dataDir: path.join(root, 'data'),
    logger: SILENT_LOGGER,
    requireAdmin: false,
    enablePolling: false,
  })
  await runtime.start()
  runtime.testOrigin = serverUrl
  t.after(async () => {
    await runtime.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const sysadmin = await createUser(runtime.db, {
    username: 'sysadmin',
    displayName: '系统管理员',
    password: 'Legacy-Password-123',
    systemAdmin: true,
    mustChangePassword: false,
  })
  const login = await request(runtime, '/api/auth/login', {
    method: 'POST',
    body: { username: 'sysadmin', password: 'Legacy-Password-123' },
  })
  assert.equal(login.status, 200)
  const adminCookie = cookieOf(login)
  const team = await request(runtime, '/api/admin/teams', {
    method: 'POST',
    cookie: adminCookie,
    body: { name: '桌面客户端测试团队' },
  })
  assert.equal(team.status, 201)
  const now = new Date().toISOString()
  runtime.db
    .prepare(`
    INSERT OR IGNORE INTO team_member(team_id, user_id, role, created_at, updated_at)
    VALUES (?, ?, 'admin', ?, ?)
  `)
    .run(team.body.team.id, sysadmin.id, now, now)
  return { runtime, adminCookie, teamId: team.body.team.id, serverUrl }
}

test('tauri.conf.json 固定 NSIS currentUser 且 CSP 无 unsafe 指令', () => {
  const config = readJson('desktop/src-tauri/tauri.conf.json')
  const rootPackage = readJson('package.json')
  assert.equal(config.$schema, 'https://schema.tauri.app/config/2')
  assert.equal(config.version, rootPackage.version)
  assert.equal(config.identifier, 'com.trellisboard.client')
  assert.equal(config.build.frontendDist, '../ui')
  assert.equal(config.bundle.active, true)
  assert.deepEqual(config.bundle.targets, ['nsis'])
  assert.equal(config.bundle.windows.nsis.installMode, 'currentUser')
  assert.equal(config.bundle.windows.nsis.installerHooks, './windows/hooks.nsh')
  assert.equal(config.bundle.windows.webviewInstallMode.type, 'downloadBootstrapper')
  assert.equal(config.bundle.windows.webviewInstallMode.silent, true)
  assert.deepEqual(config.bundle.externalBin, ['binaries/trellis-agent'])
  assert.deepEqual(config.bundle.resources, {
    'resources/trellis-runtime/': 'trellis-runtime/',
  })
  assert.deepEqual(config.app.security.capabilities, [
    'main',
    'board-local-association',
    'live-control',
  ])
  assert.deepEqual(config.app.windows, [])
  const csp = config.app.security.csp
  assert.match(csp, /default-src 'self'/)
  assert.match(csp, /object-src 'none'/)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/)
  assert.equal(config.app.security.dangerousDisableAssetCspModification, undefined)

  const cargo = readText('desktop/src-tauri/Cargo.toml')
  assert.match(cargo, /^name = "trellis-board-client"$/m)
  assert.match(cargo, /^version = "0\.2\.0"$/m)
  assert.doesNotMatch(cargo, /tauri.*features.*devtools/)
  assert.match(readText('desktop/src-tauri/src/config.rs'), /SCHEMA_VERSION: u32 = 2/)
})

test('NSIS 安装和卸载前清理客户端与残留 sidecar', () => {
  const hooks = readText('desktop/src-tauri/windows/hooks.nsh')
  assert.match(
    hooks,
    /!macro\s+NSIS_HOOK_PREINSTALL[\s\S]*?!insertmacro\s+TrellisStopRunningProcesses[\s\S]*?!macroend/,
  )
  assert.match(
    hooks,
    /!macro\s+NSIS_HOOK_PREUNINSTALL[\s\S]*?!insertmacro\s+TrellisStopRunningProcesses[\s\S]*?!macroend/,
  )
  assert.match(hooks, /taskkill\.exe" \/F \/T \/IM "trellis-board-client\.exe"/)
  assert.match(hooks, /taskkill\.exe" \/F \/T \/IM "trellis-agent\.exe"/)
})

test('capability 将本地登录与远程项目关联权限分开', () => {
  const capability = readJson('desktop/src-tauri/capabilities/main.json')
  assert.equal(capability.identifier, 'main')
  assert.deepEqual(capability.windows, ['main'])
  assert.equal(capability.remote, undefined)
  assert.equal(capability.platforms, undefined)
  const permissions = capability.permissions
  assert.deepEqual(permissions.slice().sort(), [
    'allow-app-status',
    'allow-desktop-login',
    'core:default',
  ])
  const remote = readJson('desktop/src-tauri/capabilities/board-local-association.json')
  assert.deepEqual(remote.permissions.slice().sort(), [
    'allow-associate-pending-project',
    'allow-cancel-pending-project',
    'allow-check-pending-project-push',
    'allow-desktop-sidecar-status',
    'allow-initialize-pending-project',
    'allow-inspect-local-project',
    'allow-list-local-associations',
    'allow-preflight-pending-project',
    'allow-sync-deferred-tasks',
  ])
  assert.deepEqual(remote.remote.urls, ['https://*:*', 'http://*:*'])
  assert.equal(new URLPattern(remote.remote.urls[0]).test('https://board.example.com:8443/'), true)
  assert.equal(new URLPattern(remote.remote.urls[1]).test('http://192.168.65.27:4317/'), true)
  assert.equal(new URLPattern('http://*').test('http://192.168.65.27:4317/'), false)
  const custom = readText('desktop/src-tauri/permissions/desktop.toml')
  assert.match(custom, /identifier = "allow-app-status"/)
  assert.match(custom, /commands\.allow = \["app_status"\]/)
  assert.match(custom, /identifier = "allow-desktop-login"/)
  assert.match(custom, /commands\.allow = \["desktop_login"\]/)
  assert.doesNotMatch(custom, /commands\.allow = \["associate_local_project"\]/)
  assert.match(custom, /commands\.allow = \["inspect_local_project"\]/)
  assert.match(custom, /commands\.allow = \["initialize_pending_project"\]/)
  assert.match(custom, /commands\.allow = \["check_pending_project_push"\]/)
  assert.match(custom, /commands\.allow = \["preflight_pending_project"\]/)
  assert.match(custom, /commands\.allow = \["cancel_pending_project"\]/)
  assert.match(custom, /commands\.allow = \["associate_pending_project"\]/)
  assert.match(custom, /commands\.allow = \["list_local_associations"\]/)
  assert.match(custom, /commands\.allow = \["sync_deferred_tasks"\]/)
  assert.match(custom, /commands\.allow = \["desktop_sidecar_status"\]/)
  assert.match(custom, /commands\.allow = \["live_control_pending"\]/)
  assert.match(custom, /commands\.allow = \["live_control_decide"\]/)
  assert.match(custom, /commands\.allow = \["live_control_diff"\]/)
  assert.match(custom, /commands\.allow = \["live_control_initial"\]/)
  assert.match(custom, /commands\.allow = \["live_control_restore"\]/)
  assert.match(custom, /commands\.allow = \["live_control_dismiss"\]/)
  assert.equal((custom.match(/\[\[permission\]\]/g) || []).length, 17)
  const control = readJson('desktop/src-tauri/capabilities/live-control.json')
  assert.deepEqual(control.windows, ['live-control'])
  assert.deepEqual(control.permissions.slice().sort(), [
    'allow-live-control-decide',
    'allow-live-control-diff',
    'allow-live-control-dismiss',
    'allow-live-control-get',
    'allow-live-control-initial',
    'allow-live-control-restore',
    'core:default',
  ])
})

test('首次推送检查支持定时、窗口聚焦和手动触发', () => {
  const source = readText('web/src/features/board/dialogs/ProjectOnboardingDialog.tsx')
  assert.match(source, /check_pending_project_push/)
  assert.match(source, /window\.setInterval\(\(\) => \{\s*void checkPush\(\{ silent: true \}\)/)
  assert.match(source, /window\.addEventListener\('focus', onFocus\)/)
  assert.match(source, /push\?\.state === 'ready'/)
  assert.match(source, /onClick=\{\(\) => void checkPush\(\)\}/)
  assert.match(source, /preflight_pending_project/)
  assert.match(source, /cancel_pending_project/)
  assert.match(source, /仅同步无冲突项/)
  assert.match(source, /查看并处理差异/)
  assert.match(source, /initialMode/)
  const rail = readText('web/src/components/layout/ProjectRail.tsx')
  assert.doesNotMatch(rail, /associate_local_project/)
  assert.match(rail, /startProjectOnboarding/)
})

test('导航、新窗口、托盘与日志边界在 Rust 源中显式实现', () => {
  const navigation = readText('desktop/src-tauri/src/navigation.rs')
  assert.match(navigation, /pub fn validate_board_url/)
  assert.match(navigation, /"http" \| "https" => Ok\(url\)/)
  assert.match(navigation, /pub fn same_origin/)
  assert.match(navigation, /app\.shell\(\)\.open/)
  assert.match(navigation, /pub fn handle_navigation/)

  const main = readText('desktop/src-tauri/src/main.rs')
  assert.match(main, /NewWindowResponse::Deny/)
  assert.match(main, /\.on_navigation\(/)
  assert.match(main, /tauri_plugin_single_instance::init/)
  assert.match(main, /WindowEvent::CloseRequested/)
  assert.match(main, /window\.hide\(\)/)
  assert.match(main, /处理实时确认/)
  assert.match(main, /sidecar::show_pending_control\(app\)/)
  assert.match(main, /恢复同步/)
  assert.match(main, /sidecar::set_sync_menu_item/)
  assert.match(main, /sidecar::handle_sync_action/)
  assert.match(main, /window\.label\(\) == "live-control"/)
  assert.match(main, /sidecar::close_control_window/)
  assert.match(main, /"quit" =>/)
  assert.match(main, /"autostart" =>/)
  assert.match(
    main,
    /generate_handler!\[\s*app_status,[\s\S]*?desktop_login,[\s\S]*?preflight_pending_project,[\s\S]*?cancel_pending_project,[\s\S]*?associate_pending_project,[\s\S]*?list_local_associations,[\s\S]*?sync_deferred_tasks,[\s\S]*?desktop_sidecar_status,[\s\S]*?live_control_pending,[\s\S]*?live_control_decide,[\s\S]*?live_control_restore,[\s\S]*?live_control_dismiss\s*\]/,
  )
  assert.match(main, /fn ensure_local_caller\(window: &WebviewWindow\)/)
  assert.match(main, /ensure_board_caller/)
  assert.match(main, /该命令仅允许本地登录页调用/)
  assert.doesNotMatch(main, /open_devtools|devtools:\s*true/)
  assert.doesNotMatch(main, /trellisboard|workspace_init|pick_workspace/)
  assert.match(main, /async fn live_control_pending/)
  assert.match(main, /async fn live_control_decide/)
  assert.match(main, /async fn live_control_restore/)
  assert.match(main, /async fn live_control_dismiss/)
  assert.doesNotMatch(main, /async fn associate_local_project/)
  assert.match(main, /async fn preflight_pending_project/)
  assert.match(main, /async fn cancel_pending_project/)

  const sidecar = readText('desktop/src-tauri/src/sidecar.rs')
  assert.match(sidecar, /pending_control: Mutex<VecDeque<Value>>/)
  assert.match(sidecar, /auto_focus_consumed: AtomicBool/)
  assert.match(sidecar, /focus_suppressed: AtomicBool/)
  assert.match(sidecar, /fn control_key\(control: &Value\)/)
  assert.match(sidecar, /pub fn show_pending_control/)
  assert.match(sidecar, /pub fn suppress_and_hide_control/)
  assert.match(sidecar, /WebviewUrl::App\("control\.html"\.into\(\)\)/)
  assert.match(sidecar, /pub live_sync_status: String/)
  assert.match(sidecar, /pub live_sync_error: Option<String>/)
  assert.match(sidecar, /expiresAtEpochMs/)
  assert.match(sidecar, /pending-live/)
  assert.match(sidecar, /"live-decide"/)
  assert.match(sidecar, /"live-sync-deferred"/)
  assert.match(sidecar, /"live-restore"/)
  assert.match(sidecar, /"preflight-project"/)
  assert.match(sidecar, /MessageDialogButtons::OkCustom/)
  assert.match(sidecar, /强制重启同步/)
  assert.match(sidecar, /taskkill/)
  assert.match(sidecar, /agent\.lock\.force-restart-/)
  assert.match(sidecar, /handle\.restart\(\)/)
  const control = readText('desktop/ui/control.js')
  assert.match(control, /live_control_dismiss/)
  assert.match(control, /正在提交，请稍候/)
  assert.match(control, /个任务.*个文件/)
  assert.match(control, /文件版本 r/)
  assert.match(control, /仅换行差异/)
  assert.doesNotMatch(control, /button\('暂不接入'/)
  assert.match(control, /仅在远端版本不正确时使用一键复原/)
  assert.match(control, /event\.conflicts\?\.length/)
  assert.match(control, /稍后处理/)
  assert.match(control, /dataset\.alwaysEnabled/)
  assert.match(
    control,
    /if \(!current\) return[\s\S]*?if \(action === 'close'\)[\s\S]*?if \(busy\) return/,
  )
  assert.equal(fs.existsSync(path.join(ROOT, 'desktop/ui/control.html')), true)
  assert.equal(fs.existsSync(path.join(ROOT, 'desktop/ui/control.css')), true)
  assert.equal(fs.existsSync(path.join(ROOT, 'desktop/ui/control.js')), true)

  const logging = readText('desktop/src-tauri/src/logging.rs')
  assert.match(logging, /pub fn redact/)
  assert.match(logging, /"\\"credential\\""/)
  assert.match(logging, /"\\"pairingCode\\""/)
  assert.match(logging, /"\\"sessionToken\\""/)
})

test('Windows PowerShell 脚本以 UTF-8 BOM 保存', () => {
  for (const relative of [
    'desktop/install.ps1',
    'desktop/uninstall.ps1',
    'desktop/package-portable.ps1',
  ]) {
    const bytes = fs.readFileSync(path.join(ROOT, relative))
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], relative)
  }
})

test('绿色打包脚本无参数调用时从 desktop 目录解析默认路径', () => {
  const script = readText('desktop/package-portable.ps1')
  assert.match(script, /^\$desktopRoot = \$PSScriptRoot$/m)
  assert.match(script, /Join-Path \$desktopRoot 'src-tauri\\target\\release'/)
})

test('install.ps1 默认按用户安装、校验 SHA256 并可回滚', () => {
  const script = readText('desktop/install.ps1')
  assert.match(script, /Join-Path \$env:LOCALAPPDATA 'TrellisBoard'/)
  assert.match(script, /Get-FileHash -LiteralPath \$Source -Algorithm SHA256/)
  assert.match(script, /SHA256SUMS\.txt/)
  assert.match(script, /WScript\.Shell/)
  assert.match(script, /'Microsoft\\Windows\\Start Menu\\Programs'/)
  assert.match(script, /GetFolderPath\('Desktop'\)/)
  assert.match(script, /HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run/)
  assert.match(script, /--minimized/)
  assert.match(script, /Move-Item -LiteralPath \$stagedExe -Destination \$targetExe/)
  assert.match(script, /trellis-agent\.exe/)
  assert.match(script, /Move-Item -LiteralPath \$stagedSidecar -Destination \$targetSidecar/)
  assert.match(script, /Copy-Item -LiteralPath \$backupExe -Destination \$targetExe/)
  assert.match(script, /exit \$script:FailureCode/)
  assert.match(script, /\$script:FailureCode = 0/)
  assert.match(script, /Fail 2 "缺少 SHA256SUMS\.txt/)
  assert.match(script, /安装失败并已回滚/)
  assert.match(script, /\$script:FailureCode = if \(\$stage -eq 'shortcuts'\) \{ 4 \} else \{ 3 \}/)
  assert.doesNotMatch(script, /-Verb\s+RunAs/)
  assert.doesNotMatch(
    script,
    /Remove-Item[^\n]*-Recurse[^\n]*([A-Za-z]:\\|SystemDrive|USERPROFILE)/i,
  )
})

test('uninstall.ps1 拒绝受保护目录并复用现有撤销流程', () => {
  const script = readText('desktop/uninstall.ps1')
  assert.match(script, /GetPathRoot/)
  assert.match(script, /LOCALAPPDATA/)
  assert.match(script, /USERPROFILE/)
  assert.match(script, /SystemRoot/)
  assert.match(script, /拒绝卸载到受保护目录/)
  assert.match(script, /-RevokeDevice/)
  assert.match(script, /& \$agentExe revoke --server \$ServerUrl --agent \$AgentId/)
  assert.match(script, /-PurgeData/)
  assert.match(script, /Remove-ItemProperty -Path \$RunKey -Name \$RunValueName/)
  assert.match(script, /\$targetSidecar/)
  assert.match(script, /Fail 6 "设备撤销失败/)
  assert.match(script, /exit \$script:FailureCode/)
  assert.match(script, /\$script:FailureCode = 0/)
  assert.doesNotMatch(script, /Remove-Item[^\n]*-Recurse[^\n]*([A-Za-z]:\\|SystemDrive)/i)
})

test('sidecar 构建脚本引用的入口文件都存在且使用 Node SEA', () => {
  const script = readText('desktop/sidecar/build-sidecar.ps1')
  for (const relative of [
    'desktop/sidecar/cli.js',
    'desktop/sidecar/sea-entry.js',
    'desktop/sidecar/main.js',
    'desktop/sidecar/desktop-device.js',
    'desktop/sidecar/desktop-association.js',
    'desktop/sidecar/parent-watchdog.js',
    'desktop/sidecar/trellis-runtime.js',
    'desktop/sidecar/trellis-pi-repair.mjs',
    'desktop/sidecar/bundle.mjs',
    'agent/index.js',
    'agent/api.js',
    'agent/credential-store.js',
    'agent/windows/dpapi.ps1',
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, relative)), `缺少 ${relative}`)
  }
  assert.match(script, /process\.versions\.node/)
  assert.match(script, /Node 24/)
  assert.match(script, /--experimental-sea-config/)
  assert.match(script, /NODE_SEA_BLOB/)
  assert.match(script, /NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2/)
  assert.match(script, /postject/)
  assert.match(script, /SHA256SUMS\.txt/)
  assert.match(script, /trellis-agent-\$target\.exe|trellis-agent-x86_64-pc-windows-msvc\.exe/)
  assert.match(script, /trellis-runtime/)
  assert.match(
    script,
    /Copy-Item -LiteralPath \(Join-Path \$sidecarRoot 'trellis-pi-repair\.mjs'\)/,
  )
  assert.match(script, /Bundled Pi repair script was not staged/)
  assert.match(script, /@mindfoldhq\\trellis\\bin\\trellis\.js/)
  assert.match(script, /trellisVersion=\$trellisVersion/)

  const seaEntry = readText('desktop/sidecar/sea-entry.js')
  assert.doesNotMatch(seaEntry, /import\.meta|fileURLToPath/)
  const bundle = readText('desktop/sidecar/bundle.mjs')
  assert.doesNotMatch(bundle, /BUNDLE_MODULE_URL|trellis-sidecar\/trellis-agent-bundle/)
  assert.match(bundle, /sea-entry\.js/)

  const config = createSeaConfig({
    bundleFile: path.join(DESKTOP, 'dist', 'trellis-agent.cjs'),
    blobFile: path.join(DESKTOP, 'dist', 'sea-prep.blob'),
    dpapiScript: path.join(ROOT, 'agent', 'windows', 'dpapi.ps1'),
  })
  assert.equal(config.output, path.join(DESKTOP, 'dist', 'sea-prep.blob'))
  assert.equal(config.disableExperimentalSEAWarning, true)
  assert.equal(config.useCodeCache, true)
  assert.deepEqual(Object.keys(config.assets), ['dpapi.ps1'])
})

test('sidecar CLI 报告协议 v3，未注册时以配置错误退出', () => {
  const version = spawnSync(process.execPath, ['desktop/sidecar/cli.js', 'version'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  assert.equal(version.status, 0, version.stderr)
  const payload = JSON.parse(version.stdout.trim())
  assert.equal(payload.ok, true)
  assert.equal(payload.protocolVersion, 3)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-sidecar-status-'))
  const status = spawnSync(process.execPath, ['desktop/sidecar/cli.js', 'status', '--root', root], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  assert.equal(status.status, 3)
  assert.match(status.stderr, /尚未注册|未注册|配置/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('sidecar live 命令统一接受 --task-space 参数', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-sidecar-live-args-'))
  const env = { ...process.env, TRELLIS_AGENT_ROOT: root }
  const commands = [
    [
      'live-decide',
      '--task-space',
      'space-1',
      '--conflict',
      'conflict-1',
      '--action',
      'use-server',
    ],
    ['live-diff', '--task-space', 'space-1', '--conflict', 'conflict-1'],
    ['live-initial', '--task-space', 'space-1', '--mode', 'safe'],
    ['live-sync-deferred', '--task-space', 'space-1'],
  ]
  try {
    for (const args of commands) {
      const result = spawnSync(process.execPath, ['desktop/sidecar/cli.js', ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        env,
      })
      assert.equal(result.status, 3, `${args[0]}: ${result.stderr}`)
      const payload = JSON.parse(result.stdout.trim())
      assert.equal(payload.code, 'CONFIG_MISSING', `${args[0]}: ${result.stdout}`)
      assert.doesNotMatch(result.stderr + result.stdout, /未知参数 --task-space/)
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Trellis runtime 从 sidecar 可执行文件同目录解析', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-runtime-resolve-'))
  try {
    const runtimeRoot = path.join(root, 'trellis-runtime')
    const cliFile = path.join(
      runtimeRoot,
      'node_modules',
      '@mindfoldhq',
      'trellis',
      'bin',
      'trellis.js',
    )
    fs.mkdirSync(path.dirname(cliFile), { recursive: true })
    fs.writeFileSync(path.join(runtimeRoot, 'node.exe'), '')
    fs.writeFileSync(cliFile, '')
    const resolved = await resolveTrellisRuntime({
      executablePath: path.join(root, 'trellis-agent.exe'),
    })
    assert.equal(resolved.root, runtimeRoot)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('sidecar CLI 使用应用内置 Trellis runtime 初始化项目', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-sidecar-runtime-'))
  const appRoot = path.join(root, 'app')
  const runtimeRoot = path.join(appRoot, 'trellis-runtime')
  const cliFile = path.join(
    runtimeRoot,
    'node_modules',
    '@mindfoldhq',
    'trellis',
    'bin',
    'trellis.js',
  )
  const agentRoot = path.join(root, 'agent')
  const remote = path.join(root, 'remote.git')
  const repo = path.join(root, 'repo')
  try {
    fs.mkdirSync(path.dirname(cliFile), { recursive: true })
    fs.mkdirSync(agentRoot, { recursive: true })
    const bundledNode = path.join(runtimeRoot, 'node.exe')
    try {
      fs.linkSync(process.execPath, bundledNode)
    } catch {
      fs.copyFileSync(process.execPath, bundledNode)
    }
    fs.writeFileSync(
      cliFile,
      [
        "const fs = require('node:fs')",
        "const path = require('node:path')",
        "fs.mkdirSync(path.join(process.cwd(), '.trellis', 'tasks'), { recursive: true })",
        "fs.mkdirSync(path.join(process.cwd(), '.codex'), { recursive: true })",
        "fs.writeFileSync(path.join(process.cwd(), '.trellis', 'tasks', '.keep'), '')",
        "fs.writeFileSync(path.join(process.cwd(), '.codex', '.keep'), '')",
      ].join('\n'),
    )
    fs.writeFileSync(
      path.join(agentRoot, 'config.json'),
      `${JSON.stringify(
        {
          schemaVersion: 2,
          revision: '0'.repeat(31) + '1',
          serverUrl: PUBLIC_ORIGIN,
          caFile: null,
          allowLocalGitRemotes: true,
          agentId: 'sidecar-runtime-test',
          deviceName: 'Sidecar Runtime Test',
          username: null,
          teamId: null,
          teams: [],
          protocolVersion: 3,
          agentVersion: '0.2.0',
          pairedAt: null,
          bindings: [],
        },
        null,
        2,
      )}\n`,
    )
    spawnSync('git', ['init', '--bare', '--initial-branch=main', remote], { encoding: 'utf8' })
    fs.mkdirSync(repo)
    spawnSync('git', ['init', '-b', 'main'], { cwd: repo, encoding: 'utf8' })
    spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: repo, encoding: 'utf8' })

    const result = spawnSync(
      process.execPath,
      [
        path.join(ROOT, 'desktop', 'sidecar', 'cli.js'),
        'initialize-project',
        '--path',
        repo,
        '--developer',
        'yhj',
        '--tools',
        'codex',
      ],
      {
        cwd: appRoot,
        encoding: 'utf8',
        env: { ...process.env, TRELLIS_AGENT_ROOT: agentRoot },
      },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout.trim()).ok, true)
    assert.equal(fs.existsSync(path.join(repo, '.trellis', 'tasks')), true)
    assert.equal(fs.existsSync(path.join(repo, '.codex')), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('桌面设备注册复用 pairing-codes + agent/enroll，凭证不落明文', async (t) => {
  const { runtime, adminCookie, serverUrl, teamId } = await startRuntime(t)
  const pairing = await request(runtime, '/api/team/pairing-codes', {
    method: 'POST',
    cookie: adminCookie,
    body: {},
  })
  assert.equal(pairing.status, 201)
  assert.equal(pairing.body.protocolVersion, 3)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-desktop-enroll-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const saved = []
  const credentialStore = {
    async saveCredential(credential) {
      saved.push(credential)
    },
  }

  const result = await enrollDesktopDevice({
    serverUrl,
    pairingCode: pairing.body.pairingCode,
    deviceName: 'Windows 桌面',
    root,
    credentialStore,
    secureDirectory: false,
  })
  assert.equal(result.protocolVersion, 3)
  assert.match(result.agentId, /^[A-Za-z0-9-]{8,64}$/)
  assert.equal(saved.length, 1)
  assert.match(saved[0], /^[A-Za-z0-9_-]{43,128}$/)

  const configText = fs.readFileSync(path.join(root, 'config.json'), 'utf8')
  const config = JSON.parse(configText)
  assert.equal(config.serverUrl, serverUrl)
  assert.equal(config.agentId, result.agentId)
  assert.equal(config.username, 'sysadmin')
  assert.equal(config.teamId, null)
  assert.deepEqual(
    config.teams.map((team) => team.id),
    [teamId],
  )
  assert.equal(config.protocolVersion, 3)
  assert.equal(config.credential, undefined)
  assert.ok(!configText.includes(saved[0]), '设备凭证不得写入 config.json')
  assert.ok(!configText.includes(pairing.body.pairingCode), '配对码不得落盘')
  assert.ok(!fs.existsSync(path.join(root, 'credential.dpapi')), '注入的凭证存储应被使用')

  const identity = await readAgentIdentity(root)
  assert.deepEqual(identity, { agentId: result.agentId, serverUrl })

  await assert.rejects(
    enrollDesktopDevice({
      serverUrl,
      pairingCode: pairing.body.pairingCode,
      deviceName: '重放设备',
      root,
      credentialStore,
      secureDirectory: false,
    }),
    (error) => /已经注册|一次性|无效|过期|失败/.test(error.message),
  )
})

test('卸载撤销复用 /api/admin/agents/{id}/revoke 并标记设备', async (t) => {
  const { runtime, adminCookie, serverUrl } = await startRuntime(t)
  const pairing = await request(runtime, '/api/team/pairing-codes', {
    method: 'POST',
    cookie: adminCookie,
    body: {},
  })
  assert.equal(pairing.status, 201)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-desktop-revoke-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const enrolled = await enrollDesktopDevice({
    serverUrl,
    pairingCode: pairing.body.pairingCode,
    deviceName: '待撤销设备',
    root,
    credentialStore: { async saveCredential() {} },
  })

  const token = adminCookie.split('=')[1]
  const revoked = await revokeDesktopDevice({
    serverUrl,
    agentId: enrolled.agentId,
    sessionCookie: token,
  })
  assert.equal(revoked.revoked, true)
  assert.equal(revoked.agentId, enrolled.agentId)
  const row = runtime.db
    .prepare('SELECT status FROM agent_device WHERE id = ?')
    .get(enrolled.agentId)
  assert.equal(row.status, 'revoked')

  await assert.rejects(
    revokeDesktopDevice({
      serverUrl,
      agentId: enrolled.agentId,
      sessionCookie: 'short',
    }),
    (error) => /格式无效/.test(error.message),
  )
})

test('设备名校验拒绝空值、超长与控制字符', () => {
  assert.equal(validateDeviceName(' Windows 桌面 '), 'Windows 桌面')
  assert.throws(() => validateDeviceName(''), /设备名/)
  assert.throws(() => validateDeviceName('a'.repeat(81)), /设备名/)
  assert.throws(() => validateDeviceName('bad\u0007name'), /设备名/)
})
