# 实施：同步只处理本人任务

## 变更清单

1. 客户端归属谓词与过滤（`packages/desktop/src-tauri/src/...`）
2. 服务端新建归属校验（`packages/server/team/task-control/uploads.js` + `packages/server/team/snapshot/apply.js`）
3. 服务端改派权限（`packages/server/team/task-command-service.js`）
4. spec 契约追加

## 步骤

### 1. `snapshot.rs`：task.json 归属解析

`packages/desktop/src-tauri/src/agent/task_sync/snapshot.rs`，在 `parse_task_metadata`（:255-291）旁新增：

```rust
pub(super) fn task_owner(content: &str) -> Option<String> {
    let value: Value = serde_json::from_str(content).ok()?;
    ["assignee", "creator"]
        .iter()
        .find_map(|field| {
            value
                .get(*field)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
        })
}
```

- 与 `parse_task_metadata` 一致：解析失败返回 `None`（上层 fail open）。
- 单测：assignee 优先、assignee 空串回退 creator、两者都缺 → None、非 JSON → None、首尾空格被 trim。

### 2. `agent/worktree/mod.rs`：暴露 developer id 解析

`packages/desktop/src-tauri/src/agent/worktree/mod.rs:1` 的 `mod discovery;` 之后加：

```rust
pub(crate) use discovery::developer_id;
```

（`developer_id` 本身已是 `pub async fn`，只需提升模块可见性。）

### 3. 新文件 `agent/task_sync/ownership_filter.rs`

在 `packages/desktop/src-tauri/src/agent/task_sync.rs` 的模块声明处登记 `mod ownership_filter;`（与现有 `mod ownership_inbox;` 等同级，`use super::*` 风格保持一致）。

```rust
use super::*;

impl TaskSync {
    pub(super) async fn local_owner_id(&self, binding: &AgentBinding) -> Option<String> {
        let config = self.store.read_config(true).await.ok()??;
        crate::agent::worktree::developer_id(
            Path::new(&binding.repo_path),
            &config,
            &binding.remote_identity_key,
        )
        .await
    }

    pub(super) async fn retain_owned_groups(
        &self,
        binding: &AgentBinding,
        groups: Vec<SnapshotGroup>,
    ) -> Vec<SnapshotGroup> {
        let owner_id = self.local_owner_id(binding).await;
        let mut kept = Vec::with_capacity(groups.len());
        for group in groups {
            if self.owns_task_dir(binding, owner_id.as_deref(), &group).await {
                kept.push(group);
            }
        }
        kept
    }
}
```

`owns_task_dir` 判定顺序（短路，从最便宜到最贵）：

1. `binding.read_only` → 保留（只读绑定不产生上传，过滤无收益，保持现状）。
2. `Some(owner_id)` 为空 → 保留（fail open）。
3. 控制行命中：`ensure_task_control_loaded().await` → `task_control_state.lock()` →
   `execution_task_key_for_dir(&binding.local_id, &binding.task_space_id, &group.task_dir)` →
   `controls.get(key).is_some_and(|c| c.state.is_writable_local())` → 保留。锁必须在任何 `await` 之前释放。
4. 取正文：`group.files` 里 `file_path == "task.json" && !deleted` 的 `content`；为空（ownership index 来源）则读盘
   `<binding.repo_path>/<task_dir>/task.json`（读失败 → 保留）。
5. `task_owner(content)`：
   - `None` → 保留；
   - `Some(owner)` 且 `owner.eq_ignore_ascii_case(owner_id)` → 保留；
   - 其余 → 丢弃 + 一条 warn 日志：
     ```
     crate::logging::warn(&format!(
         "跳过他人任务目录 taskSpaceId={} taskDir={} owner={} local={}",
         binding.task_space_id, group.task_dir, owner, owner_id
     ));
     ```

只读判定命中控制行时**不**写 `readonly_task_dirs`（PRD R9）：丢弃是「不归我管」，不是「只读镜像」。

### 4. 接入 `local_groups`

`packages/desktop/src-tauri/src/agent/task_sync/ownership_inbox.rs:38-47`：

```rust
let files = self.local_files(binding, task_dirs).await?;
let groups = group_task_snapshot_files(&files)?;
Ok(self.retain_owned_groups(binding, groups).await)
```

