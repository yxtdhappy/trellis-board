# 设计：桌面设备由登录会话换取凭证

## 1. 决策与边界

归档任务 `11-05-desktop-client-package` 的确认决策 #4 要求「由登录会话直接换取设备凭证；
不复用 Agent 配对码作为主路径」。归档 `design.md:13` 曾写明「不新增会话契约」，该结论在
本次验收中被驳回，本设计显式取代它：新增两个窄端点，一个用登录会话签发一次性令牌，一个
用令牌兑换设备凭证。配对码端点 `/api/agent/enroll` 保留为管理员兜底。

边界：

- 不新增数据库表/列；令牌只存在服务端进程内存（`Map`），服务启动时为空。
- 不改变 Agent 心跳、事件流、命令、撤销契约；兑换结果与配对码注册完全同形。
- 不把设备凭证或一次性令牌写进 `client.json`、URL、argv 或日志。
- 管理页新增登录接力面板，是为了让已登录用户能拿到令牌；没有它，决策 #4 无法闭环。

### 单进程语义（明确取舍）

- 令牌表是 `createDesktopAuthService()` 闭包内的 `Map`，只在当前 Node 进程有效。
- 服务重启、进程滚动、多实例/多副本部署都会丢失未兑换令牌（客户端得到 401，需要重新生成）。
- 不使用数据库的原因：避免 schema 迁移与清理任务；5 分钟 TTL + 最多 5 个/用户已足够窄。
- 若未来需要多实例，必须把哈希、过期时间、使用状态迁到共享存储，并保持相同端点契约。

## 2. 服务端

### 2.1 新模块 `server/team/desktop-auth.js`

导出：

- `DESKTOP_ENROLL_TOKEN_TTL_MS = 300_000`
- `MAX_PENDING_DESKTOP_ENROLL_TOKENS = 5`
- `createDesktopAuthService({ db, now = () => Date.now(), ttlMs, maxPending })`
  → `{ issue, verify, consume }`

令牌生成：`crypto.randomBytes(32).toString("base64url")`（43 字符）。服务端只保存
`sha256(token)`；记录 `{ id, userId, teamId, deviceName, expiresAtMs, usedAtMs }`。

- `issue(actor, { deviceName })`：
  - 先清理过期记录；统计该 `userId` 未使用且未过期的令牌，`>= maxPending` 抛
    `429 RATE_LIMITED`（`未使用的设备令牌过多，请等待过期后再试`）。
  - 写审计 `desktop_enroll_token_issued`：`targetType='desktop_enroll_token'`、
    `targetId=<uuid>`、detail 只含 `expiresAt`/`deviceName`，**不含令牌**。
  - 返回 `{ token, expiresAt }`（ISO 字符串）。
- `verify(token)`：
  - 格式/不存在/已使用/过期分别抛 `401 DESKTOP_TOKEN_INVALID`，message 分别为
    `无效…` / `已使用，请在 Board 重新生成` / `已过期…`，`details.reason` 为
    `invalid|used|expired`；所有失败对外统一错误码。
- `consume(token)`：标记 `usedAtMs` 并从 pending 集合移除；`verify` 与 `consume` 之间不得
  `await`，避免同一令牌并发兑换。

### 2.2 端点契约

| 端点 | 鉴权 | 请求 | 成功 | 失败 |
| --- | --- | --- | --- | --- |
| `POST /api/desktop/enroll-tokens` | 登录会话 + 同源 Origin + JSON | `{ deviceName? }` | `201 { token, expiresAt }` | `401 AUTH_REQUIRED`、`403 CSRF_REJECTED`、`403 PASSWORD_CHANGE_REQUIRED`、`429 RATE_LIMITED` |
| `POST /api/agent/enroll-desktop` | 无会话（令牌本身即凭证） | `{ token, deviceName, platform, agentVersion, protocolVersion }` | `201 { agentId, credential, protocolVersion: 2 }` | `401 DESKTOP_TOKEN_INVALID`、`403 FORBIDDEN`（禁用）、`400` 参数错误、`426` 协议不兼容 |
| `POST /api/agent/enroll` | 无会话（配对码） | 原契约不变 | 原契约不变 | 原契约不变 |

- `enroll-tokens` 走 `server/team/http.js` 的通用写请求链：`assertJsonWrite` →
  `requireActor` → `mustChangePassword` 门禁，因此 Origin/CSRF/密码门禁与其它管理写接口一致。
- `enroll-desktop` 与 `/api/agent/*` 同分支，不要求 Cookie；带 Cookie 也不会获得额外权限。
- 兑换时先用令牌里的 `deviceName`，为空才用请求体的 `deviceName`；这样用户在已登录页面
  命名的设备名不会被客户端默认值覆盖。

### 2.3 设备创建复用

`server/team/agents.js` 抽出：

- `validateEnrollment(input)`：protocolVersion/agentVersion/platform/deviceName 校验。
- `insertDevice({ userId, teamId, name, platform, version, action, detail })`：生成
  `agentId`/credential、插入 `agent_device`、写审计（detail 合并 `deviceId`、`userId`）。

`enroll`（配对码）与 `enrollDesktop`（令牌）都调用 `insertDevice`，不复制凭证生成逻辑。
`enrollDesktop` 额外检查 `user_account.status === 'active'`，审计 action 为
`desktop_device_enrolled`，detail 含 `source: 'desktop_enroll_token'`。

