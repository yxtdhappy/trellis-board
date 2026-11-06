# 实施计划：桌面设备登录会话换取凭证

范围以 `prd.md`、`design.md` 为准。基线 `38200e8`，分支
`codex/11-05-desktop-device-auth`。

## 0. 前置确认

- [x] 归档决策 #4 与 `desktop/design.md:13` 冲突：本任务以决策 #4 为准，新增窄端点。
- [x] 现有设备创建在 `server/team/agents.js:enroll`，凭证/DPAPI 在 `agent/` 与
      `desktop/sidecar/desktop-device.js`；本次只抽公共函数，不复制。
- [x] 现有写请求门禁 `assertJsonWrite`/`requireActor`/mustChangePassword 在
      `server/team/http.js` 统一生效。
- [x] 本机无 `cargo`/`rustc`/`pwsh`，Windows 运行时行为只做静态断言并列为未验证。

## 1. 服务端

- [x] 新增 `server/team/desktop-auth.js`：令牌生成/哈希、5 分钟 TTL、一次性、每用户 5 个上限、
      签发审计、`verify` 原因区分、`consume`。
- [x] `server/team/errors.js`：新增 `DESKTOP_TOKEN_INVALID`。
- [x] `server/team/agents.js`：抽 `validateEnrollment`、`insertDevice`；`enroll` 改为事务内
      消费配对码 + `insertDevice`；新增 `enrollDesktop`（active 校验 + `desktop_device_enrolled`
      审计 + source 标记）。
- [x] `server/team/http.js`：`POST /api/desktop/enroll-tokens`（会话 + CSRF）与
      `POST /api/agent/enroll-desktop`（无会话，令牌兑换）；`createTeamRuntime` 支持注入
      `desktopAuth` 时钟/TTL。
- [x] 保留 `/api/agent/enroll` 配对码路径。

## 2. 桌面端

- [x] `agent/protocol.js`/`agent/api.js`：错误码、错误映射、`enrollWithToken` 客户端。
- [x] `desktop/sidecar/desktop-device.js`：令牌校验、错误映射、完成注册抽公共函数、
      `enrollWithToken` 默认路径、配对码路径保留。
- [x] `desktop/sidecar/main.js`：默认令牌注册；显式 `--pairing-code` 才走配对码；secret 走 stdin。
- [x] `desktop/src-tauri/src/navigation.rs`：深链解析与令牌格式校验。
- [x] `desktop/src-tauri/src/main.rs`：`enroll_with_token`、`open_board_login`、单实例 argv
      深链处理、本地页面来源校验、注册后启动 sidecar。
- [x] `desktop/src-tauri/src/sidecar.rs`：`enroll` 支持令牌/配对码两种 secret 与参数。
- [x] `capabilities/main.json` + `permissions/desktop.toml`：四个最小本地命令，无 remote。
- [x] `desktop/ui/*`：令牌粘贴、浏览器登录按钮、深链预填、配对码折叠兜底；无 localStorage。
- [x] `desktop/src-tauri/src/logging.rs`：脱敏 `"token"`。

## 3. Web 管理页

- [x] `createDesktopEnrollToken()` + `useAdminConsole` 状态 + `DevicesTab` 登录接力面板
      （生成/复制/深链），不修改配对码端点。

## 4. 安装与文档

- [x] `install.ps1` 注册 HKCU `trellisboard` URL Protocol，并加入失败回滚；
      `uninstall.ps1` 删除协议键。
- [x] `desktop/README.md`：主路径、令牌 TTL/一次性/重启失效、配对码兜底、深链、验证清单、
      Windows 未验证项。

## 5. 测试

- [x] 新增 `tests/desktop-device-auth.test.js`（7 个测试）：签发鉴权/CSRF、一次性兑换 +
      审计 + heartbeat + 设备列表、过期、禁用/待改密、并发上限、桌面错误映射与兜底、
      capability/Rust/UI/安装脚本静态断言。
- [x] 更新 `tests/desktop-package.test.js`：权限列表 5 项、4 个自定义权限、新的命令清单。

## 6. 验证命令

```bash
python3 .trellis/scripts/task.py validate .trellis/tasks/11-05-desktop-device-auth
node --test tests/desktop-device-auth.test.js
node --test tests/desktop-package.test.js
npm test
npm run build
git diff --check
```

结果（2026-11-06，本机 Linux）：

- `task.py validate`：通过（implement 6 条、check 5 条）。
- `node --test tests/desktop-device-auth.test.js`：7/7 通过。
- `node --test tests/desktop-package.test.js`：10/10 通过。
- `npm test`：316 项，315 通过 / 1 跳过 / 0 失败。
- `npm run build`：成功（vite，2567 modules）。
- `git diff --check`：通过；`node --check` 覆盖全部改动的 JS 文件。

## 7. Windows 构建机验证清单（本机不执行）

1. `cargo tauri build --no-bundle`，确认 Rust 编译、命令签名与 `generate_handler!` 一致。
2. 安装后 `reg query HKCU\Software\Classes\trellisboard` 存在 `URL Protocol` 与
   `shell\open\command`。
3. 浏览器打开 `trellisboard://enroll?token=...&server=...`：已运行实例获得焦点并预填令牌；
   未运行实例启动后同样预填。
4. 本地页「从浏览器完成登录」能打开系统浏览器；远程 Board 页面调用 `invoke` 被拒绝。
5. 5 分钟过期、重复兑换、服务重启后旧令牌失效；DPAPI 凭证可被 Agent 心跳使用。
6. NSIS 安装路径是否需要额外注册 URL Protocol。

## 8. 回滚点

- 服务端：删除两个新端点与 `desktop-auth.js`，恢复 `agents.enroll` 内联实现，配对码路径不受影响。
- 桌面端：`enrollWithToken` 失败时可回退显式 `--pairing-code`；不影响既有设备撤销。
- 不改数据库 schema，无迁移回滚。

## 9. 提交

- 单次提交：`feat(desktop): enroll devices from a logged-in session`
- 提交后 `task.json` 保持 `in_progress`，不 archive、不合并。
