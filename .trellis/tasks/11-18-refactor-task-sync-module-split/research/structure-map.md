# task_sync.rs 结构地图（机器提取，配合 design.md §2）

源文件 `packages/desktop/src-tauri/src/agent/task_sync.rs`，15799 行。item 起始行取声明行；其上方紧邻的 doc comment 与 `#[...]` 属性行随 item 一起搬移。`impl TaskSync` 已展开为 `TaskSync::<方法名>`，行数为完整方法体区间。

顶层分布：imports 1–21、常量 22–63、自由函数 64–1669、`TaskSync` 结构 1670–1714、`impl TaskSync` 1715–9627、`impl Drop` 9628–9633、自由函数 9634–11112、`#[cfg(test)] mod tests` 11112–15799。

## errors.rs（125 行）

| 源行区间 | 行数 | item |
| --- | --- | --- |
| 64–67 | 4 | `is_branch_guard_code` |
| 68–71 | 4 | `is_branch_guard_error` |
| 72–103 | 32 | `task_sync_error_event` |
| 104–117 | 14 | `with_task_dir` |
| 175–186 | 12 | `required_client_sequence` |
| 187–197 | 11 | `is_explicit_pending_rejection` |
| 198–205 | 8 | `skipped_for_explicit_pending_rejection` |
| 476–490 | 15 | `sync_trace` |
| 10684–10696 | 13 | `is_foreign_task_error` |
| 10697–10704 | 8 | `is_archived_task_error` |
| 10799–10802 | 4 | `io_error` |

## bindings.rs（680 行）

| 源行区间 | 行数 | item |
| --- | --- | --- |
| 118–130 | 13 | `approved_bindings` |
| 131–142 | 12 | `binding_selection_unchanged` |
| 143–151 | 9 | `binding_entry_unchanged` |
| 152–161 | 10 | `association_state_unchanged` |
| 162–174 | 13 | `association_map_unchanged` |
| 1785–1793 | 9 | `TaskSync::task_space_sync_lock` |
| 3344–3349 | 6 | `TaskSync::notify_state_changed` |
| 3350–3353 | 4 | `TaskSync::notify_bindings_changed` |
| 3354–3379 | 26 | `TaskSync::set_bindings` |
| 3380–3384 | 5 | `TaskSync::update_bindings` |
| 3385–3391 | 7 | `TaskSync::prepare_startup_bindings` |
| 3392–3434 | 43 | `TaskSync::sync_task_spaces` |
| 3435–3446 | 12 | `TaskSync::wait_for_binding_sync` |
| 3447–3513 | 67 | `TaskSync::finish_binding_sync` |
| 3514–3624 | 111 | `TaskSync::prepare_bindings` |
| 3625–3709 | 85 | `TaskSync::select_bindings` |
| 3710–3719 | 10 | `TaskSync::report_binding_error` |
| 4687–4702 | 16 | `TaskSync::assert_binding_active` |
| 4703–4717 | 15 | `TaskSync::task_space_is_active` |
| 4718–4721 | 4 | `TaskSync::binding_hooks_dir` |
| 4722–4773 | 52 | `TaskSync::persist_binding_sync_error` |
| 4774–4828 | 55 | `TaskSync::clear_branch_guard_error` |
| 4829–4853 | 25 | `TaskSync::pull_and_report` |
| 4854–4875 | 22 | `TaskSync::pull_and_report_for_event` |
| 4876–4902 | 27 | `TaskSync::report_error` |
| 5152–5161 | 10 | `TaskSync::binding` |
| 5162–5173 | 12 | `TaskSync::active_bindings` |

## snapshot.rs（692 行）

