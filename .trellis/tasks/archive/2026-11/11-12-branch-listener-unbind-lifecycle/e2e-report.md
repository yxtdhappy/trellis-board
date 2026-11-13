# E2E 验收报告

## 1. 测试拓扑

| 层 | 地址 / 进程 | 说明 |
| --- | --- | --- |
| 服务端 | `http://127.0.0.1:4317`，PID `48952` | team 模式；本轮验证使用的进程，启动于 `2026-11-13 13:44:20` |
| 服务端日志 | `C:\Users\yuhaojie\AppData\Local\TrellisBoard\server\logs\server.log` | 正常成功请求不逐条记录 |
| 数据库 | `C:\Users\yuhaojie\AppData\Local\TrellisBoard\server\board.sqlite` | schema v11，监听字段已存在 |
| 桌面客户端 | PID `21840` | `TrellisBoard 0.3.0`，启动于 `2026-11-13 13:51:10` |
| 客户端数据 | `C:\Users\yuhaojie\AppData\Local\TrellisBoard\data` | Agent 配置、cursor 和桌面日志 |
| 桌面日志 | `C:\Users\yuhaojie\AppData\Local\TrellisBoard\data\logs\desktop.log` | 本轮成功操作没有新增错误堆栈 |

本轮结束后服务端和客户端重新启动为 PID `52720`、`36332`。数据库中的 E2E 结论不受这次重启影响。

## 2. 版本与构建

- `main` 与 `origin/main` 均为 `e930bcc3e2d3655840ecf65fb4048fbe12570c75`。
- GitHub Actions `43378479104` 成功，提交同为 `e930bcc`。
- `node tests (windows)` 成功。
- `desktop build (windows)` 成功，其中 `Rust unit tests`、Tauri bundle、便携包 smoke test、启动 smoke test 均成功。
- 构建地址：`https://github.com/yxtdhappy/trellis-board/actions/runs/43378479104`
- 按用户要求，本轮没有重复执行 Node 全量测试。

## 3. 数据隔离与备份

测试前一致性备份：

`C:\Users\yuhaojie\AppData\Local\TrellisBoard\server\backups\board.sqlite.pre-branch-listener-e2e-2026-11-13T06-05-24-369Z.sqlite`

测试数据均使用 `E2E/listener-*` 和 `e2e_listener_*` 前缀。主要探针：

| 场景 | TaskSpace ID | Branch |
| --- | --- | --- |
| 三客户端状态 | `6ee3656d-3886-45c9-81fe-9860cb036e29` | `E2E/listener-three-202611130605` |
| 暂未激活 | `f4fa596a-cccd-443b-84a0-b4ab147f96bf` | `E2E/listener-inactive-202611130605` |
| 无关联 | `d55cfa5c-3a0d-4944-be89-62ac096335e1` | `E2E/listener-unassociated-202611130605` |
| 真实客户端解绑 | `0df04bf4-bf71-4b93-a375-82a1ff176dc8` | `E2E/listener-three-202611130605` |

## 4. 逐步证据

