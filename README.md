# Trellis Board

Trellis Board 提供两种运行模式：

- `standalone`：只监听 `127.0.0.1`，扫描本机白名单仓库，适合单机使用。
- `team`：提供账号、项目权限、服务端权威 Git 工作副本、审计、团队看板和 Windows 同步 Agent。

两种模式共用同一套任务推导、看板和 SQLite 代码。团队版的部署、升级、备份和故障处置见
[团队版运维手册](./docs/team-operations.md)。

## 启动

需要 Node.js 24 或更高版本，持久化使用 Node 内置的 `node:sqlite`，没有第三方运行时依赖。

```powershell
cd D:\workspace\wiki\trellis-board
node server/index.js
```

打开 `http://127.0.0.1:4317`。

也可以运行 `npm start` 或 `npm run board`。

前端开发用 `npm run dev`：并行启动 `node --watch server/index.js`（服务端改动自动重启）和 Vite 开发服务器（页面 HMR），`/api` 由 Vite 代理到 `http://127.0.0.1:4317`；5173 被占用时 Vite 会自动递增端口，以控制台打印的地址为准。

standalone 模式固定监听本机回环地址 `127.0.0.1`。需要多人访问时使用 team 模式，并在
可信反向代理后提供 HTTPS；不要把 standalone 服务直接暴露到局域网或公网。

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

Board 运行数据不再写入源码目录。默认根目录为：

- Windows：`%LOCALAPPDATA%\TrellisBoard\server`
- macOS：`~/Library/Application Support/TrellisBoard/server`
- Linux：`${XDG_DATA_HOME:-~/.local/share}/TrellisBoard/server`

部署环境应通过 `TRELLIS_BOARD_DATA_DIR` 指向独立持久化目录；Ubuntu 服务建议使用
`/var/lib/trellis-board`。服务端主进程同时把日志写入
`<运行数据目录>/logs/server.log`；默认即 Windows 的
`%LOCALAPPDATA%\TrellisBoard\server\logs\server.log`。日志按 `5 MiB × 5` 轮转，
当前文件加 4 个历史文件，总容量上限约 25 MiB；正常退出会等待内存中的日志批次落盘。
强制终止、断电或系统崩溃时，尚未刷新的尾部日志可能丢失。

Board 自身可变状态统一保存在该目录下的 `board.sqlite`：

- `repositories`：项目白名单和显示顺序
- `task_stage`：人工流程检查点
- `task_execution`、`task_tag`：截止日期、里程碑和标签
- `saved_view`：命名后的组合筛选
- `task_event`：从功能启用后开始记录的计划、阶段和系统观察事件
- `task_dependency`：任务间的阻断关系、原因、创建时间和解除时间
- `scan_cache`：带 `SCAN_SCHEMA_VERSION` 的完整看板扫描缓存
- `board_state`：刷新、监听、最近扫描状态
- `team`、`team_member`：团队与团队成员（团队边界）
- `team_project`、`project_member`：团队项目、项目角色和 Agent 绑定
- `user_session`、`saved_view`、`user_board_state`：活动团队、保存视图和个人 WIP
- `audit_event`、`agent_event_cursor`：团队审计与按团队隔离的 Agent 事件游标
- `project_live_revision`、`project_live_file`、`project_live_batch`：团队实时文件覆盖层、单调 revision 与幂等批次
- `agent_live_cursor`：每台桌面设备已成功落盘的实时文件 revision
- `git_credential`、`git_ssh_known_host`：团队 Git 凭据密文、项目引用和 SSH 主机信任
- `app_meta`：数据库 schema 版本和旧 JSON 迁移标记

全新数据库会直接创建当前 schema（v8），包含团队、团队成员、团队项目、团队审计、Agent 事件游标、实时文件覆盖层、Git 凭据、SSH 主机信任、项目初始化工具和 bootstrap 负责人。首次打开空库时仍会在一个事务中读取运行数据目录中的 `repos.json`、`task-metadata.json`、`scan-cache.json` 和 `board-state.json` 并导入 standalone 数据，然后写入一次性的 `legacy_json_imported_v1` 标记。非法或损坏的旧 JSON 只记录警告并跳过，不会阻止服务启动。运行时不修改这四个 JSON 文件。

v6/v7 数据库升级到 v8 前会在运行数据目录的 `backups/` 写入 `board.sqlite.pre-v8.*` 快照，再补项目 Agent 工具和 bootstrap 负责人字段，已有账号、项目、审计和任务索引保持不变。`v5` 及更旧版本仍拒绝启动，不能通过删除数据库代替迁移。重建前先停止服务并归档运行数据目录中的 `board.sqlite`、`board.sqlite-wal` 和 `board.sqlite-shm`。

SQLite 使用 WAL 模式，主线程和扫描 Worker 各自持有连接。项目增删、批量新增和看板状态的多字段更新均使用事务；失败时回滚整个操作。Git 凭据使用运行数据目录中的 `git-credentials.key` 做 AES-256-GCM 加密，备份数据库时必须同时备份该密钥；丢失密钥后凭据无法解密，只能重新录入。热备份前应先停止服务，并同时处理可能存在的 `board.sqlite-wal` 与 `board.sqlite-shm`。