| 源行区间 | 行数 | item |
| --- | --- | --- |
| 206–208 | 3 | `ControlSink` |
| 209–221 | 13 | `SnapshotFile` |
| 222–231 | 10 | `SnapshotGroup` |
| 232–241 | 10 | `DiffKind` |
| 242–249 | 8 | `Difference` |
| 250–288 | 39 | `Difference` |
| 289–293 | 5 | `normalize_snapshot_text` |
| 294–299 | 6 | `snapshot_sha256` |
| 300–306 | 7 | `is_sha256` |
| 307–315 | 9 | `is_handoff_backup_id` |
| 316–322 | 7 | `sha256_bytes` |
| 575–626 | 52 | `validate_snapshot_file` |
| 627–680 | 54 | `group_task_snapshot_files` |
| 681–712 | 32 | `validate_upload_batch` |
| 713–716 | 4 | `parse_task_id` |
| 717–736 | 20 | `parse_task_metadata` |
| 737–752 | 16 | `task_title` |
| 753–766 | 14 | `task_fingerprint` |
| 767–775 | 9 | `file_map` |
| 776–779 | 4 | `same_files` |
| 780–961 | 182 | `classify_task_snapshots` |
| 1270–1278 | 9 | `UploadFile` |
| 1279–1284 | 6 | `UploadMode` |
| 1285–1299 | 15 | `UploadFile` |
| 9889–9897 | 9 | `parse_snapshot_files` |
| 9898–9911 | 14 | `parse_snapshot_controls` |
| 9987–9999 | 13 | `parse_snapshot_files_from_values` |
| 10000–10025 | 26 | `parse_directory_files` |
| 10026–10041 | 16 | `groups_from_structs` |
| 10042–10084 | 43 | `build_directory_files` |
| 10085–10089 | 5 | `uploads_to_snapshot_files` |
| 10090–10091 | 2 | `DirectoryEntry` |
| 10092–10121 | 30 | `move_pairs` |

## handoff.rs（1121 行）

| 源行区间 | 行数 | item |
| --- | --- | --- |
| 323–387 | 65 | `handoff_manifest` |
| 388–427 | 40 | `handoff_ack_request` |
| 428–446 | 19 | `handoff_notice` |
| 447–450 | 4 | `git_entries_all_untracked` |
| 1656–1664 | 9 | `HandoffSource` |
| 1665–1669 | 5 | `HandoffSourceState` |
| 2187–2200 | 14 | `TaskSync::handoff_task_directory_exists` |
| 2201–2237 | 37 | `TaskSync::handoff_backup_target` |
| 2238–2318 | 81 | `TaskSync::handoff_backup_is_valid` |
| 2319–2371 | 53 | `TaskSync::write_handoff_backup_metadata` |
| 2372–2429 | 58 | `TaskSync::ensure_handoff_backup` |
| 2430–2457 | 28 | `TaskSync::cleanup_handoff_trash` |
| 2458–2565 | 108 | `TaskSync::remove_handoff_source` |
| 2566–2745 | 180 | `TaskSync::retry_pending_handoff_acks` |
| 2746–2859 | 114 | `TaskSync::handoff_source_state` |
| 2860–3059 | 200 | `TaskSync::process_handoff_control` |
| 10901–10910 | 10 | `safe_handoff_relative_path` |
| 10911–10916 | 6 | `is_handoff_metadata_temp` |
| 10917–10933 | 17 | `cleanup_handoff_backup_temps` |
| 10934–10997 | 64 | `handoff_manifest_files_match` |
| 10998–11006 | 9 | `previous_values_paths` |

## paths.rs（149 行）

| 源行区间 | 行数 | item |
| --- | --- | --- |
| 451–457 | 7 | `is_archive_task_dir` |
| 458–465 | 8 | `is_archive_snapshot_path` |
| 466–470 | 5 | `active_task_directory_from_relative` |
| 471–475 | 5 | `active_task_directory_from_path` |
| 491–515 | 25 | `normalize_snapshot_path` |
| 516–522 | 7 | `TaskPathParts` |
| 523–548 | 26 | `task_directory_from_path` |
| 549–566 | 18 | `task_directory_from_relative` |
| 567–574 | 8 | `is_archive_month` |
| 1387–1392 | 6 | `valid_cached_task_dir` |
| 1393–1400 | 8 | `valid_cached_snapshot_path` |
| 1401–1411 | 11 | `normalize_cached_dirs` |
| 10584–10590 | 7 | `absolute_task_path` |
| 10591–10598 | 8 | `task_directory_error` |

