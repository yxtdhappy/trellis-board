# Trellis Board

Trellis Board 提供两种运行模式：

- `standalone`：默认监听 `0.0.0.0`，扫描本机白名单仓库，适合本机或可信局域网使用。
- `team`：提供账号、项目权限、任务空间快照、实时同步、命令投递、审计和 Windows Agent。
  活动任务链路不 clone/fetch 项目 Git，也不保存项目 Git 凭据；只有后台归档同步会使用按来源隔离的
  只读凭据读取 `.trellis/tasks/archive/**`，不创建项目工作副本。

两种模式共用同一套任务推导、看板和 SQLite 代码。团队版的部署、升级、备份和故障处置见
[团队版运维手册](./docs/team-operations.md)。

## 仓库结构

项目是 yarn 3.5 workspaces monorepo：所有 workspace 包都在 `packages/` 下，插件和脚本保留在根。

```text
packages/
  server/         Node HTTP/SSE 服务、SQLite、任务扫描与 Team 快照（含 plugins 宿主与 SDK）
  web/            React + Vite 前端，构建产物写入 packages/server/public 与 packages/desktop/ui
  desktop/        Tauri v2 桌面客户端（Rust + 前端产物）
  shared/         服务端、Agent 与前端共用的纯 ESM 模块（含 zip 读取）
  test-support/   测试 harness、fixture 和插件 fixture
plugins/          随仓库分发的参考插件，插件 id 与目录名一致
scripts/          开发启动、容量检查、发布等脚本
docs/             运维与设计文档
```

依赖用 yarn 3.5 管理（`packageManager: yarn@3.5.0`，固定版本在 `.yarn/releases/yarn-3.5.0.cjs`），
只保留根 `yarn.lock`；`.yarn/cache/` 不入库。跨包引用统一使用 workspace 包名
（如 `@trellis-board/shared/slug.js`），由 yarn 在根 `node_modules` 建立符号链接解析；
被多个 workspace 共用的第三方依赖提升到根 `package.json` 声明。

常用命令：`yarn dev`、`yarn start`、`yarn build`、`yarn build:desktop`、`yarn test:all`、
`yarn desktop:build`、`yarn desktop:package`。

`yarn install` 会通过 lefthook 装好 git hook（写入 `.git/hooks/pre-commit`）；已经安装过依赖的仓库
更新到含本提交的版本后，如果 `.git/hooks/pre-commit` 不存在，执行一次 `yarn lefthook install` 即可
（yarn 3 在依赖未变时不会重跑 `postinstall`）。提交前 `lefthook.yml` 里的命令会格式化暂存文件
（oxfmt 处理前端/脚本，rustfmt 处理 `.rs`），未暂存改动不会被带进提交；换行符由 `.gitattributes`
统一为 LF；格式化失败会中止提交，需要绕过时用 `git commit --no-verify`。

## 启动

需要 Node.js 24 或更高版本，持久化使用 Node 内置的 `node:sqlite`。

```powershell
cd D:\workspace\wiki\trellis-board
yarn install
yarn start
```

打开 `http://127.0.0.1:4317`。也可以直接运行 `node packages/server/index.js`。

### `.env`

服务端启动时读取仓库根目录的 `.env`，与启动时的当前目录无关；`node packages/server/index.js`
和 `node packages/server/team/cli.js` 使用同一份文件。文件可选，不存在时静默跳过。已存在的进程环境
变量优先，`.env` 只补充缺失的键，因此 `PORT=4501 yarn start` 始终覆盖文件里的 `PORT`。

仓库根的 `.env` 已入库：首行 `node_version=24` 供 Jenkins 流水线读取并切换 Node 版本，其余键是团队版
运行默认值（`PORT=4317`、`TRELLIS_BOARD_MODE=team`、`TRELLIS_BOARD_DATA_DIR=`、
`TRELLIS_WATCH_DEBOUNCE_MS=400`），所以 `yarn start` 默认以团队模式启动。删掉或把
`TRELLIS_BOARD_MODE` 改成 `standalone` 即回到无鉴权模式；可用键见根目录 `.env.example`。
团队模式首次使用需先建系统管理员（见下）。

### Jenkins 部署

Jenkins 部署脚本读取 `.env` 的 `node_version` 切 Node，然后 `yarn install --immutable`、`yarn build`，
再用它自己的 Dockerfile 构建镜像并以 `yarn start` 启动容器；仓库不维护 Dockerfile。`yarn build` 产出
`packages/server/public`，运行数据由 `TRELLIS_BOARD_DATA_DIR` 指向的卷持久化，监听容器映射的 `PORT`。

