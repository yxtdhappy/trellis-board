# 实施计划：修复任务归属确认被非 UTF-8 文件整体阻断

## 改动清单

### 1. 错误消息带任务文件相对路径

- [x] `packages/desktop/src-tauri/src/agent/task_sync/local_files.rs`
  - `read_local_task_snapshot_files` 的 `String::from_utf8` 失败处改为：
    `任务文件不是有效的 UTF-8 文本：{relative}`。
  - `task_directory_digest` 保持现状（错误不外露，避免额外参数）。
- [x] `packages/desktop/src-tauri/src/agent/task_sync/ownership.rs`
  - ownership 索引扫描的 `String::from_utf8` 失败处改为：
    `任务文件不是有效的 UTF-8 文本：{relative}`。
- [x] `packages/desktop/src-tauri/src/agent/task_command.rs`
  - `read_task_json_opt(path)` → `read_task_json_opt(path, label)`；
  - `read_utf8(path)` → `read_utf8(path, label)`；
  - 失败消息改为 `任务文件不是有效的 UTF-8 文本：{label}`；
  - 调用点传入 `.trellis/tasks/<dir>/task.json`。

### 2. 归属确认收敛扫描范围

- [x] `packages/desktop/src-tauri/src/agent/task_sync/sync_api.rs` 的 `set_task_ownership`：
  - 先解析并校验 decisions，收集 `selected`；
  - 用 `self.local_groups(&binding, Some(&selected))` 替代 `None`；
  - 再对每个 decision 校验目录存在性（保持原错误文案“任务归属决定包含无效的任务目录”）；
  - 后续 `task_ids`、`pending`、`sync_ownership_inbox`、`sync_task_directories` 逻辑未改。

### 3. 回归测试

- [x] `packages/desktop/src-tauri/src/agent/task_sync/tests/snapshot_files.rs`
  - `local_task_scan_reports_invalid_utf8_path`：错误包含相对路径，且不包含仓库绝对路径。
- [x] `packages/desktop/src-tauri/src/agent/task_sync/tests/ownership_projection.rs`
  - `ownership_index_reports_invalid_utf8_path`：索引全量扫描错误包含相对路径。
- [x] `packages/desktop/src-tauri/src/agent/task_sync/tests/ownership_inbox.rs`
  - `assign_ownership_ignores_invalid_utf8_in_sibling_task_dir`：兄弟目录坏文件不阻断归属。
  - `assign_ownership_reports_target_invalid_utf8_path`：目标任务坏文件仍然失败且带路径。

## 验证

开发期间不编译。全部代码与测试改完后，只执行一次完整验证：

```bash
cd packages/desktop/src-tauri
cargo test agent::task_sync agent::task_command
```

**执行记录（2026-11-23）**：
- 本机没有 Rust 工具链（`cargo`/`rustc` 均不存在），本地上述命令**未执行**。
- GitHub Actions 在 tag `v0.4.57` 上执行 `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`：
  run `45107316470`，`376 passed; 0 failed`；4 个新增测试全部通过。

已完成的非编译检查：

```bash
git diff --check                                  # 通过
rg -n "任务文件不是有效的 UTF-8 文本" packages/desktop/src-tauri/src
# 用户可见路径均已带 {relative}/{label}；仅 task_directory_digest 保留旧文案（错误不外露）
rg -n "local_groups\(&binding, None\)" packages/desktop/src-tauri/src/agent/task_sync/sync_api.rs
# 仅 list_task_ownership 保留全量扫描；set_task_ownership 已改为定向扫描
```

## 回滚点

- 单次改动集中在一个 commit；回滚即还原该 commit。
- 无数据迁移、无服务端变更，回滚后旧客户端/服务端行为不受影响。

## Review Gate

- [x] PRD 的验收标准逐条对应测试或静态检查。
- [x] 不修改 `.trellis/tasks/archive/**` 扫描语义。
- [x] 不引入绝对路径到错误文案。
- [x] 不改变服务端 API/schema。
- [x] 在具备 Rust 工具链的环境补跑 `cargo test agent::`（已由 CI run `45107316470` 完成，376 通过）。