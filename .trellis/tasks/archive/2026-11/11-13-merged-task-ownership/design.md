# 合并后任务归属技术设计

## 1. 方案摘要

项目增加显式基线分支。任务来源分支仍保存在 `task.json.branch`，有效归属由“基线 taskSpace
是否已有同一稳定任务 ID”决定。基线首次接纳来源分支不同的任务时，由绑定基线 taskSpace 的
已批准 Agent 提供一次 `tracked-in-head` 证据；服务端只验证证据与身份、任务目录和分支的一致性，
不执行 Git。

默认查询以 `execution_task_key` 去重：基线索引已有同一任务时，来源 taskSpace 的旧副本不进入
任务列表、分页、项目计数和筛选桶。旧快照仍保留，Agent 快照接口仍可读取。

## 2. 当前链路与缺口

当前上传链路：

1. Agent 读取本地完整任务目录。
2. Agent 用 `task.json.branch == binding.branchName` 判断是否可同步。
3. 服务端再次用 `task.json.branch == taskSpace.branchName` 拒绝不同分支。
4. 通过后按文件级 CAS 写入 taskSpace，再由索引服务投影 Board。

缺口是第 2、3 步都没有“该任务已经进入基线 HEAD”这一事实，导致 `dev` 中的历史 `dev1`
任务被永久视为错分支。仅放宽为“来源分支可以在任意 taskSpace 写入”会让未合入任务串分支，
因此必须同时增加基线、证据和来源旧副本去重。

## 3. 数据模型

### 3.1 `sync_project.baseline_branch`

在 `sync_project` 增加非空文本字段 `baseline_branch`。它是项目级同步归属基线，不是任务
`base_branch`：

- 新项目首次 attach 时把本次 `branchName` 写入 `baseline_branch`。
- 已有项目若字段为空，attach 时补齐为本次分支。
- v11 -> v12 迁移对已有项目优先选择最早创建的活动 taskSpace；没有活动 taskSpace 时选择最早创建的
  taskSpace；时间相同时按 taskSpace `id` 排序。
- MVP 不提供切换接口。迁移选择错误时恢复升级备份并由后续人工迁移处理，不在 watcher 中猜测。

### 3.2 `sync_task_merge_evidence`

只保存首次“基线 taskSpace 接纳来源分支任务”的证据：

```sql
CREATE TABLE sync_task_merge_evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES sync_project(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  execution_task_key TEXT NOT NULL,
  baseline_task_space_id TEXT NOT NULL REFERENCES sync_task_space(id) ON DELETE CASCADE,
  task_dir TEXT NOT NULL,
  tracked_path TEXT NOT NULL,
  source_branch_name TEXT NOT NULL,
  baseline_branch_name TEXT NOT NULL,
  evidence_type TEXT NOT NULL CHECK (evidence_type = 'tracked-in-head'),
  head_commit TEXT NOT NULL,
  source_agent_id TEXT REFERENCES agent_device(id) ON DELETE SET NULL,
  source_user_id TEXT REFERENCES user_account(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id, task_id)
);
```

Team 索引的 `execution_task_key` 格式是 `<taskSpaceId>::<task.json.id>`；证据表保存
`<projectId>::<task.json.id>` 作为项目级审计键，查询侧按 `project_id + task_id` 关联，避免混用
taskSpace 前缀。`tracked_path` 必须是 `<task_dir>/task.json`。

重复证据只允许匹配已存在的同一项目、任务 ID、基线 taskSpace、来源分支和基线分支；相同内容按
幂等重放处理，不新增行。冲突内容不覆盖首条证据。

### 3.3 索引去重键

跨 taskSpace 去重使用 `sync_task_index.execution_task_key`，不能使用 `task_key`：

- `task_key` 包含相对目录，活动目录和归档目录会不同。
- Team 的 `execution_task_key` 由 taskSpace ID 和稳定 `task.json.id` 生成；跨 taskSpace 比较时
  只取第一个 `::` 之后的稳定任务 ID 后缀。
- 同一 taskSpace 内的执行身份冲突仍沿用现有投影和错误提示，不在本次任务中合并两份正文。

## 4. Schema v12 与迁移

数据库版本从 11 升到 12：

1. 使用现有 `VACUUM INTO` 机制生成 `board.sqlite.pre-v12.*` 备份。
2. 为 `sync_project` 补 `baseline_branch TEXT NOT NULL DEFAULT ''`。
3. 创建 `sync_task_merge_evidence` 和索引：
   - `(baseline_task_space_id, task_id)`
   - `(project_id, execution_task_key)`
4. 为 `sync_task_space_file` 增加 `(task_space_id, task_id, deleted)` 索引，用于来源写入门禁。
5. 回填现有项目基线。
6. 写 schema version 12。

