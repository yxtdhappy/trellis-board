# 设计：task_sync.rs 模块拆分

## 1. 目标形态

`packages/desktop/src-tauri/src/agent/task_sync.rs`（模块根，目标 ≤ 500 行）+ `packages/desktop/src-tauri/src/agent/task_sync/` 子目录。
不改成 `task_sync/mod.rs`：Rust 2018 允许 `foo.rs` + `foo/` 同时存在，这样 `agent/mod.rs` 的 `pub mod task_sync;` 与所有 `crate::agent::task_sync::X` 引用路径零改动。

根文件内容仅：

```rust
// imports（1-21）
// 常量（22-63 原样保留）
pub struct TaskSync { /* 字段 1670-1714 原样 */ }

impl TaskSync {                                       // 1716-1778
    pub fn new(...) -> Self
    pub fn with_ownership_index_writer(...)
    pub fn with_state_sink(...)
    pub fn with_heartbeat_wake(...)
}

impl Drop for TaskSync { /* 9628-9633 原样 */ }

mod bindings; mod conflict; mod control; mod cursor; mod errors;
mod handoff; mod initial_sync; mod local_files; mod ownership;
mod ownership_index; mod ownership_inbox; mod paths; mod pull;
mod snapshot; mod sync_api; mod upload; mod watch;
#[cfg(test)] mod tests;

pub use ...;         // 外部引用符号重导出（§5 清单）
```

## 2. 模块划分

行号与 item 归属由脚本从源文件机械提取，**权威版本见 `research/structure-map.md`**（每个 item 的精确区间、每个模块的精确行数）；测试函数清单见 `research/test-inventory.txt`（123 个 `fn`，含 fixture）。下表为汇总，行数已按 item 边界核算，覆盖 1–11112 全部生产代码、无重叠无遗漏。