前端开发用 `yarn dev`：并行启动 `node --watch packages/server/index.js`（服务端改动自动重启）和 Vite 开发服务器（页面 HMR），`/api` 由 Vite 代理到 `PORT` 指定的端口，默认 `http://127.0.0.1:4317`；5173 被占用时 Vite 会自动递增端口，以控制台打印的地址为准。

standalone 模式监听所有网络接口 `0.0.0.0`，且没有账号鉴权，只能用于可信网络。团队模式同样
监听所有接口，HTTP 和 HTTPS 均可使用。

standalone 页面先显示本地扫描缓存。服务启动后会监听白名单仓库的 `.trellis/tasks`、
`.trellis/workspace` 和 `.trellis/.developer`；相关文件变更会经过 400ms 防抖合并，再由独立
Worker Thread 重建缓存。前端通过 Board SSE `tasks.changed` 和页面 focus 触发 REST 对齐，不再
持续轮询任务 revision。

“重新扫描仓库”按钮仍保留，用于人工强制刷新。扫描期间如果文件再次变化，会在当前扫描结束后再跑一轮，避免最后一次变更丢失。`/api/board/status` 会返回监听状态、最近文件和刷新队列；防抖时间可通过 `TRELLIS_WATCH_DEBOUNCE_MS` 调整，最低 100ms。

文件监听使用 Node 的递归 `fs.watch`，当前实现面向 Windows/macOS 本机运行。Linux 或网络盘若不支持递归监听，需要改成每级目录监听或轮询，页面上的手动刷新仍可作为回退。

`.trellis/tasks` 和 `.trellis/workspace` 下的文件会参与 standalone 缓存更新，但只有当前看板实际
读取的任务文档、`task.json`、`implement.jsonl`、`check.jsonl`、workspace 索引和 journal 会改变展示结果。
Team 模式只监听和同步 `.trellis/tasks/**`；workspace、`.developer`、scripts、spec、config、workflow
和本机编码 Agent 目录都由客户端 Git 管理。

## 数据来源

- 任务实体：`.trellis/tasks/**/task.json`
- 任务阶段证据：`prd.md`、`design.md`、`implement.md`、`implementation-report.md`、`check-report.md`、`e2e-report.md`、`research/`、`implement.jsonl`、`check.jsonl`
- 父子任务：优先使用 `parent`/`children`；跨仓库兼容明确的 `meta.frontendTask`、`meta.backendTask`、`meta.childTask`、`meta.integrationTask`、`meta.uiTask` 及 `meta.*ParentTask`。其他普通 `meta` 路径只作为普通字段，不建立父子关系
- 归档状态：是否位于 `.trellis/tasks/archive/`
- standalone 项目成员：`.trellis/workspace/<developer>/`
- Team 项目成员：`sync_project_member.trellis_dev_id`
- Team 归档附件：`archive-snapshots/<taskSpaceId>/heads/<head>/files/<sha256>`

## 本地持久化

Board 运行数据不再写入源码目录。默认根目录为：

- Windows：`%LOCALAPPDATA%\TrellisBoard\server`
- macOS：`~/Library/Application Support/TrellisBoard/server`
- Linux：`${XDG_DATA_HOME:-~/.local/share}/TrellisBoard/server`

部署环境应通过 `TRELLIS_BOARD_DATA_DIR` 指向独立持久化目录；Ubuntu 服务建议使用
`/var/lib/trellis-board`。插件配置与日志放在独立的 `plugins` 目录（默认与 `server` 平级）：

- Windows：`%LOCALAPPDATA%\TrellisBoard\plugins`
- macOS：`~/Library/Application Support/TrellisBoard/plugins`
- Linux：`${XDG_DATA_HOME:-~/.local/share}/TrellisBoard/plugins`

