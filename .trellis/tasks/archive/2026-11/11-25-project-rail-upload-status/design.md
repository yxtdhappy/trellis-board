# 设计：项目栏上传状态与失效任务目录收敛

## 1. 现状数据流

```
任务文件写入
  └─ pull_tracking (desktop/src-tauri/src/agent/task_sync/pull.rs:355)
       ├─ local_sync_state_from_groups (cursor.rs:63)
       │    └─ 基线 ≠ 本地快照 → dirty
       ├─ upload_directories (upload.rs:4)
       │    ├─ retry cursor.pending
       │    ├─ fetch_directory(server)  ← 服务端 deleted=0 过滤
       │    ├─ build_directory_files (snapshot.rs:601)
       │    ├─ upload_persisted_batch (upload.rs:371)
       │    │    ├─ 写 cursor.pending（POST 前）
       │    │    └─ upload_batch → 成功写 pending=None + baselines
       │    └─ 返回 committedRevision
       └─ committedRevision==0 → 每轮 warning (pull.rs:532)

list_local_associations (device.rs:875)
  └─ 读 live-cursors.json → pending.files[].path
       └─ LocalAssociation.pendingUploadCount/pendingUploadTaskDirs
            └─ projectAssociationView → “N 个任务等待重试上传”
```

两个独立缺陷：

1. **状态语义缺失**：UI 只有“有 pending”这一个布尔，无法区分“正在上传”与“已停滞待重试”。
2. **基线无法收敛**：目录在本地删除、服务端 tombstone 后，游标基线没有清理入口；每轮被判 dirty，又生成空 diff。

## 2. 设计决策

| 决策 | 选择 | 理由 / 放弃的方案 |
| --- | --- | --- |
| 停滞判定位置 | 桌面端 `read_local_associations` 计算 `pendingUploadRetrying: bool` | pending 的 `createdAt` 是 Rust 写入的 RFC3339；在 Rust 内比较避免前端时钟/时区问题。放弃前端 `Date.parse` 方案。 |
| 判定依据 | pending 年龄 ≥ 30s | 不新增游标字段、不需要在每条失败/跳过分支累加 attempt；实现面最小。放弃 `attempts` 计数：需要改 `PendingBatch` 结构并在多个 skip 分支持久化，收益不足。 |
| “正在上传”文案 | `已关联 · 正在上传 N 个任务` + primary/脉冲 | 与 `syncing` 视觉一致，不占用 warning 色；保留 basename detail。 |
| 收敛触发点 | `upload_directories` 已 `fetch_directory` 之后 | 服务端事实（空目录/404）只在此时已知；避免额外请求，也避免仅凭本地缺失误清理。 |
| 清理动作 | 复用 `remove_task_dir_cursor_state` → `CursorPatch.task_dir_removals` | 与归档清理一致，按 `{task_dir}/` 精确前缀移除 baselines 与 deferred；已有单测（cursor_state.rs:748）。 |
| 本地存在性判据 | `active_task_directory_exists`（目录 metadata） | 空目录也保留基线，宁可不清理也不误删；与 `upload.rs:197` 归档保护一致。 |
| 日志 | 不新增状态日志；收敛后自然停止 | 符合 `.trellis/spec/desktop/tauri-commands/index.md:462`。收敛轮允许保留 1 条现有 warning。 |

## 3. 详细变更

### 3.1 桌面投影：`pendingUploadRetrying`

文件：`packages/desktop/src-tauri/src/agent/device.rs`

- `LocalAssociation` 结构（:77-124）新增：

```rust
#[serde(default)]
pub pending_upload_retrying: bool,
```

- `read_local_associations`（:875-942）在计算 `pending_upload_task_dirs` 的同一处计算：

```rust
let pending_upload_retrying = pending_upload_retrying(&deferred, &binding.task_space_id);
```

- 新增纯函数（与 `pending_upload_task_dirs` 相邻，:1038 附近）：

```rust
const PENDING_UPLOAD_RETRY_AFTER_SECS: i64 = 30;

fn pending_upload_retrying(cursors: &Value, task_space_id: &str) -> bool {
    let Some(created_at) = cursors
        .get("taskSpaces")
        .and_then(Value::as_object)
        .and_then(|spaces| spaces.get(task_space_id))
        .and_then(|space| space.get("pending"))
        .and_then(|pending| pending.get("createdAt"))
        .and_then(Value::as_str)
    else {
        return false;
    };
    let Ok(created) = chrono::DateTime::parse_from_rfc3339(created_at) else {
        return false;
    };
    chrono::Utc::now().signed_duration_since(created.with_timezone(&chrono::Utc))
        >= chrono::Duration::seconds(PENDING_UPLOAD_RETRY_AFTER_SECS)
}
```