## cursor.rs（854 行）

| 源行区间 | 行数 | item |
| --- | --- | --- |
| 962–969 | 8 | `baselines_from_snapshot` |
| 970–984 | 15 | `merge_baselines` |
| 985–996 | 12 | `normalize_baselines` |
| 997–1005 | 9 | `file_state_from_group` |
| 1006–1020 | 15 | `baselines_by_task_dir` |
| 1021–1078 | 58 | `local_sync_state_from_groups` |
| 1079–1094 | 16 | `Cursor` |
| 1095–1103 | 9 | `PendingBatch` |
| 1104–1111 | 8 | `PendingRejection` |
| 1112–1176 | 65 | `cursor_from_entry` |
| 1177–1208 | 32 | `migrate_archive_pending_batch` |
| 1209–1247 | 39 | `cursor_entry_needs_archive_migration` |
| 5174–5185 | 12 | `TaskSync::load_cursor_state` |
| 5186–5195 | 10 | `TaskSync::read_cursor_state` |
| 5196–5215 | 20 | `TaskSync::read_cursor_event_state` |
| 5216–5226 | 11 | `TaskSync::read_cursor` |
| 5227–5316 | 90 | `TaskSync::write_cursor` |
| 5317–5320 | 4 | `TaskSync::migrate_cursor_archive_state` |
| 5321–5346 | 26 | `TaskSync::remove_task_cursor` |
| 5347–5372 | 26 | `TaskSync::update_pending_client_sequence` |
| 9641–9654 | 14 | `CursorPatch` |
| 9655–9693 | 39 | `apply_cursor_patch` |
| 9881–9888 | 8 | `next_client_sequence` |
| 10122–10134 | 13 | `clear_deferred_for_files` |
| 10135–10143 | 9 | `baselines_to_value` |
| 10144–10152 | 9 | `deferred_to_value` |
| 10153–10169 | 17 | `parse_baselines` |
| 10170–10191 | 22 | `parse_deferred` |
| 10192–10208 | 17 | `ownership_pending_to_value` |
| 10209–10217 | 9 | `conflict_blocked_to_value` |
| 10218–10225 | 8 | `readonly_task_dirs_to_value` |
| 10226–10233 | 8 | `readonly_reason` |
| 10234–10237 | 4 | `readonly_reason_assignee` |
| 10238–10258 | 21 | `parse_readonly_task_dirs` |
| 10259–10278 | 20 | `pending_rejected_to_value` |
| 10279–10338 | 60 | `parse_pending_rejected` |
| 10339–10355 | 17 | `trim_pending_rejections` |
| 10356–10380 | 25 | `parse_ownership_pending` |
| 10381–10405 | 25 | `parse_conflict_blocked` |
| 10406–10429 | 24 | `parse_pending_batch` |

## ownership_inbox.rs（894 行）

| 源行区间 | 行数 | item |
| --- | --- | --- |
| 1248–1252 | 5 | `OwnershipReview` |
| 1253–1259 | 7 | `OwnershipDecision` |
| 1260–1269 | 10 | `OwnershipResolution` |
| 5373–5380 | 8 | `TaskSync::local_files` |
| 5381–5389 | 9 | `TaskSync::local_groups` |
| 5390–5404 | 15 | `TaskSync::fetch_task_ownership` |
| 5405–5439 | 35 | `TaskSync::remember_ownership_reviews` |
| 5440–5466 | 27 | `TaskSync::clear_ownership_pending` |
| 5467–5536 | 70 | `TaskSync::settle_rejected_pending` |
| 5537–5563 | 27 | `TaskSync::clear_pending_rejections` |
| 5564–5598 | 35 | `TaskSync::mark_conflict_blocked` |
| 5599–5630 | 32 | `TaskSync::clear_conflict_blocked` |
| 5631–5656 | 26 | `TaskSync::mark_readonly_dir` |
| 5850–5865 | 16 | `TaskSync::control_assignee` |
| 5866–5899 | 34 | `TaskSync::local_task_state` |
| 5900–5999 | 100 | `TaskSync::reopen_conflicts` |
| 6000–6029 | 30 | `TaskSync::ownership_event` |
| 6030–6141 | 112 | `TaskSync::sync_ownership_inbox` |
| 6142–6151 | 10 | `TaskSync::read_ownership_inbox_task_id` |
| 6152–6203 | 52 | `TaskSync::put_ownership_inbox` |
| 6204–6386 | 183 | `TaskSync::resolve_task_ownership` |
| 6387–6437 | 51 | `TaskSync::resolve_group_ownership` |

