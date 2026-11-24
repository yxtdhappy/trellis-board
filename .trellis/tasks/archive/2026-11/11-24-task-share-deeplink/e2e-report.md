# 任务分享链接与深度唤起 E2E 实机验收报告

- 任务目录：`.trellis/tasks/11-24-task-share-deeplink`
- 验收日期：2026-11-24
- 验收分支 / HEAD：`pipeline-task-share-deeplink` / `ebca773`（已从 `origin/main` 快进同步，全部 9 项 Code Review 问题修复并完成第 2 轮复测，未执行 `git add` / `git commit`）

## 1. 拓扑与版本证据

| 项目 | 值 |
| --- | --- |
| 工作分支 / HEAD | `pipeline-task-share-deeplink` / `ebca773` |
| Web 产物（重建后） | `packages/server/public/share.html`（SHA256: `4220532F66362455A699D921849085B6BCFCD0B15F42472CDE814E8005F2AB01`，引用 `/assets/share-CpzMJo2J.js`）；`packages/server/public/index.html` 引用 `/assets/main-DQF2jzej.js` |
| 隔离客户端产物 | `C:\projects\_trellis-board-e2e\11-24-task-share-deeplink-retest\target\debug\trellis-board-client.exe`（`--features tauri/custom-protocol`，SHA256: `70E15A2A533E609F9E2141AEDC60F5C3E03890A35CAB751FE532F544D64D52E0`） |
| 隔离 Team 服务端 | `TRELLIS_BOARD_MODE=team`，端口 `4399`，`PID=13560`，`serverStartedAt=2026-11-24T07:51:36.721Z`，`version=0.4.58` |
| 本地 HTTPS 反向代理 | `https://127.0.0.1:4443` → `http://127.0.0.1:4399`（自签证书 + `x-forwarded-proto: https`） |
| CDP 调试端口 | 无头 Edge `9341`；桌面客户端 WebView2 `9301` |
| 种子数据 | `taskSpaceId=11598936-f18f-491f-8064-5a2b916f8c82`；父任务 `task-alpha`（`任务 Alpha：方案评审`）、子任务 `task-child`、任务 `task-beta`（`任务 Beta：二次跳转`）；账号 `admin`、`outsider`（无权）、`firstuser`（`mustChangePassword=true`） |

> **环境说明**：本机未安装 PowerShell 7（`pwsh`），默认环境为 Windows PowerShell 5.1；L2/L3 验收通过 Node.js v24.11.0 驱动浏览器与 WebView2 CDP 执行。桌面客户端运行期协议唤起在脚本中通过 `rundll32.exe url.dll,FileProtocolHandler <url>` 走 Windows `HKCU\Software\Classes\spec-board\shell\open\command` 注册表派发给单实例，冷启动由脚本校验注册表匹配后显式带隔离 env 启动客户端进程。

---

## 2. L1 自动测试与静态校验结果

| 检查项 | 命令 | 结果 | 说明 |
| --- | --- | --- | --- |
| JS/TS/HTML 格式 | `oxfmt --check`（13 个变更/新增文件） | **通过** | 无格式差异 |
| Web Lint | `oxlint`（7 个新建/修改 Web 文件） | **通过** | `0 warnings, 0 errors` |
| Web TypeScript | `npx tsc -b`（`packages/web`） | **通过** | exit 0 |
| Rust 格式与编译 | `rustfmt --check`（4 个改动/新增 Rust 文件）& `cargo check --bin trellis-board-client` | **通过** | `0 error, 0 warning` |
| 定向契约与单测 | `node --test packages/web/test/share-link.test.js packages/desktop/test/desktop-ui-build.test.js` | **通过（16/16）** | 覆盖参数校验、控制字符拒绝、Rust/前端契约 |
| Rust 全量单测 | `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` | **通过（400/400）** | 含 `share_link::tests::*` 8 条用例 |
| JS 全量单测 | `yarn test` | **719 tests：715 pass / 0 fail / 4 skipped** | 同步 `origin/main` 后原 `agent-template-repair.test.js` 失败已消除 |
| 产物重建 | `yarn build --target=web` & `yarn build --target=desktop-ui` | **通过** | 产物已同步至最新源码 |
| 行数与行尾门禁 | 源码行数统计 & LF 校验 | **通过** | `TaskDetailDialog.tsx` 659 行（≤700）、`main.rs` 1164 行（≤1200）、全部变更/新增文本文件 0 CRLF |