可用 `TRELLIS_BOARD_PLUGINS_DIR` 覆盖；设置了 `TRELLIS_BOARD_DATA_DIR` 的部署环境退化为
`<运行数据目录>/plugins`。目录内固定为 `plugins.json`、`plugins.secrets.json`、`plugins.secrets.key`
与 `logs/<id>.log`。服务端主进程同时把日志写入
`<运行数据目录>/logs/` 下的 JSON 行文件；默认即 Windows 的
`%LOCALAPPDATA%\TrellisBoard\server\logs\server.1.log`。文件名带轮转序号，
单文件上限 `5 MiB`、最多保留 5 个文件（含正在写入的那个，序号随轮转递增）；正常退出会等待缓冲区落盘。
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
- `sync_project`、`sync_project_team_access`、`sync_project_member`：全局 Git 项目、团队访问和项目成员
- `sync_task_space`、`sync_task_space_file`、`sync_task_space_batch`：分支任务空间、当前 tasks 快照、
  删除墓碑、revision 和批次幂等
- `sync_active_agent`、`sync_agent_binding`、`sync_agent_cursor`：单账号活动 Agent、项目绑定和游标
- `sync_task_index`、`sync_task_command`：taskSpace 任务索引、创建/改派命令
- `sync_conflict`、`sync_conflict_backup`、`sync_file_audit`：CAS 冲突、覆盖备份和追加式文件审计
- `sync_archive_snapshot`、`sync_archive_file`、`sync_archive_file_history`：归档来源 HEAD、
  active/candidate 本地快照、当前文件元数据和不可变历史 fileId
- `sync_archive_git_credential`、`sync_archive_sync_config/state/log`：按来源隔离的只读凭据和同步状态
- `user_session`、`saved_view`、`user_board_state`：登录、保存视图和个人 WIP
- `audit_event`：团队审计
- `app_meta`：数据库 schema 版本和旧 JSON 迁移标记

全新数据库直接创建 schema v15。新 Team 链路只读写 `sync_*`、账号、团队、审计和执行扩展表；
旧 `team_project`、`project_live_*`、`agent_live_cursor`、`git_credential`、`git_ssh_known_host`
等表保留为人工回滚材料，但不在启动、项目接入、任务同步或命令链路中读取。
首次打开 standalone 空库时仍会在一个事务中读取 `repos.json`、`task-metadata.json`、
`scan-cache.json` 和 `board-state.json` 并导入，然后写入一次性的 `legacy_json_imported_v1` 标记。
Team 模式禁止导入本机默认仓库和旧 JSON。

v6-v14 数据库升级到 v15 前会在运行数据目录的 `backups/` 写入
`board.sqlite.pre-v15.*` 快照，再补齐缺失的 `sync_*` 表。旧账号、团队、项目、审计和旧表保持不变。
`v5` 及更旧版本仍拒绝启动，不能通过删除数据库代替迁移。Team runtime 还会每 24 小时创建
`board.sqlite.snapshot.*`，保留最近 7 份。

SQLite 使用 WAL 模式。standalone 主线程和扫描 Worker 各自持有连接；Team 快照提交、索引投影和命令状态
都使用事务和条件更新。旧项目 `git-credentials.key` 不再使用；配置归档 Git 凭据时会生成独立的
`archive-git-credentials.key`。热备份前应先停止服务，并同时处理可能存在的 `board.sqlite-wal`、
`board.sqlite-shm`、`archive-snapshots/` 和归档凭据密钥。

回滚到旧版 Board 时，先停止服务并归档当前运行数据目录（插件配置与日志在
`<TrellisBoard>/plugins`，默认配置下与 `server` 平级，需要一并归档），再切换到旧代码和旧库备份。旧版不解释
`sync_*` 数据；Team 已提交的活动任务和归档快照不会自动写回客户端 Git。v15 本地快照在回滚时保留，
不要手工删除 `archive-snapshots/`。详细步骤见
[团队版运维手册](./docs/team-operations.md)。

## 重要限制

看板推导的是“可证实的流程位置”。它读取 `task.json.status`、实施报告、检查报告和任务产物，而不是只看任务是否仍在 `planning`。E2E 是可选的补充证据：只接受 `e2e-report.md`、`check-report.md` 或 `implementation-report.md` 中明确记录的执行结果，`implement.md` 里的计划、条件句和“下一步做 E2E”不会计为完成；缺少 E2E 不阻塞规范回写和工作提交。进度百分比只统计 12 个必需阶段，但 13 个阶段（含可选的 E2E）仍全部显示。父任务缺少开发事件时，只在所有子任务都有实现/检查证据后继承对应阶段。Trellis 没有持久化 review、lint、E2E、spec 回写和 journal 的每一步事件，因此没有证据的阶段仍显示“待人工确认”。看板可以把人工确认持久化到 SQLite 的 `task_stage` 表，不会伪造 `task.json` 状态。

