# 实施计划

## 1. 前置约束

- 当前任务仍为 `planning`；用户明确批准最终规划后才能执行 `task.py start` 和修改产品代码。
- 当前工作区已有用户修改：
  - `apps/desktop/src-tauri/src/agent/protocol.rs`
  - `apps/desktop/src-tauri/src/agent/task_command.rs`
  - 未跟踪任务 `11-13-branch-retirement-lifecycle`
  - 未跟踪任务 `11-13-optimize-task-sync-path-validation`

  编辑前先读取现有 diff；只叠加本任务所需行，不回滚、不格式化、不修改其他任务。
- 开发阶段不执行构建。全部代码和单测完成后只执行一次最终编译/构建验证。
- 不提交、不推送、不改写 Git 历史，除非用户另行明确要求。
- Team 服务端始终不启动项目 Git/Python 子进程。

## 2. 实施顺序

### Step 1：Schema v12、备份和基线回填

目标：数据库能显式保存项目基线，并且旧库可确定性迁移。

文件：

- `apps/server/database.js`
- `apps/server/test/database-v12.test.js`

改动：

- 将 `DATABASE_SCHEMA_VERSION` 从 11 升到 12，并接受 v11 升级。
- 为 `sync_project` 增加 `baseline_branch`。
- 创建 `sync_task_merge_evidence`、相关索引和
  `sync_task_space_file(task_space_id, task_id, deleted)` 索引。
- 回填已有项目：最早活动 taskSpace 优先，否则最早 taskSpace；以 `created_at, id` 稳定排序。
- 确保升级前写入 `board.sqlite.pre-v12.*` 备份。
- 迁移重复执行必须幂等，不修改任务正文、旧 taskSpace 或历史审计。

验证：

- v11 fixture 升级后字段、表、索引和 schema version 正确。
- 有多个活动/停用 taskSpace 时基线选择符合规则。
- 无 taskSpace 项目保持空基线，首次 attach 后补齐。
- 二次启动无额外表结构或数据变化。

### Step 2：服务端项目与 taskSpace 公开字段

目标：Agent 和 Web 能知道项目基线及哪个 taskSpace 是基线。

文件：

- `apps/server/team/task-space-service.js`
- `apps/server/team/sync-agent-service.js`
- `apps/server/team/http.js`（仅在响应装配需要时）
- `apps/server/test/team-task-spaces.test.js`
- `apps/server/test/team-agent-slot.test.js`

改动：

- 新建 `sync_project` 时写入 `baseline_branch = branchName`。
- 已有项目字段为空时，attach 写入本次 branch。
- `projectPublic()` 返回 `baselineBranch`。
- taskSpace public 返回 `isBaseline = branchName === baselineBranch`。
- heartbeat binding 返回 `baselineBranch`。
- `taskOwnership()` 的 `projectTaskSpaces` 带 `isBaseline`。
- 保持旧客户端缺字段兼容，不强制升级 protocol version。

验证：

- 新项目首次分支成为基线。
- 第二分支 attach 后 `isBaseline` 只有第一分支为 true。
- heartbeat 返回基线字段，旧请求/响应 fixture 不破坏。

### Step 3：服务端合并证据与归属门禁

目标：基线可接纳来源分支任务；来源 taskSpace 不能继续写已被基线接管的任务。

文件：

- `apps/server/team/task-snapshot-service.js`
- `apps/server/test/team-task-snapshot.test.js`
- `apps/server/test/team-gitless-http.test.js`

改动：

- 增加 `normalizeMergeEvidence()`，校验版本、类型、40/64 位小写 HEAD SHA、task ID、目录、
  trackedPath、来源分支和基线分支。
- `validateCompleteTaskGroups()` 返回 `taskId/taskBranch/taskDirs`，分支归属改由后续共享门禁决定。
- 增加基线拥有判断：查询基线 taskSpace 当前非删除 `task.json` 行。
- baseline target 的分支不同任务：已有基线副本则允许；否则要求有效 evidence。
- 非 baseline target：来源分支必须等于目标；基线已有同任务 ID 或已有证据时返回
  `409 TASK_OWNED_BY_BASELINE`。
- ownership 拒绝发生在 batch/conflict 写入前。
- `requestSha256` 纳入 evidence；同 batch 重放保持幂等。
- CAS 成功后在同一事务写证据；首次证据写 `audit_event`。
- 文件 noop 但首次证据有效时允许证据落库，返回 `noop=true`，不增加 revision。

验证：