## watch.rs（421 行）

| 源行区间 | 行数 | item |
| --- | --- | --- |
| 1300–1310 | 11 | `WatchEvent` |
| 1311–1317 | 7 | `WatchState` |
| 4903–5015 | 113 | `TaskSync::rebuild_watchers` |
| 5016–5151 | 136 | `TaskSync::watch_loop` |
| 10430–10436 | 7 | `is_watched_trellis_path` |
| 10437–10440 | 4 | `is_relevant_watch_event` |
| 10441–10451 | 11 | `git_head_branch_name` |
| 10452–10503 | 52 | `git_head_fingerprint` |
| 10504–10518 | 15 | `git_index_fingerprint` |
| 10519–10556 | 38 | `git_watch_paths` |
| 10557–10583 | 27 | `resolve_git_dir` |

## ownership_index.rs（402 行）

| 源行区间 | 行数 | item |
| --- | --- | --- |
| 1318–1323 | 6 | `OwnershipIndex` |
| 1324–1334 | 11 | `OwnershipIndex` |
| 1335–1366 | 32 | `OwnershipIndexBinding` |
| 1367–1379 | 13 | `OwnershipTaskIndex` |
| 1380–1386 | 7 | `OwnershipFileIndex` |
| 1412–1426 | 15 | `ownership_tasks_root_is_safe` |
| 1427–1536 | 110 | `normalize_index` |
| 1537–1552 | 16 | `load_ownership_index` |
| 1553–1577 | 25 | `indexed_ownership_projection` |
| 1578–1614 | 37 | `indexed_local_groups` |
| 1615–1621 | 7 | `HeadTreeCache` |
| 1622–1634 | 13 | `OwnershipProjectionCache` |
| 1635–1640 | 6 | `ProjectionEpoch` |
| 1641–1645 | 5 | `OwnershipValidationState` |
| 1646–1655 | 10 | `ownership_projection_cache_matches` |
| 1794–1804 | 11 | `TaskSync::ensure_ownership_index_loaded` |
| 3266–3302 | 37 | `TaskSync::persist_ownership_index` |
| 3303–3323 | 21 | `TaskSync::retain_ownership_index_bindings` |
| 3324–3343 | 20 | `TaskSync::discard_ownership_index_binding` |

## control.rs（594 行）

