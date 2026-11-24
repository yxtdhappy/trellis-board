# e2e 报告：真实 Nginx 反向代理子路径部署（2026-11-24）

目标：验证 `TRELLIS_BOARD_BASE_PATH=/weint-spec-board` 在真实 Nginx 之后的两种部署模式（透传 / 剥离前缀），覆盖重定向、HTML 注入、Cookie Path、SSE、`share.html`、trustProxy 限流与真实桌面客户端。

## 环境

| 角色 | 位置 | 说明 |
| --- | --- | --- |
| 服务端 | Windows 宿主 `127.0.0.1:4318` | `PORT=4318`、`TRELLIS_BOARD_DATA_DIR=C:\projects\.trellis-e2e-data\server`（数据目录必须位于源码工作树之外，`packages/server/data-migration.js` 强制）、`TRELLIS_BOARD_BASE_PATH=/weint-spec-board`、`TRELLIS_BOARD_TRUST_PROXY=true`、管理员 `admin` |
| 反向代理 | WSL Ubuntu 22.04 内 nginx/1.18.0 | `listen 8080`，上游写 `127.0.0.1:4318`（WSL 镜像网络下回环直达宿主） |
| 客户端入口 | `http://localhost:8080/weint-spec-board` | 浏览器（Tabbit）与 debug 桌面客户端（`target/debug/trellis-board-client.exe`） |

## 透传模式（`proxy_pass http://127.0.0.1:4318;`，nginx 保留完整路径）

| 用例 | 结果 |
| --- | --- |
| 访问无尾斜杠 `/weint-spec-board` | `302` → `Location: /weint-spec-board/` |
| 首页 HTML | `200`，引用全部为前缀绝对路径（`/weint-spec-board/assets/*.js|css`、`/weint-spec-board/theme-init.js`、`/weint-spec-board/favicon.svg`） |
| 首页引用的 10 个资源 | 全部 `200`，`content-type` 正确 |
| `/weint-spec-board/api/health` | `200` `{"status":"ok","mode":"team",...,"version":"0.4.62"}` |
| `POST /weint-spec-board/api/auth/login` | `200`，`set-cookie: trellis_team_session=…; Path=/weint-spec-board; HttpOnly; SameSite=Strict` |
| 无 `Origin` 的登录 POST | `403 CSRF_REJECTED` |
| 登录前访问 `/weint-spec-board/login.html` | `302` 链接后的 `returnTo` 为 `%2Fweint-spec-board%2F`（保留子路径） |
| `/weint-spec-board/share.html` | `200`，引用全部带前缀，缺参时提示"分享链接不完整，请让分享人重新复制。" |
| 已登录 `GET /weint-spec-board/api/board/events` | `200 text/event-stream; charset=utf-8`，TTFB 0.207s，首帧 `retry: 3000`（`proxy_buffering off` 生效） |
| 匿名 SSE | `401` |
| `/api/health`（前缀外） | `404` |
| 100 MiB 请求体 | nginx `413`；8 MiB → `200` |

首登门禁：登录返回 `mustChangePassword=true`，未改密时 `/api/board/events`、`/api/auth/me` 均 `403 PASSWORD_CHANGE_REQUIRED`；`POST /api/auth/password` 改密后解除。

## 剥离前缀模式（`rewrite ^/weint-spec-board(.*)$ $1 break;` + 无 URI 的 `proxy_pass`）

| 用例 | 结果 |
| --- | --- |
| `/weint-spec-board` | `302` → `http://localhost:8080/weint-spec-board/` |
| 首页 / `theme-init.js` / `favicon.svg` / `assets/*` | 全部 `200` |
| `/weint-spec-board/api/health` | `200` |
| 登录 Cookie | 仍为 `Path=/weint-spec-board`（`board_cookie_path` 由服务端 basePath 决定，不随代理改写变化） |
| `/weint-spec-board/api/auth/me` | `200 authenticated` |
| SSE | `text/event-stream`，TTFB 0.210s |
| `/weint-spec-board/share.html` | `200` |

