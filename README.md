# Trellis Board

本地 Trellis 任务看板 MVP，默认只改动本应用目录，写操作只针对白名单仓库。

## 启动

需要 Node.js 24 或更高版本，持久化使用 Node 内置的 `node:sqlite`，没有第三方运行时依赖。

```powershell
cd D:\workspace\wiki\trellis-board
node server/index.js
```

打开 `http://127.0.0.1:4317`。

也可以运行 `npm start` 或 `npm run board`。

仓库白名单存放在 `data/board.sqlite`。这个版本固定在本机回环地址 `127.0.0.1`，不能直接暴露给团队；团队共享版需要增加认证、审计和多实例数据库方案。

页面先显示本地扫描缓存。服务启动后会监听白名单仓库的 `.trellis/tasks`、`.trellis/workspace` 和 `.trellis/.developer`；相关文件变更会经过 400ms 防抖合并，再由独立 Worker Thread 重建缓存，前端持续轮询状态并自动加载新数据。当前 5 个仓库的完整扫描约 8–15 秒，缓存接口约 0.1–0.2 秒；浏览器完整渲染仍受 641 条归档任务的数据量影响。

“重新扫描仓库”按钮仍保留，用于人工强制刷新。扫描期间如果文件再次变化，会在当前扫描结束后再跑一轮，避免最后一次变更丢失。`/api/board/status` 会返回监听状态、最近文件和刷新队列；防抖时间可通过 `TRELLIS_WATCH_DEBOUNCE_MS` 调整，最低 100ms。

文件监听使用 Node 的递归 `fs.watch`，当前实现面向 Windows/macOS 本机运行。Linux 或网络盘若不支持递归监听，需要改成每级目录监听或轮询，页面上的手动刷新仍可作为回退。

`.trellis/tasks` 和 `.trellis/workspace` 下的文件会参与缓存更新，但只有当前看板实际读取的任务文档、`task.json`、`implement.jsonl`、`check.jsonl`、workspace 索引和 journal 会改变展示结果。编辑器自动生成的临时文件或未被 loader 读取的其他文件可能触发一次无内容变化的扫描；实现以路径范围判断为主，没有为每种临时文件后缀单独维护白名单。

## 数据来源

- 任务实体：`.trellis/tasks/**/task.json`
- 任务阶段证据：`prd.md`、`design.md`、`implement.md`、`implementation-report.md`、`check-report.md`、`e2e-report.md`、`research/`、`implement.jsonl`、`check.jsonl`
- 父子任务：优先使用 `parent`/`children`；跨仓库兼容明确的 `meta.frontendTask`、`meta.backendTask`、`meta.childTask`、`meta.integrationTask`、`meta.uiTask` 及 `meta.*ParentTask`。其他普通 `meta` 路径只作为普通字段，不建立父子关系
- 归档状态：是否位于 `.trellis/tasks/archive/`
- 项目成员：`.trellis/workspace/<developer>/`

## 本地持久化

Board 自身可变状态统一保存在 `data/board.sqlite`：

- `repositories`：项目白名单和显示顺序
- `task_stage`：人工流程检查点
- `task_execution`、`task_tag`：截止日期、里程碑和标签
- `saved_view`：命名后的组合筛选
- `task_event`：从功能启用后开始记录的计划、阶段和系统观察事件
- `task_dependency`：任务间的阻断关系、原因、创建时间和解除时间
- `scan_cache`：带 `SCAN_SCHEMA_VERSION` 的完整看板扫描缓存
- `board_state`：刷新、监听、最近扫描状态和个人 WIP 软上限
- `app_meta`：数据库 schema 版本和旧 JSON 迁移标记

首次打开数据库时，会在一个事务中读取 `data/repos.json`、`data/task-metadata.json`、`data/scan-cache.json` 和 `data/board-state.json` 并导入 SQLite，然后写入一次性的 `legacy_json_imported_v1` 标记。非法或损坏的旧 JSON 只记录警告并跳过，不会阻止服务启动。迁移完成后，运行时只读写 SQLite，不再修改这四个 JSON 文件；它们保留为迁移来源和回滚备份。

数据库按 v1 -> v2 -> v3 顺序迁移。迁移前会先创建源版本快照：v1 使用 `data/board.sqlite.v1-backup`，v2 使用 `data/board.sqlite.v2-backup`；随后在同一事务中创建计划字段、标签、保存视图、事件表和依赖表。备份可独立打开并保持迁移前版本；任一步失败时主库仍保留源版本和原表。

SQLite 使用 WAL 模式，主线程和扫描 Worker 各自持有连接。项目增删、批量新增和看板状态的多字段更新均使用事务；失败时回滚整个操作。你可以单独备份 `data/board.sqlite`，但热备份前应先停止服务，并同时处理可能存在的 `board.sqlite-wal` 与 `board.sqlite-shm`。

回滚到旧版 Board 时，先停止服务并归档当前 `data/board.sqlite*`，再切换到旧代码。v1/v2 数据库可使用迁移生成的对应版本快照；四个旧 JSON 文件仍保持迁移前内容，可继续作为旧版的存储来源。迁移后在 SQLite 中新增或删除的项目、人工阶段、计划字段、依赖和事件不会自动写回这些备份。

## 重要限制