- `pending_upload_task_dirs` 保持不变；`pendingUploadCount` 仍来自文件路径去重结果，二者读取同一 pending 对象，不会出现“retrying=true 但 count=0”。
- `chrono` 已在 `Cargo.toml:57` 启用 `clock`，无需新依赖。
- 单测：对纯函数喂三种 `createdAt`（现在、31 秒前、缺失/非法），断言 false/true/false。

### 3.2 Web 类型与视图

文件：

- `packages/web/src/components/layout/project-rail/types.ts`
  - `LocalAssociation` 增加 `pendingUploadRetrying: boolean`。
- `packages/web/src/components/layout/project-rail/association.ts`
  - `normalizeAssociation`（:27-136）增加 `pendingUploadRetrying: value.pendingUploadRetrying === true`。
  - `projectAssociationView`（:165-318）把现有 pending 分支拆为两段，位置与优先级不变（仍在归属/拒绝/冲突之后，`liveSyncStatus` switch 之前）：

```ts
if (association.liveSyncStatus !== 'error' && taskState.pendingUploadCount > 0) {
  const detail = basenames(association.pendingUploadTaskDirs)
  if (association.pendingUploadRetrying) {
    return {
      label: `已关联 · ${taskState.pendingUploadCount} 个任务等待重试上传`,
      detail,
      dotClassName: 'bg-warning',
      textClassName: 'text-warning',
    }
  }
  return {
    label: `已关联 · 正在上传 ${taskState.pendingUploadCount} 个任务`,
    detail,
    dotClassName: 'bg-primary animate-pulse',
    textClassName: 'text-primary',
  }
}
```

- `project-rail-association.js` 的 `associationTaskStateCounts` 不增加计数；“正在上传”是派生态，不需要参与聚合优先级。
- `packages/web/test/project-rail-association.test.js` 增加：retrying=false 的文案/样式、retrying=true 的文案/样式、`liveSyncStatus=error` 仍优先显示同步异常。

### 3.3 失效目录收敛

文件：`packages/desktop/src-tauri/src/agent/task_sync/upload.rs`

在 `fetch_directory` 循环结束后（:191 之后）、归档清理（:192-207）之前，插入：

```rust
// 服务端已无存活文件、本地目录也已不存在：该目录的基线只会在每轮被误判 dirty。
// 只对本次实际抓取过的目录判定，避免误伤未被请求的目录。
let mut prunable_dirs: Vec<String> = Vec::new();
for (task_dir, _local, server_files) in &entries {
    if !server_files.is_empty() {
        continue;
    }
    if self.active_task_directory_exists(binding, task_dir).await {
        continue;
    }
    if cursor
        .baselines
        .keys()
        .any(|path| path == task_dir || path.starts_with(&format!("{task_dir}/")))
    {
        prunable_dirs.push(task_dir.clone());
    }
}
prunable_dirs.extend(archived_dirs.iter().cloned());
prunable_dirs.sort();
prunable_dirs.dedup();
```

然后把 :193-207 的循环改为遍历合并后的 `prunable_dirs`：归档目录仍需先 `cleanup_archived_residue`；空目录不需要。建议分开处理：

```rust
for task_dir in &archived_dirs {
    self.cleanup_archived_residue(binding, task_dir).await;
}
let cleared_dirs: Vec<String> = /* archived 中本地不存在者 + prunable_dirs */;
if !cleared_dirs.is_empty() {
    self.remove_task_dir_cursor_state(&task_space_id, &cleared_dirs).await?;
    cursor = self.read_cursor(&task_space_id).await;
}
```

时序：

1. `entries` 已包含本次请求目录的 `(dir, local_group, server_files)`。
2. 对 server_files 为空且本地目录不存在的目录，收集。
3. `remove_task_dir_cursor_state` 持久化并触发 `associations` 事件（cursor.rs:430）。
4. 本轮剩余上传逻辑对该目录生成空 diff，`committedRevision=0`，`pull.rs:532` 可能仍打 1 条 warning。
5. `pull.rs:537-541` 重读 cursor 并重算 `snapshot_baselines`，死目录不再参与。
6. 下一轮 `local_sync_state_from_groups` 不再判 dirty，循环终止。

为什么不在 `local_sync_state_from_groups` 里直接忽略该目录：那里没有服务端事实，无法区分“服务端仍有文件”和“服务端已清空”；直接忽略会阻止本地删除上传 tombstone。收敛必须发生在 `fetch_directory` 之后。

### 3.4 状态优先级（保持不变）