- 有效证据首次写入基线成功。
- 缺证据、错 task ID、错 taskDir、错 source/baseline、错 HEAD 格式、来源 taskSpace 声明均拒绝。
- CAS 冲突不写证据或 audit。
- 已有基线副本时不要求重复 evidence。
- 来源 taskSpace 修改、移动、删除均被拒绝。
- 相同 batch/evidence 幂等，变更 evidence 后同 batch 冲突。
- 请求处理中无 Git/Python 子进程。

### Step 4：稳定任务 ID 去重与来源分支展示

目标：默认只显示基线副本，计数一致，并显示来源分支。

文件：

- `apps/server/team/task-space-index.js`
- `apps/server/team/gitless-board-service.js`（仅在详情字段装配需要时）
- `apps/server/test/team-task-index-v10.test.js`
- `apps/server/test/team-gitless-http.test.js`

改动：

- `queryTasks()` 的公共 `where` 增加基线 `EXISTS` 去重，比较
  `execution_task_key`，不比较目录型 `task_key`。
- 去重条件同时覆盖 `total`、assignees、筛选、分页和 `getBoard()` 项目计数。
- `LEFT JOIN sync_task_merge_evidence`，public row 增加 `sourceBranchName`；无证据时回退到
  taskSpace `branchName`。
- 保持 `branchName` 表示有效归属taskSpace，不改变现有筛选语义。
- 来源 taskSpace、归档目录和基线进度 `indexing` 的旧 fixture 继续可读。

验证：

- 同一稳定 ID 在基线和来源都存在时，列表只返回基线行。
- 活动/归档目录名不同仍按 `execution_task_key` 去重。
- `total`、assignee facet、分页和 project count 不重复。
- 基线与来源内容不同也优先基线，不合并正文。
- 来源快照接口仍返回旧副本。
- `sourceBranchName` 在有/无证据及同分支时正确。

### Step 5：桌面 binding 与心跳传递基线

目标：TaskSync 能判断当前 binding 是否为基线，不需要额外网络/ Git 查询。

文件：

- `apps/desktop/src-tauri/src/agent/store.rs`
- `apps/desktop/src-tauri/src/agent/protocol.rs`
- `apps/desktop/src-tauri/src/agent/onboarding.rs`
- `apps/desktop/src-tauri/src/agent/runtime.rs`
- `apps/desktop/src-tauri/src/agent/detach.rs`
- 对应 Rust `mod tests`

改动：

- `AgentBinding` 增加 `#[serde(default)] baseline_branch: Option<String>`。
- 持久化读取/写入校验可选分支名。
- attach project 响应解析 `baselineBranch` 并写入新 binding。
- heartbeat `ServerBinding` 解析 `baselineBranch`；同 `localRepoKey` 时更新本地 binding，
  分支/repo 不匹配时仍保留现有门禁。
- 所有测试 binding 构造器补字段，旧配置缺字段按 `None`。

验证：

- 新 binding 写入基线。
- heartbeat 更新基线并可持久化。
- 旧 JSON 无字段可读取。
- detach、binding 替换和错误分支保护不回退字段。

### Step 6：Agent HEAD tree 缓存与证据生成

目标：只在基线错分支候选出现时扫描一次 Git tree，并只给首次接纳批次附证据。

文件：

- `apps/desktop/src-tauri/src/agent/task_sync.rs`
- `apps/desktop/src-tauri/src/agent/git.rs`（仅在复用转换需要时）
- `apps/desktop/src-tauri/src/agent/task_sync.rs` 内单元测试

改动：

- `TaskSync` 增加内存 `head_tree_cache`，键为 taskSpace，值为 branch/head/HashSet。
- `resolve_task_ownership()` 先处理同分支；仅 binding 为基线且任务 branch 不同时读取 HEAD。
- HEAD 未变查缓存；首次或变化时调用一次 `git::ls_tree(..., Some(head))`。
- 集合含 `<taskDir>/task.json` 时把任务加入 syncable 并生成 evidence；否则继续 paused。
- `OwnershipResolution` 携带按 taskDir 索引的 evidence。
- `PendingBatch` 增加可选 `mergeEvidence`，cursor 持久化并在 retry 原样发送。
- `POST /changes` payload 携带 evidence；只有对应任务批次携带。
- 服务端 `TASK_OWNED_BY_BASELINE` 返回后，在内存将任务标记为 baseline-owned，后续 watcher 不重复上传；
  binding 变化/进程重启后可重新确认。
- 普通同分支任务不得调用 `git::head_commit` 或 `git::ls_tree`。

验证：