| 目标文件 | 源行区间（精确） | 主要内容 | 行数 |
| --- | --- | --- | --- |
| `task_sync.rs` | 1–63、1670–1778、9628–9633 | imports、常量、`TaskSync` 字段、构造与 builder、`impl Drop`、`mod` 与重导出 | 178 |
| `task_sync/errors.rs` | 64–117、175–205、476–490、10684–10704、10799–10802 | `BRANCH_GUARD_CODES` 判定、`task_sync_error_event`、`with_task_dir`、`required_client_sequence`、显式驳回判定、`sync_trace`、foreign/archived 错误分类、`io_error` | 125 |
| `task_sync/paths.rs` | 451–475、491–574、1387–1411、10584–10598 | 归档目录/月份判定、`normalize_snapshot_path`、`TaskPathParts`/`task_directory_from_path`/`task_directory_from_relative`、缓存目录合法性、`absolute_task_path`/`task_directory_error` | 149 |
| `task_sync/snapshot.rs` | 206–322、575–961、1270–1299、9889–9911、9987–10121 | `ControlSink`、`SnapshotFile`/`SnapshotGroup`/`DiffKind`/`Difference`、`normalize_snapshot_text`/`snapshot_sha256`/`sha256_bytes`、`validate_snapshot_file`、`group_task_snapshot_files`、`validate_upload_batch`、`classify_task_snapshots` 及其解析辅助、`UploadFile`/`UploadMode`、`parse_directory_files`、`build_directory_files`、`move_pairs` | 692 |
| `task_sync/cursor.rs` | 962–1247、5174–5372、9641–9693、9881–9888、10122–10429 | baseline/deferred/local state 归一、`Cursor`/`PendingBatch`/`PendingRejection`、`cursor_from_entry`、归档 pending 迁移、`CursorPatch`/`apply_cursor_patch`、`next_client_sequence`、`clear_deferred_for_files`、全部 cursor 状态序列化与解析、游标读写方法 | 854 |
| `task_sync/ownership_index.rs` | 1318–1386、1412–1655、1794–1804、3266–3343 | `OwnershipIndex`/`OwnershipIndexBinding`/`OwnershipTaskIndex`/`OwnershipFileIndex`、`ownership_tasks_root_is_safe`、`normalize_index`、`load_ownership_index`、`indexed_ownership_projection`、`indexed_local_groups`、缓存结构、索引持久化方法 | 402 |
| `task_sync/control.rs` | 1779–1784、1805–2186、3060–3265 | `wake_heartbeat`、TaskControl 加载/合并/持久化、lease 领取-心跳-释放、handoff ACK 状态、`process_handoff_control(s)`、`remote_task_control`、`prepare_controlled_server_groups`、`release_inactive_task_leases`、`persisted_control_key_for_upload` | 594 |
| `task_sync/handoff.rs` | 323–450、1656–1669、2187–3059、10901–11006 | handoff manifest/ack/notice、`git_entries_all_untracked`、`HandoffSource`/`HandoffSourceState`、备份目标与校验、备份元数据、`ensure_handoff_backup`、trash 清理、`remove_handoff_source`、`retry_pending_handoff_acks`、`handoff_source_state`、`process_handoff_control`、handoff 路径安全与 temp 清理、`previous_values_paths` | 1121 |
| `task_sync/bindings.rs` | 118–174、1785–1793、3344–3719、4687–4902、5152–5173 | `approved_bindings` 与 unchanged 判定、`task_space_sync_lock`、`notify_state_changed`/`set_bindings`/`update_bindings`/`prepare_startup_bindings`/`sync_task_spaces`/`wait_for_binding_sync`/`finish_binding_sync`/`prepare_bindings`/`select_bindings`/`report_binding_error`、`assert_binding_active`/`task_space_is_active`/`binding_hooks_dir`、`persist_binding_sync_error`/`clear_branch_guard_error`/`pull_and_report*`/`report_error`、`binding`/`active_bindings` | 680 |
| `task_sync/ownership.rs` | 3720–4686 | 分支/HEAD 校验、HEAD 树缓存、worktree/HEAD 变更目录扫描、`scan_ownership_index_files`、`refresh_ownership_index_binding(_with_scan)`、`validate_ownership_binding`、projection epoch/cache、校验 worker、`ownership_projection`、`ownership_paused_task_dirs`、`baseline_owned*` | 967 |
| `task_sync/ownership_inbox.rs` | 1248–1269、5373–5656、5850–6437 | `OwnershipReview`/`OwnershipDecision`/`OwnershipResolution`、`local_files`/`local_groups`、`fetch_task_ownership`、评审记忆、驳回、冲突阻塞、readonly 标记、`control_assignee`、`local_task_state`、`reopen_conflicts`、`ownership_event`、`sync_ownership_inbox`、`put_ownership_inbox`、`resolve_task_ownership`/`resolve_group_ownership` | 894 |
| `task_sync/pull.rs` | 6438–7112 | `fetch_snapshot`/`fetch_directory`、`write_server_cursor`、`apply_server_groups`、目录移除与备份、`suppressed_event`、`local_sync_state`、`local_metadata_groups`、`pull_task_space*`、`pull`/`pull_tracking` | 675 |
| `task_sync/initial_sync.rs` | 7113–7724、8927–9216、9694–9709、9763–9880 | `repair_revision_guard`、`pull_initial_sync`、`emit_differences`、`complete_initial_sync`、`upload_dirty`、`reconcile_baseline_tasks`、`resolve_initial_sync`、`upload_reviewed_local_task`、`should_pull_for_event`、`initial_sync_mode`、`retain_server_groups_*`、`binding_is_baseline`、`allows_cross_source_server_group`、`hide_control_tombstone_local_only`、`inactive_control_dirs`、`snapshot_revision` | 1036 |
| `task_sync/sync_api.rs` | 7725–8060 | `claim_execution_task`、`sync_task_directories`/`_with_base`、`list_task_ownership`、`set_task_ownership`、`sync_deferred_tasks`（对外命令入口） | 336 |
| `task_sync/upload.rs` | 8061–8926、9912–9986 | `upload_directories`、`upload_persisted_batch`、`upload_preclassified_batch`、`retry_pending_batch`、`upload_batch`、`upload_with_slot`、上传请求构造（`execution_task_keys_from_upload`、`response_control_execution_task_key`、`build_upload_request`、`pending_task_dirs`） | 941 |
| `task_sync/conflict.rs` | 9217–9627、9634–9640、9710–9762 | `decide_conflict`、`conflict_details`、`fetch_conflicts`、`resolve_conflict`、`conflict_directories`、`ConflictDirectories`、`conflict_task_directories`、`conflict_is_archive_only`、`conflict_summary` | 471 |
| `task_sync/watch.rs` | 1300–1317、4903–5151、10430–10583 | `WatchEvent`/`WatchState`、`rebuild_watchers`、`watch_loop`、`is_watched_trellis_path`/`is_relevant_watch_event`、git HEAD/index/refs 指纹与监听路径、`resolve_git_dir` | 421 |
| `task_sync/local_files.rs` | 5657–5849、10599–10635、10636–10683、10705–10798、10803–10900、11007–11112 | `cleanup_archived_controls`、`prune_readonly_dirs`、`cleanup_archived_residue`、`download_task`、`resolve_task_directory`、`archived_task_copies`、`task_directory_digest`、`write_task_directory`、`copy_directory`、`task_directory_file_paths`、`read_local_task_snapshot_files`、`urlencode` | 576 |
| `task_sync/tests/mod.rs` + `support.rs` | 11113–11120 + fixture（11261–11324、11324–11629、12403–12469、13910–13945、15005–15031、14192–14201） | 测试入口与 fixture：`test_binding`、`init_git_repo`、`mock_api_server`、`remote_task_from_control`、`replay_fixture`、`test_task_sync_fixture`、`test_config`、`snapshot_file_value`、`batch_file_values`、`task_group`、`exact_deferred_fixture`、`write_deferred_cursor`、`assert_cursor_patch_changes_once` | ~900 |
| `task_sync/tests/cursor_state.rs` | 11119–11261、14057–14142、14192–14494、14782–15005 | 游标默认值/补丁/迁移、pending 驳回、deferred 收敛 | ~700 |
| `task_sync/tests/snapshot_classify.rs` | 13894–13910、13945–14057、15031–15343 | 路径与文本归一、快照分类、批次上限、`task_title`、handoff manifest | ~600 |
| `task_sync/tests/upload_flow.rs` | 11714–11872、12212–12338、13976–14017、15630–15687 | pending 重放、显式驳回、上传请求字段、失败定位 | ~500 |
| `task_sync/tests/ownership_projection.rs` | 12469–13622、14540–14747、15366–15570 | 索引缓存、projection 失效与复用、git HEAD 快路径、startup reconcile、handoff 源校验 | ~1100 |
| `task_sync/tests/initial_sync.rs` | 11972–12186、13297–13861 | revision guard、初始同步审查、deferred 对账、归档目录拒绝 | ~900 |
| `task_sync/tests/bindings_watch.rs` | 14494–14540、14588–14782、15123–15189 | binding 变更通知、watcher 过滤、同步锁、心跳 | ~400 |
| `task_sync/tests/handoff_conflict.rs` | 12338–12403、15343–15799 | claim/lease、冲突详情、只读目录、摘要比对 | ~500 |