### 5. 接入 `local_metadata_groups`

`packages/desktop/src-tauri/src/agent/task_sync/pull.rs:245-290`：把 `indexed_local_groups(entry)` 的结果在释放 `ownership_index` 锁之后再过滤（`retain_owned_groups` 是 async，持有 `MutexGuard` 会破坏 `Send`）：

```rust
let groups = {
    let index = self.ownership_index.lock().await;
    let entry = index.bindings.get(&binding.local_id)...?;
    if !entry.files_complete { return protocol::err(...); }
    indexed_local_groups(entry)?
};
self.retain_owned_groups(binding, groups).await
```

同时把 `let index = self.ownership_index.lock().await;` 移入块内，函数其余部分不变。

**不接**`pull.rs:88`（`previous` 文件）与 `handoff.rs:722`（命令落地）：目录由命令/冲突选择确定，过滤会挡掉改派写入。

### 6. 服务端 `assertUploadAllowed` 新建校验

`packages/server/team/task-control/uploads.js:39`：

```js
function assertUploadAllowed(agent, taskSpaceId, complete, input = {}, context = {}) {
  views.assertAgentAccess(agent, taskSpaceId)
  const executionTaskKey =
    complete.taskId == null ? null : canonicalKey(taskSpaceId, complete.taskId)
  const row = executionTaskKey ? statements.readTask.get(executionTaskKey) : null
  if (!row) {
    const files = Array.isArray(context.files) ? context.files : []
    if (files.some((file) => !file.deleted)) {
      const { document } = documentForUpload(taskSpaceId, complete.taskDir, files)
      const assignee = tasks.resolveAssignee(context.projectId, document, agent.userId)
      if (assignee.userId !== agent.userId) {
        throw teamError(403, 'TASK_WRITE_FORBIDDEN', '任务负责人不是本机用户，不能新建任务', {
          details: {
            taskId: complete.taskId,
            taskDir: complete.taskDir,
            assigneeUserId: assignee.userId,
          },
        })
      }
    }
    return { task: null, lease: null }
  }
  ...
}
```

`packages/server/team/snapshot/apply.js:103`：

```js
taskControl?.assertUploadAllowed(agent, taskSpaceId, complete, input, {
  files,
  projectId: space.project_id,
})
```

注意 `documentForUpload` 内部读 `statements.readTaskDirFiles`——此时本批文件尚未落库，靠函数自身的「先用库内文件、再用本批 files 覆盖」逻辑合并，语义正确。

### 7. 服务端改派权限

`packages/server/team/task-command-service.js`：

1. 新增 helper（放在 `commandTarget` 之后）：

```js
function isProjectLead(userId, projectId) {
  const row = db
    .prepare('SELECT role FROM sync_project_member WHERE project_id = ? AND user_id = ?')
    .get(projectId, userId)
  return row?.role === 'lead'
}
```

2. `enqueue()` 的 `assign_task` 分支，在 `indexed` 取到之后、`payload` 构造之前插入：

```js
const currentAssignee = indexed.assignee_user_id || null
const selfClaim = assigneeUserId === actor.userId
if (
  !selfClaim &&
  currentAssignee !== actor.userId &&
  !isProjectLead(actor.userId, targetContext.space.project_id)
) {
  throw teamError(403, ERROR_CODES.FORBIDDEN, '只有当前负责人或项目负责人可以改派该任务')
}
```

`targetContext.space` 由 `commandTarget()` 返回（`task-command-service.js:129` `const space = taskSpaces.loadTaskSpaceRow(taskSpaceId)`），含 `project_id`。

### 8. spec 更新

`.trellis/spec/backend/task-ownership-and-conflict-idempotency.md` 追加「枚举期归属过滤」与「服务端新建归属校验」「改派权限」三节契约，写入判定顺序与 fail open 规则（见 design.md「Spec 更新」）。

## 测试

### 客户端（`packages/desktop/src-tauri`）

新增 `src/agent/task_sync/tests/ownership_filter.rs`（在 `tests/mod.rs` 登记）：