- 17 个同 HEAD 错分支任务只调用一次 `ls_tree`。
- HEAD 变化后只重新扫描一次；同 HEAD 普通事件不再扫描。
- 同分支任务不扫描 Git。
- 未跟踪的错分支任务保持 paused。
- 证据随 pending 原样重试；HEAD 后续变化不改写旧 pending。
- 多任务共享扫描结果、证据字段互不串用。

### Step 7：Web 展示有效归属与来源

目标：用户能看懂“分支 dev · 来源 dev1”，默认不再看到来源重复卡。

文件：

- `apps/web/src/api/board.ts`
- `apps/web/src/api/admin.ts`
- `apps/web/src/features/board/task-view.ts`
- `apps/web/src/features/board/TaskCard.tsx`
- `apps/web/src/features/board/TeamView.tsx`
- `apps/web/src/features/board/ArchiveView.tsx`
- `apps/web/src/features/board/AttentionQueue.tsx`（仅共用 label 需要时）

改动：

- 类型增加 project `baselineBranch`、taskSpace `isBaseline`、task `sourceBranchName`。
- `teamRowToBoardTask()` 规范化 `sourceBranchName`。
- 卡片只在 `sourceBranchName !== branchName` 时显示来源，避免普通任务重复文案。
- 不新增基线切换控件；默认列表由服务端去重保证唯一。

验证：

- dev1 来源任务在 dev 视图中显示“分支 dev · 来源 dev1”。
- 普通 dev 任务只显示一次分支。
- 窄屏不因来源文案溢出。
- 创建任务弹层和分支监听行为不变。

### Step 8：规范与任务产物同步

文件：

- `.trellis/spec/backend/desktop-realtime-sync.md`
- `.trellis/spec/backend/task-ownership-and-conflict-idempotency.md`
- `.trellis/spec/backend/architecture-and-runtime.md`
- `.trellis/spec/frontend/rendering-and-state.md`

更新内容：

- schema v12、baseline branch、evidence 请求、来源写入门禁、默认去重。
- 明确 Team 服务端不接 Git 和证据信任边界。
- 明确 HEAD tree 缓存和禁用每事件扫描。
- 记录来源分支 UI 字段。

## 3. 关键测试矩阵

| 场景 | 预期 |
| --- | --- |
| dev Agent 发现 `task.json.branch=dev1` 且 task.json 在 dev HEAD | 附 tracked-in-head 证据写入 dev |
| dev Agent 发现 dev1 任务只在工作区 | 暂停，不上传 |
| 同 HEAD 17 个候选 | 一次 ls-tree、17 次 HashSet 查询 |
| 普通 dev 任务同步 | 不读取 HEAD tree |
| HEAD 变化 | 重扫一次，使用新 SHA |
| 基线已有同任务 ID | 普通上传不要求重复证据 |
| 来源 taskSpace 再写同任务 ID | `TASK_OWNED_BY_BASELINE` |
| 来源 taskSpace 删除旧副本 | 拒绝，旧快照保留 |
| 同一 execution_task_key 跨 taskSpace | 默认只查基线 |
| 同标题不同 task ID | 不去重 |
| 同目录不同 task ID | 继续按现有身份冲突处理 |
| 证据字段任一项不一致 | 整批拒绝，无 batch/conflict/证据写入 |
| v11 升级 | 有 pre-v12 备份，旧数据不丢 |
| 服务端处理同步 | 不创建 Git/Python 子进程 |

## 4. 最终验证命令

开发过程中只运行针对性测试，不跑构建。全部代码完成后按以下顺序执行一次：

```powershell
npm test
npm run lint --workspace @trellis-board/web
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
npm run build
```

若失败，只修复本任务引起的失败；用户已有脏文件和无关失败保持原状并记录。修复后再次执行对应门禁。

真实数据验收使用复制后的 Team Board 数据库和 `D:\wit\mdp-backend-web`：

1. 确认数据库备份存在，不在生产库直接试错。
2. 验证迁移后 `mdp-backend-web.baseline_branch = dev`。
3. 在 dev checkout 启动新 Agent，确认 17 个归档任务不再计入暂停。
4. 确认 Board 只显示 17 个 dev 副本，来源分支仍可追溯。
5. 对未合入 dev 的主动 dev1 任务验证仍暂停。
6. 观察一次同步只发生一次 dev HEAD tree 扫描；后续 watcher 不重复扫描。

## 5. 回滚点

- Schema 升级前：`backups/board.sqlite.pre-v12.*`。
- 产品代码：按本任务 diff 反向撤销，不触碰其他用户改动。
- 数据：证据表、baseline 字段和来源索引均为增量；回滚代码时恢复 pre-v12 数据库，避免旧版本读取
  schema 12。
- Git：不自动删除/改写任何分支或提交。