迁移不修改 `sync_task_space_file.content_text`，不删除 taskSpace、索引、冲突或审计。旧版本程序不能
直接读取 v12 数据库；应用级回滚必须恢复 pre-v12 备份。

## 5. Agent 协议

### 5.1 绑定字段

项目 public 结构增加 `baselineBranch`，taskSpace public 结构增加 `isBaseline`。Agent 本地
`AgentBinding` 增加可选 `baselineBranch`：

- attach 时从项目响应写入。
- heartbeat 的 binding 响应带回 `baselineBranch`，本地配置按服务端值更新。
- 旧配置缺少该字段时按 `None` 读取；新客户端连接旧服务端时无法生成证据，继续保持原有暂停行为，
  失败关闭。
- 本次只增加可选字段，不强制升级 Agent protocol v3。

### 5.2 `POST /changes` 的 `mergeEvidence`

基线首次接纳来源分支任务时可携带：

```json
{
  "version": 1,
  "type": "tracked-in-head",
  "taskId": "task-a",
  "taskDir": ".trellis/tasks/archive/2026-10/task-a",
  "trackedPath": ".trellis/tasks/archive/2026-10/task-a/task.json",
  "sourceBranch": "dev1",
  "baselineBranch": "dev",
  "headCommit": "0123456789abcdef0123456789abcdef01234567"
}
```

服务端校验：

- 当前调用者是 active Agent，且存在目标 taskSpace 的 approved binding。
- `observedBranchName`、binding、taskSpace 和项目 `baseline_branch` 全部等于 `dev`。
- `version === 1`、`type === "tracked-in-head"`。
- `headCommit` 是 40 或 64 位小写十六进制。
- 一个批次只有一个稳定任务 ID；`taskId` 等于完整任务目录中的 `task.json.id`。
- `taskDir`/`trackedPath` 等于本批实际写入或归档移动后的任务目录和 `task.json`。
- `sourceBranch` 等于 `task.json.branch`，`baselineBranch` 等于目标 taskSpace 分支。
- 证据只允许提交给基线 taskSpace，不允许来源 taskSpace 反向声明归属。

该结构只证明受信 Agent 声明“它在 `headCommit` 的 tree 中看到了 `trackedPath`”。服务端无法独立
验证这一步；安全边界依赖 Agent 凭证、设备绑定和审计，不把证据描述为服务端 Git 证明。

### 5.3 幂等与 pending

- `requestSha256` 纳入规范化后的 `mergeEvidence`。
- 同一 `batchId + clientSequence + files + mergeEvidence` 可重放原 revision。
- 同批次 ID 但证据不同按请求摘要冲突拒绝。
- Agent `PendingBatch` 持久化可选 `mergeEvidence`；重试必须发送原证据，不能根据最新 HEAD 改写。
- 证据校验和写入位于现有 `BEGIN IMMEDIATE` 事务内；CAS 冲突时不写证据行。

## 6. Agent 归属判断与缓存

### 6.1 判断顺序

对每个本地任务目录：

1. `task.json.branch == binding.branchName`：沿用当前逻辑，正常同步。
2. 分支不同，但 binding 不是项目基线：继续按 `TASK_BRANCH_OTHER` 暂停。
3. 分支不同，binding 是基线：读取当前完整 HEAD；若 `taskDir/task.json` 在 HEAD tree 中，
   标记为可同步并附带 `mergeEvidence`，否则暂停。
4. 服务端返回 `TASK_OWNED_BY_BASELINE`：来源 taskSpace 将该任务标记为基线所有，当前 Agent 进程内
   不再主动上传；切换 binding 或重启后允许重新确认一次。

普通同分支任务不读取 Git tree，不增加 watcher 开销。

### 6.2 HEAD tree 缓存

`TaskSync` 增加仅内存缓存：

```text
taskSpaceId -> {
  branchName,
  headCommit,
  trackedPaths: HashSet<String>
}
```

刷新规则：

- binding 撤销、替换分支或本地仓库路径变化时删除对应缓存。
- 有基线错分支任务时调用一次 `git rev-parse --verify HEAD^{commit}`。
- 若 `(binding, branch, headCommit)` 未变化，直接查 HashSet。
- 首次或 HEAD 变化时调用一次
  `git ls-tree -r --name-only <headCommit> -- .trellis`。
- 同一 HEAD 下 17 个候选任务共享一次扫描结果。
- 进程重启后重新扫描一次，不写磁盘缓存。

只缓存 `.trellis` 路径；不读取 blob 正文、不遍历 commit 历史、不执行 `merge-base`。

## 7. 服务端接纳与拒写

### 7.1 归属判定

`validateCompleteTaskGroups()` 改为返回稳定任务身份和来源分支，但不在其中直接做最终分支比较。
随后由 `validateTaskOwnership()` 在 CAS 前执行：