| 优先级 | 条件 | 文案 |
| --- | --- | --- |
| 1 | 无关联 | 未关联 |
| 2 | detachPending / status != approved | 关联失效 |
| 3 | readOnly | 只读已关联（error 时附带同步异常） |
| 4 | 分支不一致 | 已关联 · 分支不一致，已暂停同步 |
| 5 | conflictCount > 0 且非 error | 已关联 · N 个冲突待处理 |
| 6 | rejectedCount > 0 | 已关联 · N 个任务服务端拒绝待处理 |
| 7 | ownership total > 0 | 待处理归属 / 分支不匹配暂停 |
| 8 | initialReviewPending | 已关联 · 等待确认任务差异 |
| 9 | pendingUploadCount > 0 且非 error | retrying ? 等待重试上传 : 正在上传 N 个任务 |
| 10 | liveSyncStatus switch | syncing / ready / error / 等待后台同步 |

## 4. 边界与风险

| 场景 | 行为 |
| --- | --- |
| pending 刚写入，HTTP 尚未返回 | retrying=false → “正在上传” |
| HTTP 失败，pending 保留 | 30 秒后 retrying=true → “等待重试上传” |
| pending 因 ownership/conflict skip 长期残留 | 30 秒后显示等待重试；归属/冲突标签优先级更高，仍先显示对应状态 |
| createdAt 非法或缺失 | retrying=false，不阻塞显示 |
| 本地目录存在（哪怕为空） | 不清理基线，保持现状 |
| 服务端目录返回 500/网络错误 | 走原有错误路径，不清理 |
| 目录在本次请求中被重命名 | 若目标目录服务端有文件则不清理；若源、目标都无文件且本地无目录，清理源基线是正确收敛 |
| 服务端仍有存活文件、本地目录被误删 | server_files 非空 → 不清理，后续仍可上传 tombstone |
| 清理后用户手工恢复目录 | 视为新任务目录重新建立基线并上传 |

风险控制：清理条件同时要求“本次 fetch 返回空”“本地目录不存在”“游标有基线”，三者缺一不可；不做全局扫描式清理。

## 5. 测试策略

Rust（提交后由 CI `cargo test` 执行；本机无工具链）：

- `pending_upload_retrying`：0s / 29s / 31s / 缺失 / 非法字符串。
- `prunable` 判定：基线存在 + 本地不存在 + 服务端空 → 清理；本地存在 → 不清理；服务端非空 → 不清理；未请求目录 → 不受影响。
- `remove_task_dir_cursor_state` 已有测试覆盖前缀隔离，不重复。
- 若把收集逻辑抽成纯函数，测试放 `packages/desktop/src-tauri/src/agent/task_sync/tests/cursor_state.rs` 或新增 `tests/upload_cleanup.rs`（需在 `tests/mod.rs` 注册）。

Web（本机执行）：

- `node --test packages/web/test/project-rail-association.test.js`（或 `yarn test --scope=web --file=project-rail-association`）。
- `yarn test --scope=lint`（oxfmt check、oxlint、tsc -b --noEmit）。

手工验证：

- 复现目录：在本地删除一个已同步任务目录（或使用现有 `.trellis/tasks/11-20-handoff-manual-e2e-114216` 的 cursor 基线），启动桌面端，观察 `desktop.log`：
  - 收敛前最多 1 条 `上传未产生提交`；
  - 后续 10 分钟无该目录告警；
  - `live-cursors.json` 中该目录的 baselines 消失。
- 上传中观察项目栏：新建/修改任务文件时显示“正在上传 N 个任务”，不再闪“等待重试上传”；人为断网让上传失败，30 秒后应变为“等待重试上传”。

## 6. 发布与回滚

- 改动仅涉及 desktop Rust + web 前端 + spec，无服务端协议变更；可随下一次桌面端版本发布。
- 回滚：整体 revert 本任务提交即可；清理逻辑只删除本地游标缓存，不删除任务文件，回滚不会造成数据丢失。
- 无数据库迁移、无配置开关。

## 7. 规格更新

`.trellis/spec/frontend/rendering-and-state.md:63-65` 的项目行状态清单加入“正在上传 N 个任务”，并补充：

- pending 在 30 秒内按“正在上传”展示；超过阈值或失败后展示“等待重试上传”。
- 两者都不改变聚合优先级中的 pending 档位。

## 8. 文件清单

| 文件 | 变更 |
| --- | --- |
| `packages/desktop/src-tauri/src/agent/device.rs` | 新增字段、投影与纯函数、单测 |
| `packages/desktop/src-tauri/src/agent/task_sync/upload.rs` | fetch 后收集失效目录并清理游标 |
| `packages/desktop/src-tauri/src/agent/task_sync/tests/*.rs` | 新增/扩展单测 |
| `packages/web/src/components/layout/project-rail/types.ts` | `pendingUploadRetrying` |
| `packages/web/src/components/layout/project-rail/association.ts` | 归一化 + 两段式视图 |
| `packages/web/test/project-rail-association.test.js` | 文案/优先级测试 |
| `.trellis/spec/frontend/rendering-and-state.md` | 状态清单更新 |
| `.trellis/tasks/11-25-project-rail-upload-status/` | 任务制品随工作提交入库 |