计划字段、标签、保存视图、依赖和事件属于 Board 本地增强，不写回目标仓库的 `task.json`。阶段事件从功能启用后开始记录；旧任务不会按文件修改时间补造历史。任务用稳定的 `executionTaskKey` 关联扩展数据，归档导致相对路径变化后数据仍可读回。

流程语义与 Trellis 实际归档顺序一致：`in_progress` 状态从启动持续到归档，开发工作提交发生在归档之前，`finish-work` 再原子地把任务标记为 completed 并移入 `archive/`。因此“收尾”表示工作提交到归档之间的活动队列；归档任务只进入历史索引，不会继续显示为收尾中的任务。归档后追加的 journal 是后续会话记录，不反向改变任务状态。

关系解析会报告引用缺失、自引用、同一子任务存在多个父任务和父子循环；出现关系异常时，父任务停止继承子任务阶段，详情页会显示具体原因。归档后的任务也可以被归档前留下的绝对任务路径唯一解析到。

同一任务组在流程视图中显示为父任务卡片和子任务列表，也可以跨仓库归组。当前一组示例是 `mdp-backend-service` 的父任务、后端子任务和 `mdp-backend-web` 的前端子任务；父子关系来自 `parent`、`children` 和 `meta.frontendTask`，不改写业务仓库里的任务文件。

`prd.md`、`design.md`、`implement.md`、`implementation-report.md`、`check-report.md`、`e2e-report.md` 的详情预览会截断到每个文件 40,000 字符；完整文件仍在仓库中。阶段判断读取原文件，不受预览截断影响。

自动刷新仍会重新扫描全部白名单仓库，而不是只扫描发生变更的仓库。这样能正确重算跨仓库父子任务和父任务阶段继承；代价是每次有效变更后仍有约 8–15 秒的后台扫描。扫描期间再次变化会排队，并在本轮结束后再扫描一次。

## Standalone 写操作

- 创建任务：调用目标仓库自己的 `.trellis/scripts/task.py create --no-start`
- 派发任务：更新指定任务的 `task.json.assignee`
- 流程勾选：只写入看板数据库，不改写 Trellis 的正式任务状态
- 计划字段：从任务卡片或详情维护截止日期、里程碑和标签，只写 SQLite
- 组合视图：保存、复用和删除个人筛选条件
- 阻断依赖：从任务详情创建或解除，依赖与事件同事务写入 SQLite
- WIP 软上限：在流动信号面板设置 1–9，达到或超出只提醒，不阻止阶段操作

接口只允许操作 SQLite `repositories` 表中的白名单仓库；不提供任意路径读取。

主要源码入口：[packages/server/index.js](./packages/server/index.js)、[packages/server/database.js](./packages/server/database.js)、[packages/server/repositories.js](./packages/server/repositories.js)、[packages/server/persistence.js](./packages/server/persistence.js)、[packages/server/watcher.js](./packages/server/watcher.js)、[packages/server/loader.js](./packages/server/loader.js)、[packages/server/scan-worker.js](./packages/server/scan-worker.js)、[packages/server/actions.js](./packages/server/actions.js)、[packages/web/src/main.tsx](./packages/web/src/main.tsx)。

## 团队模式

最小启动步骤：

1. 准备 Node.js 24 和独立运行数据目录；Team 服务端不需要项目 Git、Git 凭据或 Python。
2. 设置 `TRELLIS_BOARD_MODE=team`、`TRELLIS_BOARD_DATA_DIR`，需要时设置 `PORT` 和本地 Git 远端开关。
3. 运行 `node packages/server/team/cli.js init-admin --username admin` 创建首个管理员。
4. 启动服务，在 `/admin.html` 创建团队和用户。
5. 安装 Windows 客户端，用服务器地址、账号和密码登录；项目由客户端选择本地 Git 仓库后接入。

项目身份是规范化 Git 远端，任务空间身份是“远端 + 分支”。同一远端同分支在服务端全局唯一；
不同分支拥有独立的 `.trellis/tasks` 快照、revision、cursor、索引和命令。
同一 Agent 的同一本地仓库只能绑定一个分支；切换分支时必须确认替换旧 binding。需要同时同步多个
分支时，请为每个分支使用独立 Git worktree。

客户端接入流程：

