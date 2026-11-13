# 真机验收报告：客户端外观偏好跨 origin 持久化

- 任务：`.trellis/tasks/11-13-desktop-appearance-prefs/`
- 时间：2026-11-13 17:44–18:56
- 环境：Windows 10.0.26300 / WebView2（CDP 9341）/ 真实客户端 `trellis-board-client.exe`（`C:\projects\_trellis-board-appearance-target\debug`，17:43:51 构建）+ 真实 team 服务（`http://127.0.0.1:4461`，数据目录 `C:\projects\_trellis-board-appearance-e2e`）

## 结论

AC1、AC2、AC4、AC5、AC6、AC7、AC8 通过；AC3 只通过一半（客户端自带登录页通过，实时同步控制窗口未在真机打开，见「未覆盖」）。

| AC | 结果 | 证据 |
| --- | --- | --- |
| AC1 | 通过 | 见下 |
| AC2 | 通过 | 见下 |
| AC3 | 部分 | 登录页通过；control 窗口未开 |
| AC4 | 通过 | 见下 |
| AC5 | 通过 | 见下 |
| AC6 | 通过 | `cargo test` 113 passed |
| AC7 | 通过 | 静态核对 + `apps/desktop/test/desktop-ui-build.test.js:73-79` |
| AC8 | 通过 | `npm test` 434 pass / 2 skip；`oxfmt --check` 全部通过 |

## AC1 客户端内改偏好后换 origin 仍生效

1. 客户端连接 `http://127.0.0.1:4461`，在真实界面「偏好设置」选深色 + 特大。
2. `%TRELLIS_DESKTOP_HOME%\appearance.json` 写为 `{"theme":"dark","fontSize":"xl"}`。
3. 关闭客户端，把 `client.json` 的 `serverUrl` 改为 `http://localhost:4461`，重开。
4. 页面 `document.documentElement`：`dataset.theme="dark"`、`dataset.fontSize="xl"`、`getComputedStyle(...).fontSize="20px"`；该 origin 的 `localStorage`（`trellis-theme`/`trellis-font-size`）被同步为 `dark`/`xl`；`appearance.json` 内容不变。

## AC2 设备偏好优先于 origin 旧值

1. 在 `http://localhost:4461` 改回浅色 + 标准 → `appearance.json` 为 `light`/`md`。
2. 用脚本把 `http://127.0.0.1:4461` 这个 origin 的 `localStorage` 手工种成 `dark`/`xl`，刷新页面。
3. 结果：`dataset.theme="light"`、`dataset.fontSize="md"`、根字号 16px，且 `localStorage` 被回写为 `light`/`md`。

## AC3 客户端自带页面跟随设备偏好

- 登录页（已通过）：清掉保存的凭据 / 用错密码冷启动，停在 `http://tauri.localhost/`。设备偏好为 `dark`/`xl` 时该页 `dataset.theme="dark"`、`dataset.fontSize="xl"`、根字号 20px、`<html class="dark">`；`appearance.json` 的 sha256 前后一致（`383f4b6e…`），说明挂载时没有回写覆盖设备偏好。该 origin 的 `localStorage` 之前是 `light`/`md`，进一步说明自带页以设备偏好为准。
- 实时同步控制窗口（未在真机打开）：窗口由 `apps/desktop/src-tauri/src/agent_service.rs` 的 `show_control()` 创建，只有两条触发路径——收到服务端 control 帧（`publish_control`）或托盘菜单「处理实时确认」（`apps/desktop/src-tauri/src/main.rs:841`，`build_tray` 里 `review-live`）。本轮无法在不点原生托盘菜单/不接真实实时确认流的前提下打开该窗口。
  已核对的替代证据：`apps/web/src/desktop/main-control.tsx:9` 用 `AppearanceProvider` 包裹 `ControlApp`（与登录页同样的 `main-index.tsx:9`）；`capabilities/live-control.json` 已授予 `allow-appearance-load` 且未授予 save（符合 R5/R6 的只读语义）。
  人工补验：客户端运行 → 托盘图标左键 → 点「处理实时确认」→ 控制窗口 `<html>` 应为 `data-theme=dark data-font-size=xl`。

## AC4 浏览器直开 Board

真实 Chrome（Playwright 通道，`typeof window.__TAURI__ === "undefined"`）打开 standalone 服务 `http://127.0.0.1:4462/`：

- 初次加载：`dataset.theme="system"`、`dataset.fontSize="md"`、根字号 16px，页面正常渲染。
- 写入 `localStorage` 的 `trellis-theme=dark`、`trellis-font-size=xl` 后刷新：`dataset.theme="dark"`、`dataset.fontSize="xl"`、根字号 20px、`<html class="dark">` ⇒ 浏览器仍走 localStorage 路径。
- 控制台：无 `invoke` / `__TAURI__` / appearance 相关报错（过滤结果为空）。仅 2 条 standalone 模式下的 `GET /api/runtime` 404，与外观改动无关（standalone 服务没有该端点）。

## AC5 非法值回落

把 `appearance.json` 写成 `{"theme":"neon","fontSize":"huge"}`（以及更早一轮的 `fontSize: 42`）后启动真实客户端：`dataset.theme="system"`、`dataset.fontSize="md"`、根字号 16px，看板页正常渲染，无异常提示 ⇒ R4 成立。

## AC6 / AC7 / AC8 静态与用例

- `cargo test`（`apps/desktop/src-tauri`）：113 passed / 0 failed。
  - 注意：首轮曾因测试并行改 `TRELLIS_DESKTOP_HOME` 出现竞态失败 `appearance::tests::appearance_normalises_and_round_trips` panic at `src\appearance.rs:98`（`Os { code: 3 }`），补 `crate::config::test_env_lock()` 后稳定通过。
- `npm test`（`node --test "apps/*/test/*.test.js" "packages/*/test/*.test.js"`）：436 tests / 434 pass / 0 fail / 2 skipped。
- `oxfmt --check`：改动的 web 文件、`appearance.rs`、`main.rs`、三个 capability、`permissions/desktop.toml` 全部通过。
- 权限归属：`permissions/desktop.toml:129-136` 定义 `allow-appearance-load` / `allow-appearance-save`；`board-local-association.json` 两者都授予，`main.json`、`live-control.json` 只授予 load；`apps/desktop/test/desktop-ui-build.test.js:73-79` 的静态契约用例通过。

## 未覆盖 / 遗留

1. AC3 的控制窗口真机打开（见上，需人工点托盘菜单）。
2. Known Trade-offs 里的首屏闪烁未量化：本轮从 `127.0.0.1` ↔ `localhost` 切换时未观察到明显闪白（WebView2 冷启动本身有白帧，无法与 `theme-init.js` 的一帧区分）。

## 环境说明（不影响结论）

- 验收夹具 `.tmp-appearance/` 与 `C:\projects\_trellis-board-appearance-e2e\server-data` 在验收过程中被其他会话/清理流程删除，脚本与截图未保留；本报告记录的是删除前实测到的状态值与文件内容。
- 客户端单实例插件（`tauri-plugin-single-instance`）导致重启前必须结束整个进程树，否则新实例会转发参数后退出。