| 源行区间 | 行数 | item |
| --- | --- | --- |
| 1779–1784 | 6 | `TaskSync::wake_heartbeat` |
| 1805–1825 | 21 | `TaskSync::ensure_task_control_loaded` |
| 1826–1849 | 24 | `TaskSync::merge_task_controls` |
| 1850–1870 | 21 | `TaskSync::upsert_task_control` |
| 1871–1892 | 22 | `TaskSync::upsert_task_handoff_control` |
| 1893–1901 | 9 | `TaskSync::stored_task_handoff` |
| 1902–1928 | 27 | `TaskSync::mark_handoff_ack_pending` |
| 1929–1935 | 7 | `TaskSync::mark_handoff_ack_done` |
| 1936–1955 | 20 | `TaskSync::emit_handoff_notice` |
| 1956–1978 | 23 | `TaskSync::persist_task_control_change` |
| 1979–2007 | 29 | `TaskSync::save_task_lease` |
| 2008–2017 | 10 | `TaskSync::stored_task_lease` |
| 2018–2026 | 9 | `TaskSync::has_persisted_task_control` |
| 2027–2032 | 6 | `TaskSync::remove_task_lease` |
| 2033–2044 | 12 | `TaskSync::update_control_task_version` |
| 2045–2080 | 36 | `TaskSync::claim_remote_task` |
| 2081–2116 | 36 | `TaskSync::heartbeat_remote_task` |
| 2117–2132 | 16 | `TaskSync::release_remote_task` |
| 2133–2145 | 13 | `TaskSync::ack_remote_handoff` |
| 2146–2186 | 41 | `TaskSync::attempt_handoff_ack` |
| 3060–3078 | 19 | `TaskSync::process_handoff_controls` |
| 3079–3116 | 38 | `TaskSync::remote_task_control` |
| 3117–3171 | 55 | `TaskSync::prepare_controlled_server_groups` |
| 3172–3226 | 55 | `TaskSync::release_inactive_task_leases` |
| 3227–3265 | 39 | `TaskSync::persisted_control_key_for_upload` |

## root task_sync.rs（178 行）

| 源行区间 | 行数 | item |
| --- | --- | --- |
| 22–22 | 1 | `TASK_SNAPSHOT_MAX_FILES` |
| 23–23 | 1 | `TASK_SNAPSHOT_MAX_FILE_BYTES` |
| 24–24 | 1 | `TASK_SNAPSHOT_MAX_BATCH_BYTES` |
| 25–25 | 1 | `OWNERSHIP_INDEX_VERSION` |
| 26–26 | 1 | `ACTIVE_TASKS_ROOT` |
| 27–27 | 1 | `ARCHIVE_TASKS_ROOT` |
| 28–28 | 1 | `OWNERSHIP_INDEX_MAX_BYTES` |
| 29–29 | 1 | `OWNERSHIP_INDEX_MAX_BINDINGS` |
| 30–30 | 1 | `OWNERSHIP_INDEX_MAX_TASKS` |
| 31–31 | 1 | `OWNERSHIP_INDEX_MAX_FILES` |
| 32–32 | 1 | `OWNERSHIP_INDEX_MAX_TRACKED_PATHS` |
| 33–33 | 1 | `CURSOR_VERSION` |
| 34–34 | 1 | `REVISION_GUARD_VERSION` |
| 35–35 | 1 | `REVISION_GUARD_SYNC_MODE` |
| 36–36 | 1 | `CONFLICT_SYNC_MODE` |
| 37–37 | 1 | `PENDING_REJECTED_LIMIT` |
| 38–38 | 1 | `OWNERSHIP_INBOX_MAX_CHANGES` |
| 39–39 | 1 | `TASK_OWNERSHIP_QUERY_LIMIT` |
| 40–40 | 1 | `HANDOFF_MAX_FILES` |
| 41–41 | 1 | `HANDOFF_MAX_BYTES` |
| 42–42 | 1 | `HANDOFF_MANIFEST_FILE` |
| 43–43 | 1 | `HANDOFF_META_FILE` |
| 44–44 | 1 | `UPLOAD_MIN_INTERVAL` |
| 45–45 | 1 | `RATE_LIMIT_RETRY_DELAY` |
| 46–46 | 1 | `RATE_LIMIT_RETRY_MAX_DELAY` |
| 47–47 | 1 | `MAX_RATE_LIMIT_RETRIES` |
| 48–48 | 1 | `SNAPSHOT_EXTENSIONS` |
| 49–49 | 1 | `WATCH_DEBOUNCE` |
| 50–51 | 2 | `SYNC_TRACE_ENV` |
| 52–53 | 2 | `OWNERSHIP_PROJECTION_CACHE_TTL` |
| 54–63 | 10 | `BRANCH_GUARD_CODES` |
| 1670–1714 | 45 | `TaskSync` |
| 1715–9627 | 7913 | `TaskSync` |
| 1716–1762 | 47 | `TaskSync::new` |
| 1763–1768 | 6 | `TaskSync::with_ownership_index_writer` |
| 1769–1773 | 5 | `TaskSync::with_state_sink` |
| 1774–1778 | 5 | `TaskSync::with_heartbeat_wake` |
| 9628–9633 | 6 | `Drop` |

