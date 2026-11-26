# Implementation Report: 11-26-stale-archived-local-only-hint

## 修改文件
- `packages/server/team/task-space/shared.js`: 新增 `preflightArchivedDirs` SQL，查询当前活跃归档快照的 `sync_archive_file.task_dir`。
- `packages/server/team/task-space/access.js`: `preflight()` 将活跃归档快照中的任务目录与 basename 合并到 `hiddenTaskDirs` 与 `archivedTaskBasenames`。
- `packages/server/team/task-control/shared.js`: 新增 `readArchivedFileByBasename` SQL。
- `packages/server/team/task-control/views.js`: 抽取 `isArchivedTaskDir` 并在 `assertReadable()` 中同时检查 `sync_task` 与 `sync_archive_file` 活跃快照，命中抛 `409 TASK_ARCHIVED`。
- `packages/server/team/task-control/uploads.js`: `assertUploadAllowed()` 在无 `sync_task` 行时检查 `isArchivedTaskDir`，命中抛 `409 TASK_ARCHIVED`。
- `packages/desktop/src-tauri/src/agent/task_sync/cursor.rs`: `local_sync_state_from_groups` 在 `local_state.is_empty()` 且 `server_baselines` 与 `cursor_baselines` 均无该目录时自动移除 `deferred`。
- `packages/desktop/src-tauri/src/agent/task_sync/upload.rs`: `prunable_task_directories` 同时检查 `cursor.baselines` 与 `cursor.deferred`。
- 单元测试：`packages/server/test/team-task-spaces.test.js`、`packages/server/test/team-task-control.test.js`、`packages/desktop/src-tauri/src/agent/task_sync/tests/pull_and_startup.rs`、`packages/desktop/src-tauri/src/agent/task_sync/tests/upload_cleanup.rs`。

## 关键决策
- 活跃归档快照口径统一为 `COALESCE(s.archive_candidate_snapshot_id, s.archive_snapshot_id)`（兼容旧库 `NULL`），避免误命中已淘汰历史快照。
- `cursor.deferred` 清理严格要求 `!has_server_baseline && !has_cursor_baseline`，保留服务端存活任务的防误删保护。

## 验证命令与结果
- `npx oxfmt --check`（变更的 7 个 JS 文件）：通过
- `node --test packages/server/test/team-task-spaces.test.js packages/server/test/team-task-control.test.js packages/server/test/team-gitless-http.test.js`：49/49 通过
- `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml task_sync::tests::pull_and_startup`：26/26 通过
- `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml task_sync::tests::upload_cleanup`：5/5 通过
- `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml association::tests`：7/7 通过
- L3 实机 E2E（隔离 Team 服务端 + 自构建真实 Tauri 客户端 + WebView2 CDP）：AC1/AC2/AC3 全部通过（见 `e2e-report.md`）。

## 遗留风险
- 无阻断性风险。