结论：`docs/team-operations.md` 描述的"剥离前缀 + 服务端仍设 `TRELLIS_BOARD_BASE_PATH`"两种模式均成立（`packages/server/team/http.js` 会先按 basePath 剥离再匹配，未带前缀也按根路径处理）。

## trustProxy

- `packages/server/team/auth.js` 的 `clientIp` 在 `trustProxy=true` 时取 `x-forwarded-for` 首段；`login_attempt` 表 `ip` 列实测记录 forwarded 值。
- 同一 `X-Forwarded-For: 203.0.113.77` 连续失败第 6 次 → `429`；换 `198.51.100.9` → `401`；无该头时回落 `127.0.0.1`。
- `proxy_set_header X-Forwarded-Proto $scheme` 覆盖客户端伪造值：经代理（http）Cookie 无 `Secure`；直连上游带 `X-Forwarded-Proto: https` + `Host: board.example.com` 时 Cookie 带 `Secure`。

## 真实浏览器（Tabbit）

无斜杠入口 → `/weint-spec-board/login.html?returnTo=%2Fweint-spec-board%2F`；表单登录后进入 `/weint-spec-board/`，标题 Trellis Board，13 阶段、0 授权项目；页面内 `EventSource('/weint-spec-board/api/board/events')` `opened=true`；`share.html` 无 broken resource。

## 真实桌面客户端（debug 构建 + WebView2 CDP）

- `desktop_login(serverUrl='http://localhost:8080/weint-spec-board')` → `{serverUrl: '…/weint-spec-board', username: 'admin', mustChangePassword: false, deviceReady: true}`，webview 跳转 `/weint-spec-board/`，页面显示"客户端后台：运行中"。
- 页面内 SSE `opened=true`；`/api/team/status`、`/api/tasks/query` 均 `200`；`document.cookie` 为空（HttpOnly 生效）。
- `client.json` 持久化 `serverUrl` 含子路径；更新检查地址推导为 `http://localhost:8080/weint-spec-board/client-updates`（新数据目录无更新文件，`WARN … HTTP 404` 属预期；直连该路径返回服务端 JSON `{"error":"更新文件不存在","code":"NOT_FOUND"}`，说明经代理路由正确）。

## e2e 期间发现并修复的缺陷

**桌面端 `cargo build` 失败（`cargo test` 未覆盖）**：`packages/desktop/src-tauri/src/bin/trellis-agent.rs` 通过 `#[path = "../agent/mod.rs"] mod agent;` 复用协议模块，但该 bin 不编译 `navigation.rs`；上一轮把 `raw_path_has_dot_segments` 放在 `navigation.rs` 并被 `agent/protocol.rs` 以 `crate::navigation::` 调用，导致 `error[E0433]: cannot find 'navigation' in the crate root`。

修复：抽出两个可执行目标共用的 `packages/desktop/src-tauri/src/url_path.rs`，`main.rs` 加 `mod url_path;`、`bin/trellis-agent.rs` 加 `#[path = "../url_path.rs"] mod url_path;`，三处调用点改用 `crate::url_path::`。修复后 `cargo build` exit 0，`cargo test` 408 passed / 0 failed。

## 已知缺口

- **deep link 唤起未闭环**：以第二实例（argv 或 OS 协议注册表，注册指向本 debug exe）传 `spec-board://task?server=http%3A%2F%2Flocalhost%3A8080%2Fweint-spec-board&space=space-e2e&task=task-e2e`，第二实例立即退出（单实例转发生效），但首实例 URL 未变化、`take_pending_share_link` 返回 `null`。代码证据：`packages/desktop/src-tauri/src/main.rs` 的 `tauri_plugin_single_instance::init` 回调只调用 `focus_main_window(app)`，未消费 `argv`；`tauri-plugin-single-instance` 的 `deep-link` feature 未把 URL 送给 `tauri-plugin-deep-link`。子路径解析本身已由 `share_link/tests.rs` 单元测试覆盖，该缺口与子路径无关，建议单独立项修复。
