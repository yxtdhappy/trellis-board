# 合并后任务归属与同步暂停纠正

## Goal

开发人员从基线分支 `dev` 拉出临时分支（如 `dev1`）创建并完成任务，再合并回 `dev` 后，
Board 应把该任务的有效归属纠正为 `dev`，同时保留 `dev1` 作为来源分支。只有尚未进入
`dev` `HEAD` 的 `dev1` 特有任务继续因分支不匹配而按任务暂停同步。

## Background / Confirmed Facts

- 当前任务归属只比较 `task.json.branch` 与 binding/taskSpace 分支。两者不同即暂停，没有检查任务
  是否已进入基线分支：[task_sync.rs](../../../apps/desktop/src-tauri/src/agent/task_sync.rs:1645)。
- 服务端写入边界也要求 `task.json.branch === taskSpace.branch_name`，否则拒绝整个任务目录：
  [task-snapshot-service.js](../../../apps/server/team/task-snapshot-service.js:357)。
- 既有设计明确把 `base_branch` 定义为 PR 目标而非同步归属，以避免未跟踪任务被错误上传：
  [design.md](../../archive/2026-11/11-12-fix-cross-branch-task-sync-conflict-flood/design.md:30)。
- 桌面端创建任务时，把当前 binding 分支同时写为 `base_branch`，因此现存任务的
  `base_branch` 不能单独证明真正的集成基线：
  [task_command.rs](../../../apps/desktop/src-tauri/src/agent/task_command.rs:389)。
- `D:\wit\mdp-backend-web` 当前检出 `dev`；活动与归档任务中恰有 17 个
  `task.json.branch != dev`，与截图中的“17 个任务因分支不匹配暂停”一致。
- 上述 17 个任务全部位于 `.trellis/tasks/archive/`，且其 `task.json` 全部存在于当前
  `dev` 的 Git `HEAD`，可确认它们已经随历史提交进入 `dev`。
- 这 17 个任务的来源包括 `feat/dbx-micro-app-integration`、`feat/trellis-board` 和若干
  `fix/*` 分支；来源分支仍应作为审计信息保留。
- 当前同步门禁已经是“按任务暂停”，其他归属明确的任务仍可同步；缺口是识别任务的已合入状态。
- `sync_project` 当前没有显式基线分支字段；本机 `mdp-backend-web` 最早创建的任务空间是 `dev`，
  随后是 `feat/trellis-board`，现有数据可以据此确定迁移基线。
- 本机 Team Board 数据库中，`mdp-backend-web` 当前有 96 个稳定任务 ID 同时存在于
  `dev` 和 `feat/trellis-board` taskSpace，证明默认视图去重和数据迁移是真实需求。
- Team 服务端没有项目 Git 工作副本，且运行规范禁止因任务同步启动 Git/Python 子进程：
  [architecture-and-runtime.md](../../../.trellis/spec/backend/architecture-and-runtime.md:77)。
- 本次明确采用“服务端暂不接入 Git”的边界。合入事实由绑定基线 taskSpace 的已批准 Agent
  读取本地 Git 后上报，服务端只验证身份、binding、字段一致性和证据结构。

## Terms

- 来源分支：`task.json.branch`，表示任务最初在哪个分支创建和开发，不自动覆盖。
- 基线分支：项目级固定分支，当前场景为 `dev`，用于判断任务是否已被集成。
- 有效归属：未合入基线时等于来源分支；已进入基线 `HEAD` 并完成基线快照接纳后等于基线分支。
- 合并证据：已批准基线 Agent 对“指定任务目录的 `task.json` 存在于指定完整 HEAD 提交”
  的结构化声明。MVP 只接受 `tracked-in-head` 类型。

## Requirements

### R1 分离来源分支与有效归属

- `task.json.branch` 继续表示任务来源分支，不在自动同步中直接覆盖。
- 系统计算独立的有效归属分支：任务未进入基线 `HEAD` 时等于来源分支；进入基线并完成接纳后
  等于基线分支。
- 有效归属只影响同步、Board 分组和分支可见性，不删除任务正文、审计或 Git 历史。
- 同一稳定任务 ID 在项目内只有一个默认可见副本，优先基线 taskSpace。

### R2 Agent 生成的最小合并证据

- MVP 只判定 `tracked-in-head`：基线 Agent 执行一次受限的
  `git ls-tree -r --name-only <HEAD> -- .trellis`，确认任务的 `taskDir/task.json` 在集合中。
- 证据至少包含任务 ID、任务目录、来源分支、基线分支、完整 HEAD SHA、证据类型和受控路径。
- Agent 必须是 active Agent，并持有目标基线 taskSpace 的 approved binding；上报分支必须同时等于
  binding、taskSpace 和项目基线分支。
- 服务端不执行 Git、不访问远端、不验证 HEAD 祖先关系；服务端校验证据字段与本次完整任务目录、
  `task.json`、项目和 taskSpace 一致。该证据属于受信 Agent 声明，不是服务端独立证明。
- 仅存在于当前工作区、仅被客户端从服务端拉取到工作区、或只合并源码而未提交任务目录，
  均不得生成 `tracked-in-head` 证据。
- 证据不足时保持暂停，不自动猜测，也不把 `base_branch` 相等直接视为已合入。

### R3 同步、创建与默认隐藏

- 在基线分支（当前场景为 `dev`）检出时，已确认进入基线 `HEAD` 的任务应可同步到基线
  taskSpace，不再计入“因分支不匹配暂停”。
