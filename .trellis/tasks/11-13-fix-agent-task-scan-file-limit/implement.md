# 实施计划

## 变更文件

- `apps/desktop/src-tauri/src/agent/task_sync.rs`
- 如规范需要，更新 `.trellis/spec/backend/desktop-agent-runtime.md`

## 步骤

- [ ] 在 `task_sync.rs` 中新增 `validate_upload_batch`，只校验实际数组的 1024 文件和 64 MiB 上限。
- [ ] 从 `group_task_snapshot_files` 移除全量文件数和聚合大小校验，保留逐文件校验、重复路径和目录分组规则。
- [ ] 在 `upload_persisted_batch` 写 pending 前调用上传批次校验。
- [ ] 在 `retry_pending_batch` 上传旧 pending 前调用同一校验。
- [ ] 新增 Rust 单元测试：1100 文件跨两个目录可分组；1024 可上传；1025 在 pending 前拒绝；64 MiB 边界正确。
- [ ] 确认全量快照分组、初始同步、增量 pull、删除墓碑和 move pair 仍使用原分组语义。

## 验证

本轮实施后执行：

```powershell
git diff --check
npx oxfmt --check apps/desktop/src-tauri/src/agent/task_sync.rs
node --test apps/server/test/team-task-snapshot.test.js packages/shared/test/task-snapshot.test.js
npm run check:boundaries
```

Rust 工具链存在时追加：

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml agent::task_sync
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
```

当前机器已确认没有 `cargo`、`rustc`、`tauri`；若实施时仍缺失，必须在检查报告中明确标记 Rust 编译未执行。

## 完成门禁

- [ ] 全量扫描聚合超过 1024 不再报批次错误。
- [ ] 实际 1025 文件批次仍在 pending 写入前失败。
- [ ] 64 MiB 边界和原有分组校验不退化。
- [ ] 不修改服务端协议、任务数据、限额常量或历史归档。