测试区间为按主题的初分（`research/test-inventory.txt` 给出 123 个 `fn` 的精确区间），实施第 5 步若发现跨主题耦合，按函数边界调整，不裁剪测试。任何子文件超过 1200 行就按同一主题边界对半切（只切文件、不改内容）。

## 3. 可见性契约（能否干净落地的关键）

现状：所有 `TaskSync` 方法与顶层辅助函数都只有 `task_sync` 模块及其后代可见。拆分后：

1. **搬进子模块的 item 一律改为 `pub(super)`**。从 `task_sync::upload` 看，`pub(super)` = `task_sync` 子树可见，与今天"私有于 `task_sync`"的可见范围**完全等价**：既不放宽，也不收紧。
2. 已是 `pub` / `pub(crate)` 的 item 保持原可见性；根文件用 `pub use` / `pub(crate) use` 重导出，保证 `crate::agent::task_sync::X` 路径不变。
3. 根文件的 `TaskSync` 字段保持私有——子模块是 `task_sync` 的后代，可直接访问，包含 `#[cfg(test)]` 计数字段 `head_tree_scans`、`branch_validations`、`task_json_reads`、`task_file_reads`、`task_entries_examined`。
4. `impl TaskSync` 可分散在多个子模块；方法加 `pub(super)`，不合并、不重排、不改签名、不改方法体。
5. 生产子模块顶部用精确 `use super::{...}` / `use crate::agent::...`，**不用** `use super::*`（制造 `unused_imports` 噪声）；测试子模块用 `use super::super::*;` + `use super::support::*;`，与现在 `mod tests { use super::*; }` 等价——`task_sync::tests` 仍是 `task_sync` 的后代，私有项照旧可见。
6. 搬移保持逐字节一致：doc comment 跟随 item，不重排、不改字符串、**不跑 `cargo fmt`**（仓库无 `rustfmt.toml`，全量格式化会产生与重构无关的噪声）。

