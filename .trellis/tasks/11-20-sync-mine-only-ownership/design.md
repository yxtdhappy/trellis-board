# 设计：同步只处理本人任务

## 现状链路（读码确认）

首同步（binding `initialSyncMode=review`）：

```
pull_initial_sync (initial_sync.rs:237-470)
  → local_groups(None)            → ownership_inbox.rs:38-47 → local_files → read_local_task_snapshot_files
  → fetch snapshot（服务端已按 visibleTaskIds 裁剪）
  → classify_task_snapshots(shared/task-snapshot.js:250-343)
  → gate_local_only_differences   → 每个 LocalOnly 调 GET /files 探针：403→readonly+剔除，409→剔除，404/其他→保留
  → 存在非 Same → emit initial_sync_review，pendingReview=true，不写 cursor
```

常态同步：

```
pull_live_sync (pull.rs:440-600)
  → local_sync_state (pull.rs:225-290) → local_metadata_groups（ownership index，无 task.json 正文）
    → cursor.rs:64-127 local_sync_state_from_groups：无基线且本地非空 = dirty
  → 过滤 inactive_control_dirs + readonly_task_dirs → upload_directories
  → apply.js:59-215：validateTaskOwnership → assertUploadAllowed(agent, taskSpaceId, complete, input)
      → uploads.js:39-40 起：row 不存在直接 return { task: null, lease: null }（无归属校验）
  → commitUpload (uploads.js:135-186)：resolveAssignee(task.json) + insertTaskFromUpload（非本人写 stage='pending'）
```

结论：他人任务既不会被过滤，服务端也愿意替它建行。

## 决策

### 决策 1：在客户端本地分组（group）层过滤，而不是在探针结果层

11-19 的做法是「先分类出差异，再用服务端 403 反证归属」。问题是 404 分不清「服务端没有」和「不是我的」，因为任务空间快照被 `visibleTaskIds` 裁掉了（`packages/server/team/snapshot/views.js:16-21`）。

本次改成**先判归属，再分类**：客户端本来就持有 `task.json` 全文（`read_local_task_snapshot_files` 读盘），owner 字段就在里面。命中「不是我的」直接不进差异集合，也不发探针——探针从"每个 LocalOnly 目录一次"降到"仅确实无归属信息的目录"。

选 group 层而不是 file 层的理由：`local_groups` 是 `initial_sync.rs`(6 处)、`upload.rs`(2)、`pull.rs`(2)、`conflict.rs`(5)、`ownership_inbox.rs`(2)、`sync_api.rs`(2)、`handoff` 的共同上游；file 层还有 `handoff.rs:722`、`pull.rs:88` 两个「命令驱动、目标目录已知属于我」的调用点，过滤它们会误伤改派落地的写入。

### 决策 2：owner 取 assignee 优先、creator 回退；读不到信息一律 fail open

```rust
owner = task.json.assignee.trim() 非空 ? assignee : task.json.creator
```

- `assignee == 本机 developer id`（大小写不敏感）→ 我的。
- 本地任务控制状态里该目录存在且 `state.is_writable_local()`（`task_control.rs:47-53` = `materialized | claimed | pending_delivery`）→ 我的。这条覆盖「服务端改派给我、命令已下发、`task.json` 还没同步更新」的窗口。
- `owner` 为空 / `task.json` 缺失 / JSON 解析失败 / 拿不到本机 developer id → 保留（不丢弃）。

最后一条很重要：客户端的 owner 判定是**范围收缩**，不是访问控制。宁可多同步一个目录由服务端 409 兜住，也不能因为本地信息不全把用户自己的任务静默吞掉。

### 决策 3：本机 developer id 复用既有解析函数

不新写解析逻辑，直接复用 `packages/desktop/src-tauri/src/agent/worktree/discovery.rs:203-228`：

```rust
pub async fn developer_id(worktree: &Path, config: &AgentConfig, remote_identity_key: &str) -> Option<String>
```

它依次尝试 `<repo>/.trellis/.developer` 的 `name=`、同 `remoteIdentityKey` 的其他已批准 binding 仓库、最后回退 `config.username`。

该函数所在模块在 `agent/worktree/mod.rs:1` 是 `mod discovery;`（私有），需要在 `worktree/mod.rs` 加 `pub(crate) use discovery::developer_id;` 才能从 `task_sync` 调用。

