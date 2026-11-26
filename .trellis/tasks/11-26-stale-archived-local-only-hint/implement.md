# 实施计划：已归档任务接入误报及 `deferred` 残留自愈

## 有序实施清单

### Step 1：服务端归档识别补齐（`packages/server`）
1. 修改 `packages/server/team/task-space/shared.js`：新增 `preflightArchivedDirs` SQL，查询当前任务空间活跃归档快照的 `sync_archive_file.task_dir`。
2. 修改 `packages/server/team/task-space/access.js`：在 `preflight()` 中将 `preflightArchivedDirs` 的目录与 basename 合并到 `hiddenTaskDirs` / `archivedTaskBasenames`。
3. 修改 `packages/server/team/task-control/shared.js`：新增 `readArchivedFileByBasename` SQL。
4. 修改 `packages/server/team/task-control/views.js`：在 `assertReadable()` 中复用 `sync_task` + `sync_archive_file` 双源归档判定，命中抛 `409 TASK_ARCHIVED`。
5. 修改 `packages/server/team/task-control/uploads.js`：在 `assertUploadAllowed()` 中对 `sync_task` 不存在的新上传目录同样校验双源归档判定，命中抛 `409 TASK_ARCHIVED`。
6. 补充服务端测试：
   - `packages/server/test/team-task-spaces.test.js`：覆盖仅存在于 `sync_archive_file`（无 `sync_task` 行）时的 `preflight.archivedTaskBasenames`（包含带 `archive_snapshot_id` 与历史 `NULL` 快照场景）。
   - `packages/server/test/team-task-control.test.js`：覆盖 `assertReadable` 与 `assertUploadAllowed` 对仅在 `sync_archive_file` 归档任务的 `409 TASK_ARCHIVED` 拦截。

### Step 2：桌面端 `deferred` 自动清理（`packages/desktop`）
1. 修改 `packages/desktop/src-tauri/src/agent/task_sync/cursor.rs`：更新 `local_sync_state_from_groups`，当 `local_state.is_empty()` 且 `server_baselines`、`cursor_baselines` 均无该目录时从 `next_deferred` 移除。
2. 修改 `packages/desktop/src-tauri/src/agent/task_sync/upload.rs`：扩展 `prunable_task_directories` 支持 `cursor.deferred`，并在 `upload_directories` 调用处传入 `&cursor.deferred`。
3. 补充桌面端 Rust 单元测试：
   - `packages/desktop/src-tauri/src/agent/task_sync/tests/pull_and_startup.rs`：
     - 新增测试：仅在 `deferred` 且 `server_baselines`/`cursor_baselines` 均无记录的任务，本地目录消失后自动从 `deferred` 清除且不产生 `dirty`。
     - 验证既有测试 `missing_local_directory_keeps_deferred_protected` 保持通过。
   - `packages/desktop/src-tauri/src/agent/task_sync/tests/cursor_state.rs`（或对应 `prunable_task_directories` 测试文件）：新增测试验证仅在 `cursor.deferred` 中的已消失目录可被 `prunable_task_directories` 清理。

### Step 3：质量检查、格式化与 API E2E 验证
1. 格式化与 Lint（Prettier + ESLint 检查变更的 JS 文件）。
2. 运行服务端测试：
   - `node --test packages/server/test/team-task-spaces.test.js packages/server/test/team-task-control.test.js`
3. 运行桌面端 Rust 测试：
   - `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml task_sync`
   - `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml association`
4. 按 `trellis-check` 与 `trellis-api-e2e`（后端接口有行为变更，按规则评估/执行本地 API E2E 并写入 `api-e2e-report.md`）完成检查。
5. 评估是否需要更新 `.trellis/spec/` 文档。

## 风险点与回滚点

- **风险点**：`sync_archive_file` 可能存在多份历史快照，SQL 必须严格限定在当前活跃快照 `COALESCE(s.archive_candidate_snapshot_id, s.archive_snapshot_id)`（或两者均为 `NULL` 时的兼容行），避免命中已被淘汰的旧归档快照。
- **风险点**：`local_sync_state_from_groups` 必须严格校验 `!has_server_baseline && !has_cursor_baseline`，防止把服务端已有任务的本地临时缺失误清或误删。
- **回滚点**：Step 1（服务端）与 Step 2（桌面端）相互独立且向后兼容，可单独验证和回滚。