1. `task_owner` 解析：assignee 优先 / creator 回退 / 空 → None / 坏 JSON → None。
2. owner = 本机 dev id（大小写不同）→ group 保留。
3. owner = 他人 → group 被丢弃，且不进入 `classify_task_snapshots` 输入（断言差异集合为空）。
4. owner 为空 / `task.json` 缺失 / 读不到 dev id（config 无 username 且无 `.developer`）→ 保留。
5. 存在可写控制行（`materialized`/`claimed`/`pending_delivery`）且 owner 是他人 → 保留；`archived`/`delivered` 等不可写状态 → 丢弃。
6. 首同步：他人目录不触发 `/files` 探针（mock API 断言零请求）且 `pendingReview` 为 false，`initialSyncCompleted` 可正常置真。
7. live sync：他人目录修改后不上传（断言 `upload_directories` 未被调用 / 服务端零请求）。
8. `local_metadata_groups` 路径：ownership index 分组（`content` 为空）+ 磁盘 task.json owner=他人 → 被过滤。

夹具调整（现有用例会因过滤发生变化，需让夹具的 task.json owner 与测试 config 的 `username` 对齐）：

- `src/agent/task_sync/tests/ownership_projection.rs:31`
- `src/agent/task_sync/tests/ownership_inbox.rs`（凡调用 `local_groups` 的用例）
- `src/agent/task_sync/tests/pull_and_startup.rs`、`materialization.rs`、`handoff_and_errors.rs`、`snapshot_files.rs` 中调 `local_groups` 的用例
- `src/agent/task_sync/tests/support.rs` 里构造测试 `task.json` 的助手若默认 owner 与 config `username` 不一致，统一在 support 里补 owner。

### 服务端（`packages/server/test`）

`team-task-control.test.js` 追加：

1. `!row` + `task.json.assignee` = 上传者 dev id → 建行成功，`stage='materialized'`，`assignee_user_id` = 上传者。
2. `!row` + `task.json.assignee` = 另一个成员的 dev id → `403 TASK_WRITE_FORBIDDEN`，`sync_task_space_file` 与 `sync_task_index` 零新增、revision 不变。
3. `!row` + `task.json` 无 assignee → 建行（fail open）。
4. `!row` + 全删除批次 → 不触发校验，行为不变。

`team-task-commands.test.js`（若该文件不存在则并入 `team-task-control.test.js`）：

5. 普通成员把他人任务改派给第三人 → `403 FORBIDDEN`，`sync_task_command` 无新增。
6. 普通成员自取 → `202`，命令行落库、目标为本人。
7. lead 改派任何任务 → `202`。
8. 当前负责人改派给别人 → `202`。

## 验证命令

```bash
cd packages/desktop/src-tauri && cargo test
cd packages/desktop/src-tauri && cargo clippy --all-targets
node --test packages/server/test/team-task-control.test.js
node --test packages/server/test/team-task-commands.test.js
yarn test            # 仓库根，node --test packages/*/test/*.test.js
npx prettier --check packages/server/team/task-control/uploads.js \
  packages/server/team/snapshot/apply.js packages/server/team/task-command-service.js
npx eslint packages/server/team/task-control/uploads.js \
  packages/server/team/snapshot/apply.js packages/server/team/task-command-service.js
cargo fmt --check --manifest-path packages/desktop/src-tauri/Cargo.toml
```

## 端到端回归（现场口径）

1. 用现场绑定（project mdp-management-web / taskSpace `d3a320e8-21d7-4381-a95a-a96936481d4a` / branch `release/3.0.0/dev`）重新首同步：不再弹差异弹窗，`initialSyncCompleted=true`，`live-cursors.json` 出现该 taskSpace，`desktop.log` 出现跳过 `11-16-dashboard-push-service-account` 的 warn。
2. 本地新建 owner=本人（无 branch）的任务目录首同步：仍按 review 弹窗；「仅同步无冲突项」后服务端建行、租约归本机。
3. 本地篡改一个 owner=他人的目录后触发同步：服务端 403，无新行，客户端该目录进入 `readonly_task_dirs`。

## 边界

- 不改 Web 改派控件可见性（服务端 403 由既有 toast 呈现）。
- 不引入命令凭证校验（PRD Non-goal）。
- 不动 11-19 的 403/404/409 探针语义与通知行为。