## 4. 依赖方向（防"逻辑回指"的约束）

```
errors, paths            ← 无内部依赖
snapshot                 → paths, errors
cursor                   → paths, snapshot
ownership_index          → paths
local_files              → paths, snapshot, errors
control / handoff        → paths, errors
bindings                 → errors, paths
ownership                → ownership_index, bindings, paths
ownership_inbox          → ownership, ownership_index, snapshot
pull                     → snapshot, cursor, ownership, ownership_inbox, local_files
upload                   → snapshot, cursor, ownership, local_files, control
initial_sync             → pull, upload, snapshot, cursor, conflict
sync_api                 → upload, ownership, bindings
conflict                 → snapshot, cursor, local_files, ownership_index
watch                    → paths
```

Rust 同级子模块互相 `use super::x` 不构成编译期循环（模块不是编译单元）。上表只约束逻辑归属；真出现双向依赖，把共用部分下沉到 `paths`/`snapshot`/`errors`。

## 5. 兼容与风险

| 风险 | 影响 | 处置 |
| --- | --- | --- |
| 私有方法跨子模块不可见 | 编译失败 | 统一 `pub(super)`（§3.1），不逐个猜 |
| 重导出漏项，外部模块 `unresolved import` | 编译失败 | 以 `git grep -n "task_sync::"` 得到的符号清单（`TaskSync`、`ControlSink`、`SnapshotFile`、`SnapshotGroup`、`Difference`、`DiffKind`、`TaskPathParts`、`normalize_snapshot_path`、`task_directory_from_path`、`task_directory_from_relative`、`group_task_snapshot_files`、`classify_task_snapshots`、`snapshot_sha256`、`read_local_task_snapshot_files`、`load_ownership_index`、`OwnershipIndex`、`ownership_tasks_root_is_safe`、`indexed_ownership_projection`、`active_task_directory_from_path`、`is_archive_task_dir`、`is_branch_guard_code`、`parse_directory_files`、`urlencode`）逐个重导出，`cargo check --all-targets` 验证 |
| 测试拆到子模块后 `use super::*` 失效 | 编译失败 | 用 `use super::super::*;`；先切一个主题文件验证再批量 |
| 搬移夹带逻辑改动 | 行为漂移、review 失控 | 每步只做剪切+粘贴+`use`；用 `git diff -M` 复核；禁止改数值/字符串/顺序 |
| 全量 `cargo check` 慢 | 迭代成本 | 每步一次 `cargo check --all-targets`；clippy/测试只在收尾跑 |
| 与 `runtime.rs`/`device.rs` 的并发改动冲突 | 合并冲突 | 本任务不改 `task_sync` 之外文件，冲突面仅限 `task_sync*` |

回滚：`git checkout -- packages/desktop/src-tauri/src/agent/task_sync.rs && rm -rf packages/desktop/src-tauri/src/agent/task_sync`。纯搬移，无数据/协议/状态迁移，无需 feature flag。

## 6. 验证

1. 基线（动手前）：`cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml -- --list` 保存测试清单与数量到 `research/baseline-tests.txt`；记录 `cargo check --all-targets` 的 warning 数。
2. 每步：`cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml --all-targets`。
3. 收尾：`cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`（与 `.github/workflows/windows.yml:151` 一致），逐条对比基线清单，数量与结果必须一致。
4. 结构证据：`wc -l` 列出根文件与各子文件行数；`git diff --stat` 证明改动只在 `task_sync*`。
5. clippy 只在基线本身无 warning 时作为附加检查，否则跳过（不做超范围清理）。