| # | 操作 / 请求 | 响应、数据库或日志 | 结论 |
| --- | --- | --- | --- |
| 1 | 三个隔离 binding 标记为监听，打开桌面项目栏 | 项目栏显示 `3/3 在线监听` | 通过；三个记录按同一 taskSpace 正确聚合 |
| 2 | 将其中一个监听状态置为 0，刷新项目栏 | 显示 `2/3`；binding 仍为 `approved` | 通过；切换监听与撤销关联被区分 |
| 3 | 三个监听状态全部置为 0，刷新项目栏 | 显示 `0/3 当前未激活，关联保留` | 通过；没有误报“无客户端关联” |
| 4 | 打开暂未激活、无关联和旧客户端分支 | 分别显示 `0/1 当前未激活`、`0/0 无客户端关联`、`0/1 旧客户端，监听状态未知` | 通过；五态按 taskSpace 独立展示 |
| 5 | 服务端权威解绑客户端 A | A binding 为 `revoked`；B/C 保持 `approved + listening`；UI 变为 `2/2` | 通过；只影响目标 Agent |
| 6 | 依次解绑三个客户端 | 三个 binding 均为 `revoked`；UI 为 `0/0 无客户端关联`；共 3 条解绑审计 | 通过 |
| 7 | 再次解绑已撤销的 A binding | 返回 `alreadyDetached=true`，审计仍为 3 条 | 通过；重复解绑幂等 |
| 8 | 负责人请求监听详情 | HTTP `200`；返回 `inactive`、`0/1` 和 1 个 listeners 条目 | 通过 |
| 9 | 校验监听详情字段 | listeners 字段只有 `bindingId/userId/username/displayName/deviceName/bindingStatus/online/listenerReportedAt/lastListenerAt/boundAt`；不含 `localRepoKey`、token 或绝对路径 | 通过；字段已脱敏 |
| 10 | 只读成员请求监听详情 | HTTP `403 FORBIDDEN`，不返回 listeners 数组 | 通过 |
| 11 | 对 `0/0` taskSpace 打开创建任务弹窗 | “创建并派发”禁用，显示“请先启动并绑定该分支的客户端” | 通过 |
| 12 | 直接请求创建任务，taskSpace 为 `0/0` | HTTP `409 TASK_SPACE_NO_ONLINE_LISTENER`；`sync_task_command` 操作项数量前后均为 0 | 通过；服务端门禁有效 |
| 13 | 对真实 `unknown_legacy` 分支 `feat/trellis-board` 直接请求创建任务 | HTTP `409 TASK_SPACE_NO_ONLINE_LISTENER`；操作项数量前后均为 0 | 通过；旧客户端不计在线 |
| 14 | 临时 worktree 接入真实桌面客户端 | UI 显示测试分支 `1/1 在线监听`，并出现“不再同步该分支”按钮 | 通过；本轮使用独立临时 worktree，不影响真实 `main` |
| 15 | 点击真实客户端“不再同步”并按确认流程提交 | 服务端 binding 从 `approved + listening` 变为 `revoked + is_listening=0`；本地 binding 被删除；写入 1 条 `task_space_binding_detached` 审计 | 通过 |
| 16 | 解绑后刷新桌面项目栏和数据库 | 测试分支显示 `0/0 无客户端关联`，快捷按钮消失；taskSpace 仍为 `active`；真实 `main` binding 仍为 `approved + listening` | 通过；未删除任务空间，也未影响真实分支 |

服务端日志对普通成功 GET/POST 不逐条记录，因此第 8 至 16 步以真实 HTTP 响应、SQLite 状态、审计记录和桌面 UI 为闭环证据。对应日志增量中没有未捕获异常或 ERROR 堆栈。

## 5. 真实客户端解绑说明

桌面接入弹窗的预检在本轮返回“没有返回有效的任务预检结果”。只读定位显示，Tauri 预检返回 `{ ok, result }`，而前端 `ProjectOnboardingDialog` 按顶层 `status` 归一化；这属于既有项目接入链路问题，不在本任务范围内，本轮未修改。

为了继续验证本任务的真实桌面解绑动作，本轮使用：

- 独立临时 worktree；
- 独立临时 Git 分支；
- 独立 `localRepoKey`；
- 独立 E2E 分支 binding。

测试后桌面快捷操作确实调用了 Tauri/Rust 解绑链路，而不是只改数据库。现有真实 `main` 绑定全程未操作。

## 6. 清理结果

已在事务中精确删除本轮测试数据：

- 4 个 `E2E/listener-*` taskSpace；
- 4 条 E2E 解绑审计；
- 3 个 E2E 用户；
- 3 个 Agent 设备与 3 个 active Agent；
- 3 条 team membership 和 3 条 project membership；
- 关联 binding、cursor、任务文件和操作项由 SQLite 外键级联清理。

