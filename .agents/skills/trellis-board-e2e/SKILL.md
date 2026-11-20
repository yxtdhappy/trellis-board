---
name: trellis-board-e2e
description: "Run end-to-end and real-device verification for trellis-board: isolated server data/ports, browser acceptance, real Tauri client over WebView2 CDP, evidence chains and known traps. Use for 实机/真机验收、e2e 回归、客户端实测、发布前冒烟、真实服务验证。"
---

# Trellis Board E2E / 实机验收

自动测试证明代码路径，实机验收证明用户看到的状态。两者回答的问题不同，报告里分开写。

## 选择层级

| 层 | 证明什么 | 入口 | 适用场景 |
| --- | --- | --- | --- |
| L1 自动测试 | 纯函数、HTTP 契约、Rust 状态机 | `yarn test`、`cargo test` | 每次改动 |
| L2 真实服务 + 浏览器 | Web 页面、SSE、路由、鉴权 | `node packages/server/index.js` + Tabbit/浏览器 | 改 Web、API、静态资源 |
| L3 真实客户端 + CDP | WebView2、capability、进程内 Agent、托盘、原生弹窗 | 自构建 `trellis-board-client.exe` + CDP | 改 desktop、IPC、同步、更新 |
| L4 多机/多客户端 | 同账号双设备、单实例语义 | 两台真机 | PRD 明确要求时 |

- 纯逻辑行为通常先落自动测试，实机证据用来补真实链路。
- 单实例插件（`tauri-plugin-single-instance`）让同机开第二个客户端变成"转发 argv 后退出"，因此多客户端场景走多机。
- 原生目录选择器、托盘菜单、系统通知点击没有可自动化入口，验收时按人工项处理。

## 0. 自动测试

```powershell
yarn test                 # packages/*/test/*.test.js
yarn test:plugins         # 改插件时
yarn build:desktop        # 客户端 UI 产物
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
yarn format:check
```

Rust 测试里改 `TRELLIS_DESKTOP_HOME` 的用例通过 `config::test_env_lock()` 串行化，否则并行跑会竞态（`appearance.rs` 曾偶发失败）。

## 1. 隔离布局

临时目录放项目盘 `C:\projects\_trellis-board-e2e\<task>\`，与 `/tmp`、`%TEMP%` 相比便于读取和清理。

```text
C:\projects\_trellis-board-e2e\
  server-data\        TRELLIS_BOARD_DATA_DIR（board.sqlite / logs/）
  clients\c1\         TRELLIS_DESKTOP_HOME（client.json / agent / logs）
  target\             CARGO_TARGET_DIR，与其他会话的 target 分开
  repo\  origin.git\  测试仓库与 bare 远端
```

布局上的常见做法：

- 服务端数据目录与客户端 HOME 各用一份，且都放在源码工作树之外，仓库扫描与文件监听就不会碰到它们。
- 端口按轮次错开（服务端 `4399`/`4461`，CDP `9301`/`9341`），起进程前用 `Get-NetTCPConnection -LocalPort <port>` 看一眼占用情况。
- 生产 `4317` 上常驻着别的进程或旧代码，`scripts/desktop-dev.mjs` 也会直接复用已存在的 4317，验收时手工起服务并把端口写进报告。
- 每轮用新目录或先删旧目录；遗留的 `board.sqlite`、`live-cursors.json` 会让结果对不上。

## 2. 起真实服务端

```powershell
$env:TRELLIS_BOARD_MODE = 'team'
$env:PORT = '4399'
$env:TRELLIS_BOARD_DATA_DIR = 'C:\projects\_trellis-board-e2e\server-data'
$env:TRELLIS_BOARD_ALLOW_LOCAL_GIT_REMOTES = 'true'   # 用 file:// 远端时
node packages/server/index.js
```

- 空库先建管理员（同一 env）：`node packages/server/team/cli.js init-admin --username admin --display-name '系统管理员'`。首次登录会强制改密，客户端登录前先处理这一步。
- `/api/health` 返回 `processId` 与 `serverStartedAt`，用它证明当前进程跑的是最新源码。
- 服务端日志在 `<TRELLIS_BOARD_DATA_DIR>\logs\server.*.log`，用 `Get-Content -Tail 200` 增量读。
- 改完服务端代码后重启，并重新记录 PID/启动时间。

## 3. 构建真实客户端

```powershell
yarn build:desktop                       # cargo build 只打包这份 UI 产物
$env:CARGO_TARGET_DIR = 'C:\projects\_trellis-board-e2e\target'
cargo build --manifest-path packages/desktop/src-tauri/Cargo.toml
# 产物：%CARGO_TARGET_DIR%\debug\trellis-board-client.exe
```

- 日常验收用 debug 构建（快）；发布前冒烟再走 `cargo tauri build` + `yarn desktop:package`（release 数分钟）。
- Release 构建已启用 `devtools` 特性，右键能打开「检查」，CDP 端口仍由环境变量开启。
- 客户端 UI 由服务端 URL 加载，页面 bundle 来自 `packages/server/public`。`yarn build` 之后核对页面加载的哈希与当前产物一致——历史上出现过别的会话重建 public、页面还在跑旧 bundle 的情况。

## 4. 启动客户端 + WebView2 CDP

```powershell
$env:TRELLIS_DESKTOP_HOME = 'C:\projects\_trellis-board-e2e\clients\c1'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9301'
& 'C:\projects\_trellis-board-e2e\target\debug\trellis-board-client.exe'
```

- 重启前用 `taskkill /IM trellis-board-client.exe /T /F` 结束整进程树，否则新实例会把 argv 转给首实例后自己退出。
- 目标发现：`Invoke-RestMethod http://127.0.0.1:9301/json/list | Where-Object type -eq 'page'`，按 URL 选 target——登录页是 `tauri.localhost`，Board 页是服务地址；`control.html` 不是 UI target。
- 交互断言用 `Runtime.evaluate`，尺寸用 `Emulation.setDeviceMetricsOverride`。`Page.captureScreenshot` 有超时历史，遇到超时改用 DOM/接口证据，并把它记成环境问题。
- 客户端日志：`%TRELLIS_DESKTOP_HOME%\logs\desktop.log`；本地状态：`client.json`、`agent\live-cursors.json`、`agent\runtime.json`。
- 登录可以走界面，也可以预写 `client.json`（serverUrl/username/password）；`mustChangePassword` 时只建会话、不建设备。
- 断网/恢复场景直接停服务端进程即可——SPA 已加载，正好复现"服务端不可达"。