---

## 3. L2 / L3 逐 AC 验收结论与双证据链

| AC | 层级 | 结论 | 实测过程与双证据 |
| --- | --- | --- | --- |
| **AC1**：点击分享按钮复制 `<origin>/share.html?space=..&task=..`，协议随部署（http/https），详情与按钮布局不受影响 | L2 + L3 | **通过** | **HTTP (4399) & HTTPS (4443) 浏览器**：登录 Board 后点击父卡片（`task-alpha`）、子任务行（`task-child`）、详情弹窗底部「分享」，均复制出对应 `http://127.0.0.1:4399/share.html?...` 或 `https://127.0.0.1:4443/share.html?...`，弹窗保持打开。<br>**L3 桌面客户端**：子任务行复制 `http://127.0.0.1:4399/share.html?space=11598936-f18f-491f-8064-5a2b916f8c82&task=task-child`；详情弹窗底部复制 `task-alpha` 链接；`TaskDetailFooter` 按钮坐标实测 `shareRect=(703.3..768.7, 699.3..731.3)` 与 `closeRect=(774.7..820.0, 699.3..731.3)`，无重叠、垂直对齐、完全在对话框内。 |
| **AC2**：浏览器免登录打开 `share.html`，自动唤起并支持按钮重试；缺参/控制字符错误态、飞书提示与复制失败反馈可用 | L2 | **通过** | **HTTP & HTTPS**：免登录访问返回 200 及 `script-src 'self'` CSP，零 `/api/` 请求、零 JS/CSP 错误；`#hint` 含飞书与系统浏览器提示；加载自动尝试（2 次）与 `#open` 点击重试（累计 4 次）均触发同源 `spec-board://task?server=<origin>&...`（`protocolLaunchLogs` 2 条）；`#copy` 成功复制对应协议链接；模拟剪贴板受阻时按钮文案变为「复制失败，请重试」且 `#copy-error` 显示「无法自动写入剪贴板，请在系统浏览器中打开本页后重试。」；控制字符入参 `?space=s%0A&task=t` 隐藏 `opening/status/actions/hint/copyError`，仅显 `#error`「分享链接不完整，请让分享人重新复制。」且零协议跳转。 |
| **AC3**：客户端已运行并登录同一服务器时，协议唤起并打开目标任务详情（含列表未命中走纯 query 接口回源） | L3 | **通过** | WebView2 加载 `http://127.0.0.1:4399/assets/main-DQF2jzej.js`，注册表写入 `"<retest-exe>" "%1"`；运行期 `rundll32.exe` 触发协议唤起保持单实例（`processCount=1`）；搜索框过滤隐藏 Alpha 后唤起 Alpha，CDP Network 观测到纯 query 请求 `GET http://127.0.0.1:4399/api/tasks?taskSpaceId=11598936-f18f-491f-8064-5a2b916f8c82&executionTaskKey=11598936-f18f-491f-8064-5a2b916f8c82%3A%3Atask-alpha` 返回 HTTP `200`，成功打开弹窗。 |
| **AC4**：冷启动点击链接，有保存凭据直接打开、无保存凭据手动登录后打开（含首次登录强制改密后自动打开） | L3 | **通过** | **无保存凭据冷启动**：携带 `task-beta` 链接启动停在登录页，手动登录 `admin` 后自动打开「任务 Beta：二次跳转」。<br>**首次登录强制改密（`mustChangePassword=true`）**：`firstuser` 冷启动携带 `task-alpha` 链接登录后停在「修改密码」弹窗，改密前 `toastsBeforePasswordChange=[]`、`shareApiCallsBeforePasswordChange=0`（未提前消费）；提交改密后自动打开「任务 Alpha：方案评审」。<br>**有保存凭据冷启动**：第 1 轮已实机验证自动登录后直接打开「任务 Alpha：方案评审」。 |
| **AC5**：`server` 不一致、任务不存在、无权限、链接非法时，客户端显示对应提示，不打开弹窗 | L3 | **通过** | **异源（`127.0.0.1:9999`）**：0 弹窗 + toast 提示。<br>**不存在任务**：`404`，0 弹窗 + toast 提示。<br>**无权限用户（`outsider`）**：`404`，0 弹窗，未泄露 Alpha 内容。<br>**非法链接（`spec-board://task?space=only-space`）**：`desktop.log` 记录 `2026-11-24T07:52:28.545Z WARN 忽略无法识别的任务分享链接`，同时前端弹出 toast「任务分享链接格式无效，请让分享人重新复制」、0 弹窗（第 1 轮 P1 偏差已闭环）。 |
| **AC6**：同链接重复点击不叠开；连续点击两条不同链接最终打开最后一条 | L3 | **通过** | Alpha 弹窗已开状态下重复唤起 Alpha，`dialogCountAfterDuplicate=1`；间隔 80ms 连续唤起 Alpha → Beta 后稳定显示「任务 Beta：二次跳转」。 |
| **AC7**：`desktop_logout` 后暂存链接被清空 | L3 | **通过** | 点击顶栏退出触发 `desktop_logout`，WebView2 返回 `tauri.localhost` 且 `client.json` 中 `password` 已清空；`outsider` 登录后唤起 Alpha 返回 `404` 且无信息泄露。 |
| **AC8**：静态契约、Rust 单测、Web 单测及 Windows 实机验证 | L1+L2+L3 | **通过** | Rust 400/400、JS 715 pass / 0 fail、静态契约/lint/format/typecheck/行数/LF 全绿，Windows L2/L3 全流程复测通过。 |