`TaskSync` 只有 `store: Arc<ConfigStore>`（`task_sync.rs:85`），没有缓存 config，因此过滤时需要 `self.store.read_config(true).await`。按每轮同步一次级别的成本记账：config 是几百字节 JSON，可接受；**不加缓存**（`AgentBinding` 不持久化 developer id，加缓存要处理 `.developer` 变更失效，不值得）。

### 决策 4：服务端新建校验在 `assertUploadAllowed` 的 `!row` 分支补一人判定

`assertUploadAllowed` 现在拿不到 `files`（`apply.js:103` 只传 `complete` + `input`）。改成显式第 5 参：

```js
taskControl?.assertUploadAllowed(agent, taskSpaceId, complete, input, {
  files,
  projectId: space.project_id,
})
```

`!row` 分支：

```js
if (!row) {
  const { document } = documentForUpload(taskSpaceId, complete.taskDir, files ?? [])
  const assignee = tasks.resolveAssignee(projectId, document, agent.userId)
  if (assignee.userId !== agent.userId) {
    throw teamError(403, 'TASK_WRITE_FORBIDDEN', '任务负责人不是本机用户，不能新建任务', {
      details: { taskId: complete.taskId, assigneeUserId: assignee.userId },
    })
  }
  return { task: null, lease: null }
}
```

- `documentForUpload`（`uploads.js:9-38`）已经把本次上传的 `task.json` 与库内已有文件合并成完整文档，正好是「上传后的真实任务状态」。
- `resolveAssignee`（`packages/server/team/task-control/tasks.js:16-33`）在 devId 无法匹配成员时回退到 `agent.userId` → R4 的 fail open 天然成立（`task.json` 缺 assignee 不会被拒）。
- 用 **403** 而不是 409：客户端 `is_foreign_task_error`（`errors.rs:120-131`）认 403，会在 `upload.rs` 侧把目录写进 `readonly_task_dirs`，与既有「他人任务只读」语义一致；409 `TASK_WRITE_FORBIDDEN` 是「行已存在但被改派」的分支，语义要区分开。
- 只校验非删除文件：`files` 全为 `deleted` 时不会被 `commitUpload` 建行（`if (!taskDir || !complete.taskId) return` 之后靠 `existing`），保持原逻辑。

### 决策 5：改派权限在 `enqueue()` 内、`assign_task` 分支、`indexed` 解析之后校验

顺序必须是「先 404 目标任务不存在 → 再 403 无权限」，否则会泄露任务是否存在。校验位置在 `indexed` 取到之后、`payload` 构造之前：

```js
const currentAssignee = indexed.assignee_user_id || null
const selfClaim = assigneeUserId === actor.userId
const isCurrentAssignee = currentAssignee === actor.userId
const isLead = isProjectLead(actor.userId, targetContext.space.project_id)
if (!selfClaim && !isCurrentAssignee && !isLead) {
  throw teamError(403, ERROR_CODES.FORBIDDEN, '只有当前负责人或项目负责人可以改派该任务')
}
```

- `isProjectLead` 用与 `commandTarget` 相同的 `sync_project_member` 联表查询，判 `role = 'lead'`。
- `selfClaim` 放行是用户明确要求的宽松规则（m00350）：普通成员可把任务接到自己名下。
- 改派自己的任务给别人恒成立（`isCurrentAssignee`），不需要额外分支。
- `create_task` 不受此约束（新建不是改派，指派人由创建流程决定）。

## 客户端落点

新增文件 `packages/desktop/src-tauri/src/agent/task_sync/ownership_filter.rs`：

```rust
impl TaskSync {
    // 本机 developer id（失败 = None → 全放行）
    pub(super) async fn local_owner_id(&self, binding: &AgentBinding) -> Option<String>;

    // 单个目录是否归本机（fail open）
    async fn owns_task_dir(&self, binding: &AgentBinding, owner_id: Option<&str>, task_dir: &str, task_json: Option<&str>) -> bool;

    // 过滤 group 集合，返回保留项；同时打 warn 日志
    pub(super) async fn retain_owned_groups(&self, binding: &AgentBinding, groups: Vec<SnapshotGroup>) -> Vec<SnapshotGroup>;
}
```

`snapshot.rs` 新增解析助手（与 `parse_task_metadata`、`task_title` 并列）：

```rust
pub(super) fn task_owner(content: &str) -> Option<String> // assignee 非空优先，否则 creator
```

接入点（两处，均在文件枚举出口）：

