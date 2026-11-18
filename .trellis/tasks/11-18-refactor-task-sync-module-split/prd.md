# 拆分重构 task_sync.rs 万行巨型模块

## Goal

把 `packages/desktop/src-tauri/src/agent/task_sync.rs`（15798 行）按职责拆成一组可维护的子模块，**行为、协议、公开 API 完全不变**，只做代码搬移与模块边界划分。

## Background / 已确认事实

- 文件 15798 行，构成极不均衡：`impl TaskSync` 单块占 1715–9627 行（约 7900 行），顶层自由函数 1–1714 与 9634–11112 行（约 3200 行），`#[cfg(test)] mod tests` 占 11113–15798 行（约 4686 行，30%）。
- 外部引用面很小且固定：`association.rs`、`detach.rs`、`device.rs`、`runtime.rs`、`task_command.rs`、`agent_service.rs` 只用到 17 个符号（`SnapshotFile`、`SnapshotGroup`、`Difference`、`DiffKind`、`ControlSink`、`TaskSync`、`normalize_snapshot_path`、`task_directory_from_path`、`task_directory_from_relative`、`group_task_snapshot_files`、`classify_task_snapshots`、`snapshot_sha256`、`read_local_task_snapshot_files`、`load_ownership_index`、`OwnershipIndex`、`ownership_tasks_root_is_safe`、`indexed_ownership_projection`、`active_task_directory_from_path`、`is_archive_task_dir`、`is_branch_guard_code`、`parse_directory_files`、`urlencode`）。
- 文件里已有天然的责任分区：快照模型与分类、游标/持久化状态、ownership 索引、handoff 备份清理、pull/上传管线、冲突处理、文件监听、本地文件读写。
- 同 crate 内其他模块已按 `agent/<name>.rs` 平铺组织（`agent/mod.rs`），`task_sync` 是唯一万行级文件。
- CI 的 Rust 验证入口固定：`.github/workflows/windows.yml:151` `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`。
- Rust 模块隐私规则允许拆分：子模块是 `task_sync` 的后代，可以访问 `task_sync.rs` 中 `TaskSync` 的私有字段与私有函数；`impl TaskSync` 可以分散在多个子模块中。

## Requirements

### R1 模块拆分

- R1.1 `task_sync.rs` 保留为**模块根**（不改成 `task_sync/mod.rs`），只保留：imports、常量、`TaskSync` 结构体定义与字段、构造函数/`with_*` 构建方法、`mod` 声明与向后兼容的 `pub use` 重导出。
- R1.2 业务代码下沉到 `task_sync/` 子目录，按职责分文件；每个子文件目标 ≤ 1200 行。
- R1.3 测试下沉到 `task_sync/tests/`，按主题分文件；测试共享 fixture 单独归档。
- R1.4 拆分后 `task_sync.rs` 根文件目标 ≤ 500 行。

### R2 行为与契约不变

- R2.1 不改任何业务逻辑、常量值、协议字段、错误文案、事件 payload、限流/重试时序。
- R2.2 `crate::agent::task_sync::<符号>` 的所有现有引用路径保持不变（靠根文件重导出），不在 `task_sync` 之外产生任何文件改动。
- R2.3 不新增依赖，不改 `Cargo.toml`。
- R2.4 不运行全仓格式化：搬移代码保持逐字节一致，避免制造与逻辑无关的 diff 噪声。

### R3 可见性收敛

- R3.1 仅对现有外部消费者暴露的符号使用 `pub`；子模块内部互调使用 `pub(super)` / `pub(crate)`。
- R3.2 不因为拆分而扩大可见性（不把私有函数改成 `pub`），也不引入新的抽象层（不为拆分新增 trait、wrapper、facade 结构体）。

## Acceptance Criteria

- [ ] `packages/desktop/src-tauri/src/agent/task_sync.rs` ≤ 500 行，只含 imports/常量/`TaskSync` 定义与构建方法/`mod` 与重导出。
- [ ] `task_sync/` 下每个子文件 ≤ 1200 行（fixture 文件允许 ≤ 900 行）。
- [ ] `git diff --stat` 显示 `task_sync.rs` 与 `task_sync/` 之外**没有**生产代码改动。
- [ ] 拆分前后测试数量一致（`cargo test -- --list` 计数相等），全部通过。
- [ ] `cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml --all-targets` 通过，warning 数量不高于拆分前基线。
- [ ] 抽查 diff 确认搬移内容为原样文本（无逻辑改写、无重命名、无重排）。
- [ ] 桌面端 `cargo test` 全绿，且与拆分前基线逐条一致。

## Out of Scope

- 不改任务同步的数据面逻辑（上传/下载/冲突/归属判定/游标语义）。
- 不重命名任何函数、结构体、常量或错误码。
- 不调整 `TaskSync` 的字段布局、锁粒度或并发模型。
- 不重构 `task_sync` 之外的文件（即使发现重复代码）。
- 不做跨文件"顺手"优化、不做 clippy 清理、不引入新依赖。

## Open Questions

（无）