回滚到旧版 Board 时，先停止服务并归档当前运行数据目录中的 `board.sqlite*` 与 `git-credentials.key`，再切换到旧代码和旧库备份。团队版成功推送的 Git 任务不会被回滚，数据库中的接受状态、团队成员和审计会随备份回退。详细步骤见[团队版运维手册](./docs/team-operations.md)。

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
- 流程勾选：只写入看板数据库，不改写 Trellis 的正式任务状态
- 计划字段：从任务卡片或详情维护截止日期、里程碑和标签，只写 SQLite
- 组合视图：保存、复用和删除个人筛选条件
- 阻断依赖：从任务详情创建或解除，依赖与事件同事务写入 SQLite
- WIP 软上限：在流动信号面板设置 1–9，达到或超出只提醒，不阻止阶段操作

接口只允许操作 SQLite `repositories` 表中的白名单仓库；不提供任意路径读取。

主要源码入口：[server/index.js](./server/index.js)、[server/database.js](./server/database.js)、[server/repositories.js](./server/repositories.js)、[server/persistence.js](./server/persistence.js)、[server/watcher.js](./server/watcher.js)、[server/loader.js](./server/loader.js)、[server/scan-worker.js](./server/scan-worker.js)、[server/actions.js](./server/actions.js)、[public/app.js](./public/app.js)。

## 团队模式

最小启动步骤：

1. 准备 Node.js 24、Git、Python，并让服务账号能够通过 SSH 访问项目远端。
2. 设置 `TRELLIS_BOARD_MODE=team`、`TRELLIS_TEAM_PUBLIC_URL` 等环境变量。
3. 运行 `node server/team/cli.js init-admin --username admin` 创建首个管理员。
4. 启动服务，在 `/admin.html` 选择首个负责人、Trellis developer ID 和 Agent 工具，接入项目后确认脚本摘要并添加项目成员。
5. 安装 Windows 客户端，用服务器地址、账号和密码登录；在 Board 项目栏选择本地 Git 仓库关联。

团队任务由服务端工作副本创建或修改，只有 Git push 成功后才进入待接受状态。Agent 只执行
本地分支的 `fetch` 和 `ff-only` 同步，不会自动 stash、reset、checkout、rebase 或 push。

服务端项目工作副本只稀疏检出 `.trellis/`。目标分支尚无 `.trellis/` 时，服务端使用本地固定版本的
Trellis CLI 按页面所选 Agent 工具初始化，提交并推送后重新收敛为 `.trellis/` 工作区。

桌面客户端还会复用同一 watcher 监听已关联项目的 `.trellis/tasks`、`.trellis/workspace` 和
`.trellis/.developer`。未提交文本文件以文件级批次上传，服务端按到达顺序分配项目 revision，
通过 SSE 通知其他客户端，Board 以 750ms revision 轮询快速刷新。覆盖本地冲突前会备份到工作区外，
控制窗口可一键复原并把备份作为新的服务端 revision 广播。非任务责任人推进任务时必须选择取消、
继续推进或接管；项目 `read_only` 只接收，不上传本地修改。

## 插件

插件运行在独立子进程里，通过 NDJSON / JSON-RPC 与宿主通信；宿主不把插件代码加载进主进程。
仓库内置 `a2a-intake` 与 `acp-dispatch` 两个参考插件；业务插件建议放在本地，不随仓库分发。

1. 复制 `config/examples/plugins.json` 为运行数据目录中的 `plugins.json`。
2. 插件目录固定为 `plugins/<id>/`，必须有 `plugin.json`（`id`、`version`、`apiVersion`、`engines.board`）。
3. 敏感值推荐放在运行数据目录中的 `plugins.secrets.json`（复制 `config/examples/plugins.secrets.json`，
   并执行 `chmod 600`），配置里用 `secret:scope/key` 引用；也支持 `env:NAME`。
4. 明文敏感值仍会加载，但启动时告警；`/api/plugins` 只回显 `***`。secrets 文件不提供写入 API，
   手动编辑后重启生效；备份运行数据目录时注意其中包含密钥。

| 插件 | 作用 |
| --- | --- |
| `a2a-intake` | 提供 Agent Card 与 JSON-RPC `message/send`，把外部 A2A 消息变成 Trellis 任务 |
| `acp-dispatch` | 监听 `scan.completed`，把 `meta.agent` 匹配且 `in_progress` 的任务派给 ACP agent |

管理接口：`GET /api/plugins`、`POST /api/plugins/<id>/start|stop`、`GET /api/plugins/<id>/logs|runs|audit`；
前端入口在左侧导航「插件」。设置 `TRELLIS_PLUGINS_DISABLED=1` 可整体关闭。
内置插件的功能测试与 fixture 放在 `plugins/<id>/test/`，宿主级协议测试仍在 `tests/`。

插件默认没有沙箱：`acp-dispatch` 默认放行编辑与执行，只应在受信仓库、专用账号下启用。

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
- 自建账号、四类项目权限、可撤销会话和设备凭证
- 插件机制（子进程 JSON-RPC）、DB v5、`/api/plugins` 与前端插件页
- 服务端权威 Git 工作副本、任务创建/委派推送、版本冲突保护和审计
- 跨项目团队查询、单项目分组看板和个人保存视图
- Windows 用户级同步 Agent、配对、项目绑定、`ff-only` 同步和登录自启
- 团队实时未提交任务同步、服务端权威覆盖层、本地备份复原和非责任人确认

评论、通知、审批流、SSO、多实例高可用和 macOS/Linux Agent 不在当前范围内。