| 位置 | 改动 |
| --- | --- |
| `ownership_inbox.rs:38-47` `local_groups` | `let groups = group_task_snapshot_files(&files)?; Ok(self.retain_owned_groups(binding, groups).await)` |
| `pull.rs:245-290` `local_metadata_groups` | index 分组没有正文（`ownership_index.rs:231` `content: String::new()`），过滤时对需要判定的目录补读 `<repo>/<task_dir>/task.json`；控制行可写判定在后读之前，命中即免读盘 |

`pull.rs:88`（`previous` 文件）、`handoff.rs:722`（命令落地写入）**不过滤**：这两处目录已由调用方按命令/冲突选择确定，过滤会把改派落地挡掉。

## 服务端落点

| 文件 | 改动 |
| --- | --- |
| `packages/server/team/snapshot/apply.js:103` | 传 `{ files, projectId: space.project_id }` 给 `assertUploadAllowed` |
| `packages/server/team/task-control/uploads.js:39` | 签名加第 5 参 `context = {}`；`!row` 分支按决策 4 判定 |
| `packages/server/team/task-command-service.js` `enqueue()` | `assign_task` 分支按决策 5 校验操作者；新增 `isProjectLead` 查询 helper |

## 数据流（改动后）

```
本地 .trellis/tasks/*
  → read_local_task_snapshot_files
  → group_task_snapshot_files
  → retain_owned_groups（本机 dev id / control 可写 / fail open）
      ├─ 非本人 → 丢弃（warn 日志；不进差异、不进上传、不发探针）
      └─ 本人 → 首同步分类 → review/safe；live sync dirty → upload
                   → 服务端 apply
                       → assertUploadAllowed：无行时负责人必须是上传者（403）
                       → 有行时沿用既有 409/归档/版本/租约
```

## 错误码与客户端反应

| 场景 | 服务端 | 客户端 |
| --- | --- | --- |
| 目录 owner 非本人 | 不请求 | 本地丢弃 + warn |
| 无服务端行、上传者≠负责人 | `403 TASK_WRITE_FORBIDDEN` | `mark_readonly_dir(FOREIGN_OWNER:<assignee>)`，本次同步继续 |
| 有行、负责人不是我 | `403`（`assertReadable`）/ `409 TASK_WRITE_FORBIDDEN`（上传） | 同上，既有逻辑 |
| 他人任务改派给第三人（无权限） | `403 FORBIDDEN` | Web toast 显示服务端文案 |

## 风险与对策

1. **篡改 `task.json` 可自封负责人**：客户端过滤和服务端新建校验都以 `task.json` 为输入，手工改文件能骗过。彻底堵需要来源凭证（命令实例），本次 Non-goal。对策：服务端在 `!row` 建行时 `created_by_user_id = agent.userId`（既有 `uploads.js:170`），审计可追溯。
2. **误杀自己的任务**：只在「owner 明确且 != 我 且 无可写控制行」时丢弃，读不到信息一律保留。测试覆盖 5 种 fail open 情形。
3. **过滤点遗漏**：两个枚举出口都有测试（`local_groups` 走盘、`local_metadata_groups` 走 index），并且断言「被过滤目录不产生 `/files` 请求」。
4. **`local_metadata_groups` 补读盘**：每个候选目录一次 `task.json` 读（通常 <2KB）。index 路径存在的意义是避免全仓扫描，单文件读不破坏这一点。
5. **L2 与「命令已改派、`task.json` 未更新」冲突**：此时服务端已有行（命令来自行），走的是 409/版本分支，不会落到 `!row` 新建校验。
6. **测试夹具影响**：`packages/desktop/src-tauri/src/agent/task_sync/tests/ownership_projection.rs:31` 等用 `local_groups` 的夹具没有 `.trellis/.developer`，会回退到测试 config 的 `username`；实现时需让夹具的 `task.json` owner 与 `config.username` 对齐（或写入 `.developer`），并在 implement 中逐条列出需要调整的夹具。

## Spec 更新

`.trellis/spec/backend/task-ownership-and-conflict-idempotency.md` 追加契约：

- 客户端在本地任务枚举出口按 `task.json` 归属过滤，非本人目录不参与差异分类、上传、探针、待归属收件箱；`local_files` 原始文件读取（命令落地用）不过滤。
- 服务端在任务行不存在且上传携带活跃文件时，要求 `resolveAssignee(task.json).userId === agent.userId`，否则 `403 TASK_WRITE_FORBIDDEN`；`task.json` 缺 assignee 时 fail open。
- `assign_task` 命令只允许当前负责人、项目 lead、自取三种操作者，`create_task` 不受限。