看板推导的是“可证实的流程位置”。它读取 `task.json.status`、实施报告、检查报告和任务产物，而不是只看任务是否仍在 `planning`。E2E 是可选的补充证据：只接受 `e2e-report.md`、`check-report.md` 或 `implementation-report.md` 中明确记录的执行结果，`implement.md` 里的计划、条件句和“下一步做 E2E”不会计为完成；缺少 E2E 不阻塞规范回写和工作提交。进度百分比只统计 12 个必需阶段，但 13 个阶段（含可选的 E2E）仍全部显示。父任务缺少开发事件时，只在所有子任务都有实现/检查证据后继承对应阶段。Trellis 没有持久化 review、lint、E2E、spec 回写和 journal 的每一步事件，因此没有证据的阶段仍显示“待人工确认”。看板可以把人工确认持久化到 SQLite 的 `task_stage` 表，不会伪造 `task.json` 状态。

计划字段、标签、保存视图、依赖和事件属于 Board 本地增强，不写回目标仓库的 `task.json`。阶段事件从功能启用后开始记录；旧任务不会按文件修改时间补造历史。任务用稳定的 `executionTaskKey` 关联扩展数据，归档导致相对路径变化后数据仍可读回。

流程语义与 Trellis 实际归档顺序一致：`in_progress` 状态从启动持续到归档，开发工作提交发生在归档之前，`finish-work` 再原子地把任务标记为 completed 并移入 `archive/`。因此“收尾”表示工作提交到归档之间的活动队列；归档任务只进入历史索引，不会继续显示为收尾中的任务。归档后追加的 journal 是后续会话记录，不反向改变任务状态。

关系解析会报告引用缺失、自引用、同一子任务存在多个父任务和父子循环；出现关系异常时，父任务停止继承子任务阶段，详情页会显示具体原因。归档后的任务也可以被归档前留下的绝对任务路径唯一解析到。

同一任务组在流程视图中显示为父任务卡片和子任务列表，也可以跨仓库归组。当前一组示例是 `mdp-backend-service` 的父任务、后端子任务和 `mdp-backend-web` 的前端子任务；父子关系来自 `parent`、`children` 和 `meta.frontendTask`，不改写业务仓库里的任务文件。

`prd.md`、`design.md`、`implement.md`、`implementation-report.md`、`check-report.md`、`e2e-report.md` 的详情预览会截断到每个文件 40,000 字符；完整文件仍在仓库中。阶段判断读取原文件，不受预览截断影响。

自动刷新仍会重新扫描全部白名单仓库，而不是只扫描发生变更的仓库。这样能正确重算跨仓库父子任务和父任务阶段继承；代价是每次有效变更后仍有约 8–15 秒的后台扫描。扫描期间再次变化会排队，并在本轮结束后再扫描一次。

## 写操作

- 创建任务：调用目标仓库自己的 `.trellis/scripts/task.py create --no-start`
- 派发任务：更新指定任务的 `task.json.assignee`
- 流程勾选：只写入看板的 `data/board.sqlite`，不改写 Trellis 的正式任务状态
- 计划字段：从任务卡片或详情维护截止日期、里程碑和标签，只写 SQLite
- 组合视图：保存、复用和删除个人筛选条件
- 阻断依赖：从任务详情创建或解除，依赖与事件同事务写入 SQLite
- WIP 软上限：在流动信号面板设置 1–9，达到或超出只提醒，不阻止阶段操作

接口只允许操作 SQLite `repositories` 表中的白名单仓库；不提供任意路径读取。

主要源码入口：[server/index.js](./server/index.js)、[server/database.js](./server/database.js)、[server/repositories.js](./server/repositories.js)、[server/persistence.js](./server/persistence.js)、[server/watcher.js](./server/watcher.js)、[server/loader.js](./server/loader.js)、[server/scan-worker.js](./server/scan-worker.js)、[server/actions.js](./server/actions.js)、[public/app.js](./public/app.js)。

## 当前实现范围

已完成：

- 跨项目扫描进行中和归档任务
- 跨仓库父子任务归组、父任务继承子任务实现/检查进度
- 按项目、负责人、关键词筛选
- 截止日期、里程碑、标签和保存后的组合注意力视图
- 推荐任务、注意力队列、13 阶段流程胶带和轻量 Kanban 首屏
- 自动显示 13 个流程阶段及证据
- 展开 PRD、Design、Implement 产物
- 记录人工流程检查点
- 通过 Trellis `task.py` 创建 planning 任务；只允许派发给目标仓库已初始化的 workspace 成员
- 通过 `--assignee` 创建任务，并支持更新现有任务负责人
- SQLite 本地持久化、自动文件监听刷新和人工强制刷新
- 从功能启用后开始的计划、人工阶段和扫描阶段可信事件
- 双向阻断依赖、解除后可推进队列、DoR/DoD 缺口和个人软 WIP 提醒

团队共享前仍需完成：

- 用户认证与项目级读写权限
- 创建、派发、阶段修改的审计日志
- SQLite 单机文件之外的共享数据库、并发调度和备份方案
- 多主机仓库访问或服务端 Agent，不应从浏览器直连各台开发机路径
- 真实用户身份不可继续依赖每台机器上的 `.trellis/.developer`

因此当前版本适合单机试用和交互验收，不适合作为公司级多人系统的最终部署形态。
