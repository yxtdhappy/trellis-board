# 实机客户端 E2E 验收报告（全局 UI 一致性与视觉缺陷治理）

## 1. 验收拓扑与版本证据

| 项目 | 值 |
| --- | --- |
| 验收时间 | 2026-11-24 10:55 - 11:06 (+08:00) |
| Git HEAD | `00efdd9`（含全部 6/6 子任务工作提交与归档提交） |
| 验收层级 | L1 自动测试（已前置通过）+ L3 真实 Tauri 客户端（WebView2 CDP）+ 隔离 Team 服务端 |
| 服务端进程 | `node packages/server/index.js`（`TRELLIS_BOARD_MODE=team`，`PORT=4461`，`processId=14236`，`serverStartedAt=2026-11-24T02:58:22.072Z`，`version=0.4.58`） |
| 服务端隔离数据目录 | `C:\projects\_trellis-board-e2e\ui-audit\server-data` |
| Web 静态产物 | `packages/server/public/assets/`（实测加载 `/assets/main-1uenR1EY.js`、`/assets/admin-CPjbvwb2.js`、`/assets/TrellisLogo-7uaBauFj.css`） |
| 客户端二进制 | `packages/desktop/src-tauri/target/debug/trellis-board-client.exe`（`--features tauri/custom-protocol`，SHA256 `8F5AFAFB8349255BCEA31C39C916651FCA19AF1279AA11216B7A2722E8C674CC`） |
| 客户端内嵌 UI 产物 | `packages/desktop/ui/assets/`（实测加载 `./assets/index-t9i7nhkg.js`、`./assets/index-DfPpn0nN.css`） |
| 客户端隔离 HOME | `C:\projects\_trellis-board-e2e\ui-audit\clients\c1` |
| WebView2 CDP 端口 | `9341` |

## 2. 逐项实机验收结果与双证据链

| 验收项 | 状态 | UI / CDP 实测证据 | 日志 / 接口复核证据 |
| --- | --- | --- | --- |
| 桌面端 `LoginApp`（`http://tauri.localhost/`） | 通过 | 加载最新 `./assets/index-t9i7nhkg.js`；3 个输入框与「登录」按钮均为 `32px`；`footerWidth=448`，长配置路径 `配置：C:\projects\_trellis-board-e2e\ui-audit\clients\c1\client.json` 实测 `scrollWidth=448, clientWidth=448, overflow=false`；0 console error / 0 exception；提交表单成功登录跳转至 `http://127.0.0.1:4461/` | `desktop.log` 记录 `运行环境检查 state=Ready node=24.11.0/path trellis=0.6.17/global python=3.13.17/path`；`/api/health` 返回 `status: ok` |
| Board 首页 & TopBar（AC-P1） | 通过 | 加载 `/assets/main-1uenR1EY.js`、`hasTauri=true`；`headerH=57px` 单行无折行；`tabsLists=[32]`、`selectTriggers=[32,32,32,32,32]`、主操作按钮（「创建任务」「系统」「切换到深色主题」）全为 `32px`；`docOverflow=false` | 0 console error / 0 uncaught exception / 0 `>=400` 网络响应 |
| 弹窗规范（AC-P2：`CreateTaskDialog` / `PasswordDialog` / `PreferencesDialog` / `UpdateDialog`） | 通过 | 4 个弹窗标题与 `DialogBody` 首子元素左缘像素对齐差值均为 `0.0px`（`CreateTaskDialog`: `356.7 vs 356.7`；`PreferencesDialog`: `400.7 vs 400.7`；`UpdateDialog`: `416.7 vs 416.7`）；`DialogHeader` 右侧 `paddingRight=32px` 避让关闭按钮；所有底栏按钮高度 `32px` 且「取消/恢复默认」在左、主动作在右；`UpdateDialog` 正确显示 `v0.4.58`（`hasBrokenV=false`）及未配置更新服务器提示 | `desktop.log` 确认构建期未注入更新服务器，与 `UpdateDialog` 实机 Alert 一致；0 console error |
| 窄屏响应式与防溢出（AC-P3：`390x844` 移动端视口 & 超长团队名） | 通过 | CDP `Emulation.setDeviceMetricsOverride(390, 844)` 下出现「打开项目侧栏」按钮，点击展开单实例抽屉 `drawerOpened=true`，收起态与展开态 `overflowClosed=false` / `overflowOpened=false`；管理后台超长团队名 `UI一致性验收超长团队名称验证省略截断表现TeamAlpha` 实测 `scrollWidth=305, clientWidth=213, parentOverflow=false, docOverflow=false` | `/api/admin/teams` 返回 `201 Created`（`id=5d14d436-e179-4e31-b949-991fc0a9e720`） |
| 主题切换（AC-P4） | 通过 | 点击 TopBar「切换到深色主题」按钮，`document.documentElement.classList.contains('dark')` 由 `false` 切为 `true`，恢复正常；Sonner 容器 `section[aria-label*=Notifications]` 已挂载 | 0 console error / 0 样式报错 |
| 桌面端插件视图（`DesktopPluginsView`） | 通过 | 切换到「插件」视图后展示 `DESKTOP PLUGINS / LOCAL HOST`、`宿主 0.4.58`、`6 个插件`，`docOverflow=false` | 0 console error / 0 failed response |
| 管理后台 `/admin.html`（子任务 5） | 通过 | 加载 `/assets/admin-CPjbvwb2.js`；遍历「项目协作」「用户账号」「归档同步」「团队」「Agent 设备」「系统审计」全部 6 个 Tab，均 `docOverflow=false`、主输入框高度 `32px` | 0 console error / 0 uncaught exception / 0 `>=400` 响应 |

## 3. 未覆盖项与说明

- **`HandoffNotice` 常驻浮层与 `LiveSyncControlDialog` / `DiffViewer` 冲突态**：需要真实 Git 工作树 + 双端并发修改制造 `source_cleanup_conflict` / `task_file_conflict` 事件，本次未构造双机/冲突仓储探针，相关代码路径已通过 L1 静态检查、`tsc --noEmit`、代码走查与 `packages/web` 单测验证；如需实机触发冲突弹窗，可另行搭建双分支 Git 仓库按 `trellis-board-e2e` 注入冲突事件验证。
- **`UpdateDialog` 下载安装进行中态（`applying=true`）**：当前本地 debug 构建未注入更新服务器 URL，故未触发真实下载流与不确定进度动画；`showCloseButton={!applying}` 与 `Progress` 的 `data-indeterminate` 样式已核对源码与原语一致。
- **环境说明**：首次 `cargo build` 未带 `--features tauri/custom-protocol` 时 debug 壳默认指向 `http://localhost:5199/`（Tauri `devUrl`），补充 `--features tauri/custom-protocol` 重编后正常加载内嵌 `http://tauri.localhost/`，属 Tauri 构建模式差异，非产品缺陷。

## 4. 环境清理结果

- Tauri 客户端进程树已通过 `taskkill /IM trellis-board-client.exe /T /F` 彻底结束（`CLIENT_PROCS=0`）。
- 隔离测试服务端进程已终止，端口 `4461` 与 CDP 端口 `9341` 已无监听进程。
- 隔离目录 `C:\projects\_trellis-board-e2e\ui-audit\`（含 `server-data`、`clients\c1` 与临时 CDP 脚本）已全部删除（`Test-Path = False`）。
- 源码工作区无额外脏文件（仅新增本验收报告 `e2e-report.md`）。