```text
targetBranch == baselineBranch:
  taskBranch == baselineBranch                  -> allow
  baseline already owns taskId                  -> allow
  valid mergeEvidence                           -> allow and persist evidence
  otherwise                                     -> 409 TASK_MERGE_EVIDENCE_REQUIRED

targetBranch != baselineBranch:
  taskBranch != targetBranch                    -> 409 TASK_OWNERSHIP_MISMATCH
  baseline already owns taskId or evidence      -> 409 TASK_OWNED_BY_BASELINE
  otherwise                                     -> allow
```

“baseline already owns taskId”查询基线 taskSpace 当前非删除的
`<task_dir>/task.json` 行，不读取 Git。来源 taskSpace 的新增、修改、归档移动和删除都受同一门禁。

### 7.2 原子写入

- 现有 CAS 成功后才写 `sync_task_merge_evidence`。
- 证据首次写入同时写一条 `audit_event`，动作名为 `task_merge_evidence_accepted`，详情只记录
  task ID、taskDir、headCommit、来源分支和基线 taskSpace。
- 文件和证据复用同一个 taskSpace revision 事务；失败整批回滚。
- 文件无变化但证据首次写入时返回 `noop=true`，允许证据落库但不增加 revision。
- 普通错误不创建 pending conflict；归属拒绝发生在 batch/conflict 写入前。

## 8. 查询去重与来源展示

任务查询的共享 SQL 条件增加：

```sql
AND NOT EXISTS (
  SELECT 1
  FROM sync_project p
  JOIN sync_task_space baseline
    ON baseline.project_id = p.id
   AND baseline.branch_name = p.baseline_branch
  JOIN sync_task_index baseline_task
    ON baseline_task.task_space_id = baseline.id
   AND baseline_task.execution_task_key = baseline.id || '::' ||
       substr(t.execution_task_key, instr(t.execution_task_key, '::') + 2)
  WHERE p.id = t.project_id
    AND baseline.id <> t.task_space_id
)
```

该条件进入 `queryTasks()` 的公共 `where`，因此`total`、assignees、筛选、分页和 `getBoard()` 的
项目计数保持一致。基线索引完成后，来源副本不再出现在默认任务查询。

证据表按 `project_id + task ID 后缀` 左连接，API 增加：

- `branchName`：有效归属，仍为 taskSpace 分支。
- `sourceBranchName`：证据来源分支；没有证据时等于 `branchName`。
- `sourceBranchName != branchName` 时，任务卡显示“分支 dev · 来源 dev1”。

显式 taskSpace 快照接口不应用查询去重，来源副本仍可由 Agent 拉取和审计。来源 taskSpace 的 Web
URL 若直接访问任务详情仍保留现有按 ID 查询语义；默认列表和计数不可见，写操作最终由服务端快照门禁拒绝。

## 9. API 与兼容性

新增字段均为 additive：

- project：`baselineBranch`
- taskSpace：`isBaseline`
- task query row：`sourceBranchName`
- heartbeat binding：`baselineBranch`
- changes request：可选 `mergeEvidence`

兼容策略：

- 新服务端 + 旧 Agent：旧 Agent 仍按来源分支判断，合入任务继续暂停；不会错误写入。
- 旧服务端 + 新 Agent：没有 baseline 字段时不生成证据，仍按旧规则暂停。
- 新服务端 + 新 Agent：启用完整纠正。
- v11 pending batch 没有 evidence 时继续原请求摘要重放；只有新生成的跨基线批次才携带证据。

## 10. 性能与资源边界

- 一次 `git ls-tree -r --name-only ... -- .trellis` 的代价与 `.trellis` 路径数线性相关，不与任务数相乘。
- 普通同分支任务、普通源码 watcher、pull 和 SSE 不触发 Git tree 扫描。
- 服务端不新增 Worker、队列、临时 Git 目录或远端访问；仅有 SQLite 索引查询。
- 默认查询多一个相关 `EXISTS`，使用 `sync_task_index(task_space_id, execution_task_key)` 索引。
- 证据只在基线首次接纳时写入；后续普通上传依靠基线已有任务 ID 快路径。

## 11. 风险与取舍

- 服务端不接 Git 时，恶意或被攻破的基线 Agent 可以伪造 `tracked-in-head`。本方案只适用于当前受信
  Agent 模型；要独立验真必须改为服务端 Git 镜像，超出本任务。
- 首次迁移以最早活动 taskSpace 作为基线。若历史项目首个 taskSpace 不是实际基线，迁移会选错；
  MVP 不自动猜测，也不提供切换 UI。
- 来源旧副本按“基线当前索引已有同稳定 ID”隐藏。基线索引尚未完成时会短暂继续显示来源副本，
  索引完成后自动收敛。
- 已合并任务若之后从基线快照删除，归属可能重新回到来源分支；删除/撤销合并语义不在本次范围内。
- Agent 每轮遇到错分支候选仍需一次轻量 HEAD 读取；只有完整 tree 扫描被严格缓存。