1. 选择 Git 仓库根目录，校验 origin、当前分支和 `.trellis/tasks`。
2. 缺少 Trellis 时选择本机编码 Agent，由安装包内固定 runtime 初始化；不会自动 commit/push。
3. 用户手动提交并推送后，客户端比较本地 HEAD 与远端分支，确认首次推送成功。
4. 选择 owner team 和 Trellis developer ID；同一仓库已有其他分支时确认替换，再建立 Agent binding。

Team 同步只覆盖 `.trellis/tasks/**`：

- 客户端 watcher 以完整任务目录为原子单位上传；
- 每个文件携带 `baseSha256`，任一文件基线变化时整批返回 `TASK_FILE_CONFLICT`；
- 服务端保存当前快照、删除墓碑、revision、冲突备份和审计；
- 其他客户端通过 SSE 和 cursor 拉取，在完整目录原子应用后推进 cursor；
- scripts、spec、config、workflow、agents、workspace 和 `.developer` 不由 Team 同步，继续由 Git 管理。

Web 创建带负责人的任务或改派时，服务端只向目标用户唯一在线 Agent 下发命令。Agent 在本地执行
`task.py create` 或原子修改 `task.json.assignee`，再走同一 CAS 链上传；正式任务只在快照投影后出现。
目标 Agent 离线、未绑定、非项目写成员或项目停用时会直接拒绝，不创建临时任务卡。

任务同步会在首次接入、上传、拉取、watcher、pending retry 和冲突处理前校验真实 Git 分支。分支与
binding 不一致时暂停该仓库同步，不写任务目录、不上传、不推进 cursor；切回绑定分支后自动重新校验。
客户端不会自动 checkout、switch 或修复外部切换造成的任务差异。

## 插件

插件运行在独立子进程里，通过 NDJSON / JSON-RPC 与宿主通信；宿主不把插件代码加载进主进程。
仓库内置 `a2a-intake` 与 `acp-dispatch` 两个参考插件；业务插件建议放在本地，不随仓库分发。

1. 复制 `config/examples/plugins.json` 为插件配置目录中的 `plugins.json`（默认
   `<用户数据根>/plugins/plugins.json`，见「本地持久化」）。
2. 插件目录固定为 `plugins/<id>/`，必须有 `plugin.json`（`id`、`version`、`apiVersion`、`engines.board`）。
   入口按 `./plugins/<id>/<sub>` 解析：先找 `<插件配置目录>/<id>/<sub>`，不存在再回落安装目录，
   因此私有插件可以只放在用户目录，不改安装目录。
3. 敏感值推荐放在同一插件配置目录中的 `plugins.secrets.json`（复制 `config/examples/plugins.secrets.json`，
   并执行 `chmod 600`），配置里用 `secret:scope/key` 引用；也支持 `env:NAME`。
4. 明文敏感值仍会加载，但启动时告警；`/api/plugins` 只回显 `***`。secrets 文件不提供写入 API，
   手动编辑后重启生效；备份插件配置目录时注意其中包含密钥。

| 插件 | 作用 |
| --- | --- |
| `a2a-intake` | 提供 Agent Card 与 JSON-RPC `message/send`，把外部 A2A 消息变成 Trellis 任务 |
| `acp-dispatch` | 监听 `scan.completed`，把 `meta.agent` 匹配且 `in_progress` 的任务派给 ACP agent |

管理接口：`GET /api/plugins`、`POST /api/plugins/<id>/start|stop`、`GET /api/plugins/<id>/logs|runs|audit`；
前端入口在左侧导航「插件」。设置 `TRELLIS_PLUGINS_DISABLED=1` 可整体关闭。
内置插件的功能测试与 fixture 放在 `plugins/<id>/test/`，宿主级协议测试在 `packages/server/test/`；
`yarn test` 默认只跑 workspace 测试，插件测试用 `yarn test:plugins`。

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
- Team tasks-only 快照、文件级 CAS、删除墓碑、归档移动、冲突备份和审计
- Web 创建/改派命令仅投递给唯一在线 Agent，正式任务由客户端本地 `task.py` 产生
- 跨项目团队查询、单项目分组看板和个人保存视图
- Windows 用户级同步 Agent，客户端 Git 项目预检、固定 Trellis runtime 初始化和首次推送确认
- 客户端任务目录原子应用、cursor/pending batch 恢复、冲突差异/覆盖/保存副本和分支风险提示

评论、通知、审批流、SSO、多实例高可用和 macOS/Linux Agent 不在当前范围内。