## ownership.rs（967 行）

| 源行区间 | 行数 | item |
| --- | --- | --- |
| 3720–3745 | 26 | `TaskSync::assert_binding_branch` |
| 3746–3754 | 9 | `TaskSync::binding_head` |
| 3755–3765 | 11 | `TaskSync::head_tree_paths` |
| 3766–3800 | 35 | `TaskSync::head_tree_paths_for_commit` |
| 3801–3817 | 17 | `TaskSync::projected_head_tree_paths` |
| 3818–3824 | 7 | `TaskSync::invalidate_ownership_projection` |
| 3825–3839 | 15 | `TaskSync::projection_epoch` |
| 3840–3857 | 18 | `TaskSync::projection_epoch_matches` |
| 3858–3872 | 15 | `TaskSync::cache_ownership_projection` |
| 3873–3911 | 39 | `TaskSync::task_worktree_dirty_dirs` |
| 3912–3954 | 43 | `TaskSync::task_head_changed_dirs` |
| 3955–4143 | 189 | `TaskSync::scan_ownership_index_files` |
| 4144–4152 | 9 | `TaskSync::refresh_ownership_index_binding` |
| 4153–4460 | 308 | `TaskSync::refresh_ownership_index_binding_with_scan` |
| 4461–4509 | 49 | `TaskSync::validate_ownership_binding` |
| 4510–4518 | 9 | `TaskSync::enqueue_ownership_validation` |
| 4519–4555 | 37 | `TaskSync::ensure_ownership_validation_worker` |
| 4556–4642 | 87 | `TaskSync::ownership_projection` |
| 4643–4668 | 26 | `TaskSync::ownership_paused_task_dirs` |
| 4669–4672 | 4 | `TaskSync::baseline_owned_key` |
| 4673–4679 | 7 | `TaskSync::baseline_owned` |
| 4680–4686 | 7 | `TaskSync::mark_baseline_owned` |

## local_files.rs（576 行）

| 源行区间 | 行数 | item |
| --- | --- | --- |
| 5657–5666 | 10 | `TaskSync::cleanup_archived_controls` |
| 5667–5712 | 46 | `TaskSync::prune_readonly_dirs` |
| 5713–5763 | 51 | `TaskSync::cleanup_archived_residue` |
| 5764–5849 | 86 | `TaskSync::download_task` |
| 10599–10635 | 37 | `resolve_task_directory` |
| 10636–10683 | 48 | `archived_task_copies` |
| 10705–10747 | 43 | `task_directory_digest` |
| 10748–10798 | 51 | `write_task_directory` |
| 10803–10867 | 65 | `copy_directory` |
| 10868–10900 | 33 | `task_directory_file_paths` |
| 11007–11098 | 92 | `read_local_task_snapshot_files` |
| 11099–11112 | 14 | `urlencode` |

## pull.rs（675 行）

| 源行区间 | 行数 | item |
| --- | --- | --- |
| 6438–6449 | 12 | `TaskSync::fetch_snapshot` |
| 6450–6474 | 25 | `TaskSync::fetch_directory` |
| 6475–6490 | 16 | `TaskSync::write_server_cursor` |
| 6491–6564 | 74 | `TaskSync::apply_server_groups` |
| 6565–6586 | 22 | `TaskSync::remove_task_directory` |
| 6587–6598 | 12 | `TaskSync::backup_directory` |
| 6599–6629 | 31 | `TaskSync::backup_directory_with_id` |
| 6630–6651 | 22 | `TaskSync::suppressed_event` |
| 6652–6669 | 18 | `TaskSync::local_sync_state` |
| 6670–6702 | 33 | `TaskSync::local_metadata_groups` |
| 6703–6708 | 6 | `TaskSync::pull_task_space` |
| 6709–6726 | 18 | `TaskSync::pull_task_space_tracking` |
| 6727–6760 | 34 | `TaskSync::pull_task_space_for_event` |
| 6761–6766 | 6 | `TaskSync::pull` |
| 6767–7112 | 346 | `TaskSync::pull_tracking` |