`createTeamRuntime` 新增 `desktopAuth` 选项（`now`/`ttlMs`/`maxPending`），测试可注入时钟与
TTL；默认生产行为 5 分钟 / 5 个。

## 3. 桌面端

### 3.1 sidecar

`desktop/sidecar/desktop-device.js`：

- `validateEnrollToken(value)`：`/^[A-Za-z0-9_-]{32,512}$/`。
- `mapEnrollError(error)`：`DESKTOP_TOKEN_INVALID` 原样透传服务端 message；
  `NETWORK_ERROR` → `无法连接 Board 服务端，请检查网络后重试`。
- `completeDesktopEnrollment(...)`：校验协议版本 → 先写 DPAPI 凭证 → 再写 `config.json`；
  失败不会留下「有配置、没凭证」的半注册状态。
- `enrollWithToken(token, { serverUrl, deviceName, root, credentialStore })`：默认注册路径。
- `enrollDesktopDevice(pairingCode, ...)`：保留的配对码兜底路径，共用完成逻辑。

`desktop/sidecar/main.js`：`enroll` 子命令默认调用 `enrollWithToken`；仅当显式
`--pairing-code` 时调用 `enrollDesktopDevice`。secret 仍从 stdin 读取，不进 argv。

### 3.2 登录接力与深链

```text
Board 管理页「桌面客户端登录接力」
  → POST /api/desktop/enroll-tokens（会话 + CSRF）
  → 显示 trellisboard://enroll?token=<一次性>&server=<origin>
  → 系统打开桌面客户端（已运行则单实例转发 argv）
  → Rust parse_enroll_link → emit "enroll-token" 预填本地页
  → 用户确认设备名 → invoke enroll_with_token
  → Rust 校验本地页面来源 → sidecar enroll（stdin 传令牌）
  → POST /api/agent/enroll-desktop → DPAPI 保存凭证 → client.json 保存地址/agentId
  → 打开 Board
```

- `desktop/src-tauri/src/navigation.rs`：`EnrollLink { token, server_url }`、
  `parse_enroll_link`（scheme `trellisboard`、host `enroll`、查询 `token`/`server`；
  server 复用 `validate_board_url`）。
- `desktop/src-tauri/src/main.rs`：`handle_enroll_links` 处理启动参数与单实例 argv；
  `enroll_with_token`/`enroll_device`/`open_board_login`/`app_status` 四个命令。
  `open_board_login` 用系统浏览器打开 Board，不加载远程页面到 webview。
- 手动粘贴令牌作为深链未注册/浏览器无法唤起时的兜底。
- 设备名默认 `<COMPUTERNAME>`，否则「Windows 桌面」。

### 3.3 权限与安全

`desktop/src-tauri/capabilities/main.json`：窗口 `main`，权限仅
`core:default` + 四个本地命令；`remote` 不声明，因此远程 Board 页面没有 IPC。
`permissions/desktop.toml` 四个 `[[permission]]`。不新增 `shell:*`、`fs:*`、`http:*`。

- 一次性令牌只存在于内存/剪贴板/深链，兑换后服务端标记已用；客户端不持久化。
- 桌面日志 `logging::redact` 增加 `"token"` 字段脱敏。
- `install.ps1` 在 HKCU 注册 `trellisboard` URL Protocol；卸载时删除。NSIS 安装路径不注册，
  需在 Windows 构建机验证/补注册。

## 4. Web 管理页

`web/src/api/admin.ts` 新增 `createDesktopEnrollToken()`；`useAdminConsole` 暴露
`desktopToken` 与生成动作；`DevicesTab.tsx` 增加「桌面客户端登录接力」面板：生成、复制、
深链。它只调用新端点，不改变现有配对码面板。

## 5. 测试

`tests/desktop-device-auth.test.js`（真实 team runtime + 注入时钟）：

1. 未登录 401；无 Origin/跨源 403；登录后 201 且只返回 token/expiresAt。
2. 兑换 201；`agent_device` 行、DPAPI 前置保存、`config.json` 无凭证/令牌；审计含
   deviceId/userId/source 且无明文；heartbeat 200；设备列表可见；重放 401。
3. 注入时钟过期 401，且不创建设备。
4. 伪造令牌 401；禁用用户 403；`mustChangePassword` 签发 403。
5. 5 个未使用令牌后 429；兑换一个后释放额度；6 条签发审计均无明文。
6. 桌面 `enrollWithToken` 成功、重放映射、离线 `NETWORK_ERROR`、格式校验、CLI 兜底开关。
7. capability/Cargo/Rust/UI/安装脚本静态断言。

`tests/desktop-package.test.js` 同步新的权限列表与命令清单。

## 6. 未验证项（Linux 环境）

- 无 `cargo`/`rustc`/`pwsh`：Rust 编译、深链注册与单实例转发、Tauri 运行时、DPAPI、
  `install.ps1`/`uninstall.ps1` 均未实际执行。
- 未在 Windows 上验证 `trellisboard://` 唤起、NSIS 安装后的协议注册、SmartScreen。
- Node 测试只能证明 HTTP 契约与 sidecar JS 行为；Windows 专属行为只列构建机清单。
