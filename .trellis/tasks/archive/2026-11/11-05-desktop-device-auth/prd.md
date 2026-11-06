# 桌面设备登录会话换取凭证

## Goal

把桌面设备注册的主路径改为「已登录 Board 会话 → 一次性设备令牌 → 设备凭证」，与归档
`11-05-desktop-client-package` 的确认决策 #4 对齐；Agent 配对码只保留为管理员兜底，不再
是桌面端的默认入口。归档 `desktop/design.md:13` 中「不新增会话契约」的结论由本任务显式
取代。

## Requirements

### 服务端

- `POST /api/desktop/enroll-tokens`：必须携带已登录会话（`requireActor`），沿用
  `assertJsonWrite` 的 JSON/Origin 规则；`mustChangePassword` 用户仍被拒绝。
  - 请求可选 `{ deviceName }`，返回 `201 { token, expiresAt }`。
  - 令牌为 `crypto.randomBytes(32).toString("base64url")`，服务端只保存 SHA-256 哈希。
  - TTL 5 分钟、一次性、绑定 `userId`；同一用户未使用的令牌最多 5 个，超限 `429 RATE_LIMITED`。
  - 写审计 `desktop_enroll_token_issued`，审计不含令牌明文。
- `POST /api/agent/enroll-desktop`：无需会话/Origin，请求
  `{ token, deviceName, platform, agentVersion, protocolVersion }`。
  - 校验令牌存在、未过期、未使用；`protocolVersion` 走现有 `AGENT_PROTOCOL_VERSION`（2）。
  - 校验用户 `status='active'`；创建 `agent_device` 与设备凭证，复用配对码注册的同一设备创建路径。
  - 返回与 `/api/agent/enroll` 相同的 `{ agentId, credential, protocolVersion }`。
  - 无效/过期/已使用统一 `401 DESKTOP_TOKEN_INVALID`（message 区分原因），禁用用户 `403`。
  - 写审计 `desktop_device_enrolled`，含 `deviceId`、`userId`、来源标记，不含凭证。
- `/api/agent/enroll`（配对码）保留，作为管理员兜底，不删除、不改契约。

### 桌面端

- sidecar 新增 `enrollWithToken(token, deviceInfo)` 并作为默认路径；配对码路径只在显式
  `--pairing-code` 时启用。
- 错误映射区分令牌无效/过期、已使用、无网络。
- 登录接力：
  - 本地页提供「从浏览器完成登录」按钮与一次性令牌粘贴框；
  - Rust 解析 `trellisboard://enroll?token=...&server=...` 深链（含单实例二次启动 argv），
    转交 sidecar 或前端；
  - `src-tauri` 注册 `enroll_with_token` 命令，`capabilities/main.json` 只加最小本地权限，
    不加远程页面 IPC、不加 `shell:*`/`fs:*`/`http:*`。
- 设备凭证继续由 DPAPI 保存；`client.json` 只存服务端地址与 agentId，不存令牌/凭证。
- 首次注册成功后直接打开 Board；已注册时沿用原有自动跳转/托盘行为。

### 文档与测试

- `desktop/README.md` 写清主路径、配对码兜底、令牌 TTL/一次性/重启失效、Windows 未验证项。
- Node 内置测试覆盖服务端签发/兑换/过期/重放/禁用/上限/审计/heartbeat/设备列表，以及
  桌面端错误映射、兜底开关、capability/Rust/UI/安装脚本静态契约。
- 不引入新的第三方依赖，不做数据库 schema 变更，不改其他任务 PRD/task.json。

## Acceptance Criteria

- [x] 已登录用户能签发一次性设备令牌；未登录 401，跨源/非 JSON 被拒，待改密 403。
- [x] 令牌只能兑换一次；第二次、过期、伪造均 401 `DESKTOP_TOKEN_INVALID`，且不产生设备。
- [x] 兑换出的设备可通过协议 v2 心跳并出现在设备列表。
- [x] 禁用用户在兑换时 403；同用户未使用令牌超过 5 个返回 429。
- [x] 签发与兑换均有审计，且审计与 `client.json` 不含令牌/凭证明文。
- [x] 桌面端默认走 `enrollWithToken`，配对码仅在 `--pairing-code` 显式开启；错误信息可区分。
- [x] 本地页支持浏览器登录接力、深链预填与手动粘贴；capability 无远程/危险权限。
- [x] `node --test tests/desktop-device-auth.test.js`、`node --test tests/desktop-package.test.js`、
      `npm test`、`npm run build`、`git diff --check` 通过。
- [x] 工作树只包含本任务文件；提交后 `task.json` 保持 `in_progress`。

## Notes

- 单进程内存令牌存储：服务重启、进程切换或多实例部署会使未兑换令牌失效；这是本任务接受的
  取舍，换取不引入数据库 schema 变更。
- Windows/Rust 运行时行为无法在本机验证，只提供静态断言与构建机清单。