- 在派生分支（如 `dev1`）检出时，未合入基线的任务仍可创建、编辑并作为该分支特有任务同步。
- 已合入任务不得继续作为派生分支的活跃归属：服务端拒绝来源 taskSpace 对该稳定任务 ID 后续写入，
  Board 默认查询隐藏来源旧副本。
- “暂停同步”只作用于任务，不禁用整个分支；“允许创建”表示非基线分支不会因存在基线而失去创建能力。
- 已合入任务在来源 taskSpace 的旧副本、快照、审计和文件均保留，不做物理删除。
- 按稳定任务 ID（任务索引中的 `execution_task_key`）判断来源副本是否已被基线当前快照接管，
  不按标题或目录名跨分支合并。
- 来源分支仍可追溯；UI 显示有效归属，并在不等于来源分支时补充来源信息。

### R4 服务端边界

- `sync_project` 持久化 `baseline_branch`；新项目首次接入的分支作为基线，已有项目迁移时优先选择
  最早创建的活动 taskSpace，平局以目录 ID 稳定排序。
- 基线 taskSpace 首次接纳来源分支不同的任务时，服务端要求完整合并证据，并在同一事务中写快照、
  证据和审计信息。
- 基线 taskSpace 已存在同一稳定任务 ID 时，后续普通上传直接按现有基线副本处理，不要求重复证据。
- 来源 taskSpace 一旦基线已有同一稳定任务 ID，拒绝新增、修改、归档移动或删除该任务副本。
- 普通 watcher、文件变化和普通同步不得触发服务端 Git 操作。

### R5 现有数据

- `mdp-backend-web` 当前已由 `dev` `HEAD` 跟踪的 17 个历史任务应在新规则上线后自动表现为
  `dev` 有效归属，不要求逐个人工处理。
- `mdp-backend-web` 当前跨 `dev` 与 `feat/trellis-board` 重复的 96 个稳定任务 ID，在基线索引存在
  同名稳定 ID 时，任务查询、项目计数和列表默认只展示基线 `dev` 副本。
- 来源分支信息必须保留；不自动删除旧 taskSpace、旧任务文件、冲突或审计记录。
- 基线字段迁移和 schema 升级必须可回滚到升级前备份，不重写现有任务正文。

### R6 性能与缓存

- 合入判断不得在每次 watcher 事件、文件变化或普通任务上传时执行 Git 全量扫描。
- Agent 仅在当前 binding 为基线且遇到 `task.json.branch != baseline` 的任务时读取 HEAD。
- Agent 按 binding、真实分支和完整 HEAD SHA 缓存受控 `.trellis` 路径集合；同一 HEAD 下多个任务
  只执行一次 `git ls-tree`。普通判断使用 HashSet 查找。
- HEAD 未变化时只允许一次轻量 `git rev-parse --verify HEAD^{commit}`；只有首次发现或 HEAD 变化时
  才刷新路径集合。
- 一次 HEAD 下发现多项已合入任务时共享同一集合；证据按任务分别提交，不重复扫描 Git tree。
- Agent 进程重启后允许按当前 HEAD 重新扫描一次，不持久化 Git tree 集合。
- 服务端只做 SQLite 索引查询和证据字段校验，不启动子进程；已存在基线副本时不重复要求证据。

## Acceptance Criteria

- [ ] `dev1` 中创建并合入 `dev` 的任务，在 `dev` 检出下不再显示为分支不匹配暂停。
- [ ] 上述任务在 Board 中显示有效归属 `dev`，同时可追溯到来源分支 `dev1`。
- [ ] 尚未进入 `dev` `HEAD` 的 `dev1` 特有任务仍只在 `dev1` 可同步，在 `dev` 下按任务暂停。
- [ ] `dev1` 仍可创建和同步未合入任务，不会因项目已有 `dev` 基线而被禁止创建。
- [ ] 已合入任务在 `dev1` 下不再作为 `dev1` 特有的活跃归属继续同步。
- [ ] 仅存在于工作区、未提交进 `dev` `HEAD` 的任务不会被自动归入 `dev`。
- [ ] `mdp-backend-web` 截图对应的 17 个归档任务不再触发“17 个任务因分支不匹配暂停”，并被识别为
  已合入 `dev` 的历史任务。
- [ ] 服务端拒绝缺少证据的来源分支任务写入基线，同时接受身份、分支、任务 ID、目录和受控路径均匹配的
  `tracked-in-head` 证据。
- [ ] 自动纠正不修改任务正文、不删除旧快照，也不修改或删除 Git 分支。
- [ ] 同一稳定任务 ID 同时存在于基线和来源 taskSpace 时，普通任务查询、项目计数和任务列表只展示
  基线副本；显式查看服务端快照仍可取得来源数据。
- [ ] 合入后的普通 watcher 事件和后续上传不会重复执行 `git ls-tree` 或服务端 Git 操作。
- [ ] 一次 HEAD 下发现多项已合入任务时，只执行一次 Git 路径扫描并共享缓存结果。

## Out of Scope

- 服务端 clone、fetch、merge-base、ls-tree 或任何其他项目 Git 访问。
- 自动执行 Git merge、rebase、cherry-pick 或删除来源分支。
- 合并不同分支上内容不同的任务正文。
- 自动删除来源 taskSpace 或历史任务快照。
- 仅依据分支名称、`base_branch` 或工作区文件存在性猜测合入关系。
- 管理端切换项目基线分支的 UI/API；MVP 固定首次接入或迁移得到的基线。