清理后复核：

- `E2E/listener-%` taskSpace：`0`
- `e2e_listener_%` 用户：`0`
- E2E 设备和 Agent：`0`
- E2E 解绑审计：`0`
- 测试 binding：`0`
- 临时 worktree、临时分支、客户端临时配置备份：已删除
- 真实 `main` binding：`approved`，仍在线监听

测试前数据库备份保留。

## 7. 未验证项

- 没有三台真实桌面客户端同时在线；三客户端状态由隔离 DB fixture、真实服务聚合和真实桌面 UI 组合验证。
- 没有等待真实 60 秒设备超时并观察自动离线。
- 没有模拟断网解绑、`detachPending` 展示和恢复网络后的自动重试。
- 没有在真实 watcher/upload/pull 运行中逐项证明停止写入；该项仅有自动化测试覆盖。
- 没有验证浅色、深色、1440/1024/860px 的完整响应式布局。
- 没有通过正常接入弹窗完成临时项目绑定；原因是上述既有预检返回契约问题。

## 8. 结论

核心服务端聚合、权限、零监听门禁和真实桌面快捷解绑链路通过。三真实客户端切换、离线超时、断网重试和运行中写入停止仍属于未完成真机验收，不应标记为完整通过。

> 2026-11-13 真机复核补充：除“三台真实客户端同时在线”外，上述未验证项已在独立夹具环境补齐，见 §9。

## 9. 真机复核（2026-11-13，任务 `11-13-desktop-manual-acceptance-gaps`）

环境：源码自构建的 `trellis-board-client.exe`（PID `19152`）+ 真实 `apps/server`（`http://127.0.0.1:4399`）+ 隔离数据根 `C:\projects\_trellis-board-e2e`；客户端 UI 经服务端 URL 加载，WebView2 CDP 观测。完整命令与截图见 `.trellis/tasks/11-13-desktop-manual-acceptance-gaps/e2e-report.md`。

| §7 未验证项 | 复核结果 |
| --- | --- |
| 真实 60 秒超时自动离线 | 通过：杀客户端后第 3s 仍 `online`，第 63s 变 `inactive`，`onlineListenerCount` `1→0`，binding 保持 `approved` |
| 断网解绑 / `detachPending` / 恢复重试 | 通过：停服务端后解绑，UI 显示 `已关联 · 服务端解绑待确认` 并给出 `无法连接服务端: error sending request for url (http://127.0.0.1:4399/api/agent/task-spaces/<id>/detach)`；恢复后端 30s 内 `sync_status=revoked`、`is_listening=0`，`audit_event` 中 `task_space_binding_detached` 恰 1 条，本地 `bindings: []` 与 `taskSpaces: {}` 已清 |
| 运行中停止写入 | 通过：解绑前 `sync_task_space_file=2 / batch=1 / agent_command=0`，在线解绑 1.6s 完成，随后本地新增任务并提交 `e318ae6`，20s 后三项计数完全不变 |
| 浅/深色 × 1440/1024/860px | 通过：三档均无横向溢出，项目栏在 860 隐藏、1024 显示，主区唯一滚动容器 `MAIN…overflow-y-auto`；浅深色各三张截图。附带发现 TopBar 导航在 1024/860 折行重叠（既有缺陷，已记入 gaps 任务） |
| 正常接入弹窗完成临时项目绑定 | 通过：预检契约修复后，弹窗正常渲染仓库/分支/远端/团队/Agent 列表，“检查任务差异”→“接入并上传本地任务”→“接入任务空间”两轮均成功，全程无“没有返回有效的任务预检结果” |
| 三台真实客户端同时在线 | 仍阻塞：同机第二实例被 `tauri-plugin-single-instance`（`apps/desktop/src-tauri/Cargo.toml:15`、`src/main.rs:906`）转发后退出，需多台真机补测；`3/3 → 2/2 → 0/0` 聚合继续由原 fixture 证据覆盖 |
