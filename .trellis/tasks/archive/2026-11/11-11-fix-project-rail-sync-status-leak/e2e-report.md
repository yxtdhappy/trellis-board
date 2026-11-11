# 项目栏同步状态跨项目污染 E2E 报告

## 测试拓扑

| 层 | 地址 / 进程 | 说明 |
| --- | --- | --- |
| 页面 | `http://127.0.0.1:4317/` | Chrome 当前登录会话，team 模式 |
| 服务端 | PID `26024` | Node `server/index.js`，启动时间 2026-11-11 22:52:25 +08:00 |
| 运行数据 | `%LOCALAPPDATA%\TrellisBoard\server` | 未迁移、未清理 |
| Tauri IPC | 浏览器最小 mock | `list_local_associations` 与 `desktop_sidecar_status` |

## 逐步证据

| # | 页面操作 / 请求 | 对应接口与日志 | 结论 |
| --- | --- | --- | --- |
| 1 | 重启服务并访问 `/api/health` | 200，`status=ok, mode=team`；日志出现 `Trellis Team Board 已启动` | 通过 |
| 2 | 打开 Board | `/api/team/status` 200，返回三个项目及独立 taskSpace | 通过 |
| 3 | 初始项目状态 | `mdp-backend-service=正在同步`、`trellis-board=同步正常`、`mdp-backend-web=未关联` | 通过 |
| 4 | 选择 `trellis-board` | `/api/tasks/query` 200，`/api/task-operations` 200；日志无 ERROR/WARN | 通过 |
| 5 | 切回 `mdp-backend-service` | 自身仍为“正在同步”，`trellis-board` 仍为“同步正常” | 通过 |
| 6 | 选择 `mdp-backend-web` | `/api/tasks/query` 200，`/api/task-operations` 200；自身仍为“未关联” | 通过 |

日志增量从偏移 `65822` 起检查，未出现 ERROR、WARN 或异常堆栈。

## 结论

- 两个已关联项目使用不同同步状态时，项目栏不再互相污染。
- 切换三个项目后，各项目状态文案、状态点和分支行保持一致。
- 无本地关联的项目没有继承当前项目的已关联状态。
- 多分支 `error > syncing > pending > ready` 聚合由 Node 单元测试覆盖并通过。
- 页面控制台的 `/api/panels` 404 是 team 模式不加载插件的预期噪音。

## 限制

本轮在普通 Chrome 中注入最小 Tauri IPC mock，因此服务端请求和前端桌面渲染分支真实，
但未完成已安装 Tauri 客户端的冷启动登录、WebView2 IPC 与实际 sidecar 数据的桌面自动化。