## initial_sync.rs（1036 行）

| 源行区间 | 行数 | item |
| --- | --- | --- |
| 7113–7346 | 234 | `TaskSync::repair_revision_guard` |
| 7347–7530 | 184 | `TaskSync::pull_initial_sync` |
| 7531–7539 | 9 | `TaskSync::emit_differences` |
| 7540–7583 | 44 | `TaskSync::complete_initial_sync` |
| 7584–7607 | 24 | `TaskSync::upload_dirty` |
| 7608–7724 | 117 | `TaskSync::reconcile_baseline_tasks` |
| 8927–9139 | 213 | `TaskSync::resolve_initial_sync` |
| 9140–9216 | 77 | `TaskSync::upload_reviewed_local_task` |
| 9694–9709 | 16 | `should_pull_for_event` |
| 9763–9776 | 14 | `initial_sync_mode` |
| 9777–9788 | 12 | `retain_server_groups_for_binding` |
| 9789–9792 | 4 | `binding_is_baseline` |
| 9793–9799 | 7 | `allows_cross_source_server_group` |
| 9800–9818 | 19 | `retain_server_groups_for_revision_guard` |
| 9819–9837 | 19 | `retain_server_groups_for_initial_sync` |
| 9838–9861 | 24 | `hide_control_tombstone_local_only` |
| 9862–9870 | 9 | `inactive_control_dirs` |
| 9871–9880 | 10 | `snapshot_revision` |

## sync_api.rs（336 行）

| 源行区间 | 行数 | item |
| --- | --- | --- |
| 7725–7745 | 21 | `TaskSync::claim_execution_task` |
| 7746–7758 | 13 | `TaskSync::sync_task_directories` |
| 7759–7771 | 13 | `TaskSync::sync_task_directories_with_base` |
| 7772–7851 | 80 | `TaskSync::list_task_ownership` |
| 7852–8018 | 167 | `TaskSync::set_task_ownership` |
| 8019–8060 | 42 | `TaskSync::sync_deferred_tasks` |

## upload.rs（941 行）

| 源行区间 | 行数 | item |
| --- | --- | --- |
| 8061–8403 | 343 | `TaskSync::upload_directories` |
| 8404–8436 | 33 | `TaskSync::upload_persisted_batch` |
| 8437–8468 | 32 | `TaskSync::upload_preclassified_batch` |
| 8469–8480 | 12 | `TaskSync::retry_pending_batch` |
| 8481–8877 | 397 | `TaskSync::upload_batch` |
| 8878–8926 | 49 | `TaskSync::upload_with_slot` |
| 9912–9941 | 30 | `execution_task_keys_from_upload` |
| 9942–9954 | 13 | `response_control_execution_task_key` |
| 9955–9975 | 21 | `build_upload_request` |
| 9976–9986 | 11 | `pending_task_dirs` |

## conflict.rs（471 行）

| 源行区间 | 行数 | item |
| --- | --- | --- |
| 9217–9445 | 229 | `TaskSync::decide_conflict` |
| 9446–9526 | 81 | `TaskSync::conflict_details` |
| 9527–9546 | 20 | `TaskSync::fetch_conflicts` |
| 9547–9562 | 16 | `TaskSync::resolve_conflict` |
| 9563–9627 | 65 | `TaskSync::conflict_directories` |
| 9634–9640 | 7 | `ConflictDirectories` |
| 9710–9720 | 11 | `conflict_task_directories` |
| 9721–9750 | 30 | `conflict_is_archive_only` |
| 9751–9762 | 12 | `conflict_summary` |
