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
    gitPollMs: 60_000,
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
  assert.equal(config.bundle.windows.webviewInstallMode.type, 'downloadBootstrapper')
  assert.equal(config.bundle.windows.webviewInstallMode.silent, true)
  assert.deepEqual(config.bundle.externalBin, ['binaries/trellis-agent'])
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
    'allow-associate-local-project',
    'allow-desktop-sidecar-status',
    'allow-list-local-associations',
  ])
  assert.ok(remote.remote.urls.includes('https://*'))
  assert.ok(remote.remote.urls.includes('http://127.0.0.1:*'))
  const custom = readText('desktop/src-tauri/permissions/desktop.toml')
  assert.match(custom, /identifier = "allow-app-status"/)
  assert.match(custom, /commands\.allow = \["app_status"\]/)
  assert.match(custom, /identifier = "allow-desktop-login"/)
  assert.match(custom, /commands\.allow = \["desktop_login"\]/)
  assert.match(custom, /commands\.allow = \["associate_local_project"\]/)
  assert.match(custom, /commands\.allow = \["list_local_associations"\]/)
  assert.match(custom, /commands\.allow = \["desktop_sidecar_status"\]/)
  assert.match(custom, /commands\.allow = \["live_control_pending"\]/)
  assert.match(custom, /commands\.allow = \["live_control_decide"\]/)
  assert.match(custom, /commands\.allow = \["live_control_restore"\]/)
  assert.match(custom, /commands\.allow = \["live_control_dismiss"\]/)
  assert.equal((custom.match(/\[\[permission\]\]/g) || []).length, 9)
  const control = readJson('desktop/src-tauri/capabilities/live-control.json')
  assert.deepEqual(control.windows, ['live-control'])
  assert.deepEqual(control.permissions.slice().sort(), [
    'allow-live-control-decide',
    'allow-live-control-dismiss',
    'allow-live-control-get',
    'allow-live-control-restore',
    'core:default',
  ])
})

test('导航、新窗口、托盘与日志边界在 Rust 源中显式实现', () => {
  const navigation = readText('desktop/src-tauri/src/navigation.rs')
  assert.match(navigation, /pub fn validate_board_url/)
  assert.match(navigation, /"https" => Ok\(url\)/)
  assert.match(navigation, /"http" if is_loopback_host\(url\.host_str\(\)\)/)
  assert.match(navigation, /pub fn same_origin/)
  assert.match(navigation, /app\.shell\(\)\.open/)
  assert.match(navigation, /pub fn handle_navigation/)

  const main = readText('desktop/src-tauri/src/main.rs')
  assert.match(main, /NewWindowResponse::Deny/)
  assert.match(main, /\.on_navigation\(/)
  assert.match(main, /tauri_plugin_single_instance::init/)
  assert.match(main, /WindowEvent::CloseRequested/)
  assert.match(main, /window\.hide\(\)/)
  assert.match(main, /"quit" =>/)
  assert.match(main, /"autostart" =>/)
  assert.match(
    main,
    /generate_handler!\[\s*app_status,[\s\S]*?desktop_login,[\s\S]*?associate_local_project,[\s\S]*?list_local_associations,[\s\S]*?desktop_sidecar_status,[\s\S]*?live_control_pending,[\s\S]*?live_control_decide,[\s\S]*?live_control_restore,[\s\S]*?live_control_dismiss\s*\]/,
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
  assert.match(
    main,
    /async fn associate_local_project[\s\S]*?sidecar::restart\(&app\);\s*Ok\(Some\(association\)\)/,
  )

  const sidecar = readText('desktop/src-tauri/src/sidecar.rs')
  assert.match(sidecar, /pending_control: Mutex<VecDeque<Value>>/)
  assert.match(sidecar, /WebviewUrl::App\("control\.html"\.into\(\)\)/)
  assert.match(sidecar, /pub live_sync_status: String/)
  assert.match(sidecar, /pub live_sync_error: Option<String>/)
  assert.match(sidecar, /expiresAtEpochMs/)
  assert.match(sidecar, /pending-live/)
  assert.match(sidecar, /"live-decide"/)
  assert.match(sidecar, /"live-restore"/)
  const control = readText('desktop/ui/control.js')
  assert.match(control, /live_control_dismiss/)
  assert.match(control, /正在提交，请稍候/)
  assert.equal(fs.existsSync(path.join(ROOT, 'desktop/ui/control.html')), true)
  assert.equal(fs.existsSync(path.join(ROOT, 'desktop/ui/control.css')), true)
  assert.equal(fs.existsSync(path.join(ROOT, 'desktop/ui/control.js')), true)

  const logging = readText('desktop/src-tauri/src/logging.rs')
  assert.match(logging, /pub fn redact/)
  assert.match(logging, /"\\"credential\\""/)
  assert.match(logging, /"\\"pairingCode\\""/)
  assert.match(logging, /"\\"sessionToken\\""/)
})

test('安装脚本以 UTF-8 BOM 保存以兼容 Windows PowerShell 5.1', () => {
  for (const relative of ['desktop/install.ps1', 'desktop/uninstall.ps1']) {
    const bytes = fs.readFileSync(path.join(ROOT, relative))
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], relative)
  }
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

test('sidecar CLI 报告协议 v2，未注册时以配置错误退出', () => {
  const version = spawnSync(process.execPath, ['desktop/sidecar/cli.js', 'version'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  assert.equal(version.status, 0, version.stderr)
  const payload = JSON.parse(version.stdout.trim())
  assert.equal(payload.ok, true)
  assert.equal(payload.protocolVersion, 2)

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-sidecar-status-'))
  const status = spawnSync(process.execPath, ['desktop/sidecar/cli.js', 'status', '--root', root], {
    cwd: ROOT,
    encoding: 'utf8',
  })
  assert.equal(status.status, 3)
  assert.match(status.stderr, /尚未注册|未注册|配置/)
  fs.rmSync(root, { recursive: true, force: true })
})

test('桌面设备注册复用 pairing-codes + agent/enroll，凭证不落明文', async (t) => {
  const { runtime, adminCookie, serverUrl, teamId } = await startRuntime(t)
  const pairing = await request(runtime, '/api/team/pairing-codes', {
    method: 'POST',
    cookie: adminCookie,
    body: {},
  })
  assert.equal(pairing.status, 201)
  assert.equal(pairing.body.protocolVersion, 2)

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
  assert.equal(result.protocolVersion, 2)
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
  assert.equal(config.protocolVersion, 2)
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