---

## 4. 第 1 轮 Review 问题修复与同步合入验证

- **P1 闭环**：Rust 侧新增 `PendingShare::{Target, Invalid}` 状态机，非法 `spec-board://` 链接仅记录日志并入队 `Invalid`（不破坏已有合法目标、不回传原始 URL），前端统一弹窗提示「任务分享链接格式无效，请让分享人重新复制」；同步重建 `web` / `desktop-ui` 产物。
- **P2 闭环**：`useShareLinkOpen` 增加卸载/`active` 守卫、`mustChangePassword` 状态门控（配合 `PasswordDialog` `onChanged` 与 `BoardPage` 刷新续开），并将单任务回源切换为纯 query 端点 `/api/tasks?taskSpaceId=...&executionTaskKey=...`；`share.html` / `share-link.ts` 补齐先于 `.trim()` 的控制字符拒绝、长度上限、飞书改用系统浏览器指引与剪贴板失败内联提示。
- **P3 闭环**：补齐 `Kanban.tsx` 子任务行分享按钮、Rust `share_link::tests`（8 条）、`desktop-ui-build.test.js` 契约断言、`tauri-commands/index.md` / `design.md` / `implement.md` 文档对齐，拆分 `TaskDetailFooter.tsx` 使 `TaskDetailDialog.tsx` 降至 659 行。
- **`origin/main`（`ebca773`）合入观察**：复测客户端日志可见登录时切换至 `http://127.0.0.1:4399/client-updates`、登出时清除回退更新源、`mustChangePassword=true` 跳过后台同步启动，与新增桌面端代码兼容无冲突。

---

## 5. 仍未自动化覆盖项及原因

| 未覆盖场景 | 原因 | 建议 |
| --- | --- | --- |
| 飞书等 IM 内置 WebView 拦截自定义协议的实机表现 | 当前环境无真实飞书桌面客户端与登录账号 | 在真实飞书会话中发送 `<origin>/share.html?...` 验证「在系统浏览器中打开 / 复制客户端链接」体验 |
| 最小化到托盘后通过托盘恢复与协议前置焦点切换 | 系统托盘与原生窗口菜单无自动化 CDP 入口 | 人工隐藏窗口到托盘后触发分享链接核对窗口前置恢复 |
| 真实 Git 归档任务目录直开 | 种子库 `applyChanges` 不允许推送 `.trellis/tasks/archive/`；已通过搜索隐藏任务实测纯 query `/api/tasks?` 回源路径 | 在存在 Git 归档任务的仓库环境补充点击归档任务分享链接回归 |

---

## 6. 清理确认

复测结束后已执行全量环境清理：
- 确认无残留 `trellis-board-client.exe` 进程，隔离服务端（`4399`）、HTTPS 代理（`4443`）及 CDP 端口（`9301`、`9341`）均已释放；
- 删除临时注册表 `HKCU\Software\Classes\spec-board`；
- 删除隔离目录 `C:\projects\_trellis-board-e2e\11-24-task-share-deeplink-retest\`；
- 确认真实 `%LOCALAPPDATA%\TrellisBoard` 与默认生产端口未受污染。