## 5. 浏览器验收（L2）

- 用项目现有的浏览器工具（Tabbit），工具连不上时换一个并把该故障记进报告。
- 实际打开 `/`、`/admin.html`、`/login.html` 和改动页面；构建成功本身不算验收结果。
- 看控制台的 error 与请求的 4xx/5xx（standalone 模式下 `/api/runtime` 404 属预期）。
- 需要精确视口时用 CDP `Emulation.setDeviceMetricsOverride`，不靠窗口尺寸。

## 6. 证据与报告

每个验收项通常配两条独立、可互相复核的证据：

| 证据类型 | 例子 |
| --- | --- |
| UI 状态 | ProjectRail 文案、`dataset`、`scrollTop`、元素尺寸 |
| 接口/数据库 | `/api/health`、`/api/team/status`、`sqlite3 board.sqlite` 只读查询 |
| 客户端日志 | `desktop.log` 的扫描/上传/分支错误码 |
| 服务端日志 | `server.*.log` 的 revision、`x-request-id`、错误栈 |

报告写进任务目录 `e2e-report.md`：拓扑表（版本/构建、PID、端口、路径、HEAD）、逐 AC 结果与证据、未覆盖项及原因、清理结果。

记录习惯：

- 环境故障（MCP 超时、截图失败、工具不可用）单列，与产品结论分开。
- 没跑的 AC 写"未执行 + 原因 + 建议"，不用推测补位。
- 版本证据取 HEAD、进程启动时间、包 SHA256 中的两项组合。

## 7. 已知坑

- `4317` 上可能是旧代码或别的会话的进程，先看 `/api/health` 的 PID/启动时间。
- 客户端数据目录与服务端数据目录混用会互相覆盖 `client.json` / `board.sqlite`。
- 测试仓库缺 `.trellis/scripts/` 时上传报"项目缺少 .trellis/scripts/task.py"（上传前要 `task.py set-branch`）。
- 上限：单文件 1 MiB、单批 64 MiB / 1024 文件；超限在客户端侧被拒，服务端不留副作用。
- 分支门禁：切到非绑定分支后同步失败关闭，不写本地、不推进 cursor；恢复要切回绑定分支。
- 服务端 `standalone` 模式无登录/团队，桌面接入链路用 `TRELLIS_BOARD_MODE=team`。
- 多任务并行时各自的 `TRELLIS_BOARD_DATA_DIR`、端口、`CARGO_TARGET_DIR` 错开。
- 页面操作后立刻截图可能拍到未渲染完的状态，断言前先等元素或接口就绪。

## 8. 清理

1. 关闭客户端（整进程树）与服务端，确认端口已释放。
2. 删除 `C:\projects\_trellis-board-e2e\<task>\`（数据、仓库、target、日志）。
3. 删除验收期间的探针任务目录和提交；需要保留测试提交时先问用户。
4. 动过 `4317` 的话，恢复成最新源码运行，并在报告里记录 PID/启动时间。
