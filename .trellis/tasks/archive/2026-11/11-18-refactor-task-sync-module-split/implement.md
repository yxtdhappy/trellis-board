# 实施记录：task_sync.rs 模块拆分

状态：代码已完成并验证，等待提交确认。全程只做搬移，未改逻辑（见 §4 等价性证据）。

## 1. 执行方式

计划中的"逐模块手工搬移"实际按机械 codemod 执行：从源文件机械提取每个 item（含其 `///`/`#[attr]` 块）的行区间，按 design.md §2 的模块归属切片写出，避免手工复制引入偏差。

- 私有 item / 方法 / 结构体字段统一加 `pub(super)`；`pub`、`pub(crate)` 原样保留。
- 单一大 `impl TaskSync { ... }`（原 1715–9626）按模块边界切片，每个子模块内的片段重新包成 `impl TaskSync { ... }`；根文件保留构造方法并闭合 impl。
- 根文件按原可见性重导出（`pub use` / `pub(crate) use` / `use`），重导出块加 `#[allow(unused_imports)]`：同一批符号被 bin 与 test 两个编译目标分别使用，单目标分析必然误报。
- 子模块首行 `use super::*;`，从根文件取到私有 import 与重导出。

## 2. 结果

| 文件 | 行数 |
| --- | ---: |
| `agent/task_sync.rs`（根） | 394 |
| `task_sync/handoff.rs` | 1122 |
| `task_sync/initial_sync.rs` | 1033 |
| `task_sync/ownership.rs` | 992 |
| `task_sync/upload.rs` | 945 |
| `task_sync/ownership_inbox.rs` | 910 |
| `task_sync/cursor.rs` | 835 |
| `task_sync/bindings.rs` | 695 |
| `task_sync/pull.rs` | 692 |
| `task_sync/snapshot.rs` | 662 |
| `task_sync/control.rs` | 621 |
| `task_sync/local_files.rs` | 575 |
| `task_sync/conflict.rs` | 472 |
| `task_sync/watch.rs` | 416 |
| `task_sync/ownership_index.rs` | 395 |
| `task_sync/sync_api.rs` | 344 |
| `task_sync/paths.rs` | 137 |
| `task_sync/errors.rs` | 116 |
| `task_sync/tests/cursor_state.rs` | 1104 |
| `task_sync/tests/ownership_projection.rs` | 978 |
| `task_sync/tests/pull_and_startup.rs` | 614 |
| `task_sync/tests/support.rs` | 607 |
| `task_sync/tests/snapshot_files.rs` | 601 |
| `task_sync/tests/handoff_and_errors.rs` | 522 |
| `task_sync/tests/bindings_watch.rs` | 384 |
| `task_sync/tests/mod.rs` | 11 |

根文件 394 ≤ 500；最大子文件 1122 ≤ 1200；测试文件最大 1104 ≤ 1200。

## 3. 门禁结果

| 门禁 | 结果 |
| --- | --- |
| G0 基线 | 拆分前 15798 行；`cargo check --all-targets` 6 条 warning；`cargo test` 全绿 |
| G1 骨架 | `foo.rs` + `foo/` 共存成立，`agent/mod.rs` 与全部外部 `crate::agent::task_sync::X` 路径未改一字 |
| G2–G4 搬移 | `cargo check --all-targets` 通过；新增报错仅三类（重导出可见性、私有字段、impl 闭合），逐类修正后再无业务代码改动 |
| G5 测试拆分 | 107 个测试 + 16 个 fixture 全部落位，测试名集合与拆分前一致 |
| G6 收尾 | `cargo test` 232 passed / 0 failed；warning 6 条 = 基线；改动范围仅 `task_sync.rs` 与 `task_sync/` |

## 4. 等价性证据

1. **测试集合**：拆分前 `task_sync::tests` 内带 `#[test]`/`#[tokio::test]` 的函数名（107 个）与拆分后 `cargo test -- --list` 中 `agent::task_sync::tests::` 前缀的名字逐项比对，差集为空。
2. **行内容多重集**：把拆分后所有文件的行做归一化（去掉 `pub(super) ` 前缀、`impl TaskSync {` 包裹、`use super::*;` 与根重导出行、测试文件回退 4 空格缩进）后与拆分前文件按多重集比较，缺失仅 1 行为 `mod tests {`（现在是 `mod tests;`）；多出部分全部是 155 个 `impl TaskSync {` 包裹、154 个对应闭合 `}`、13 个多行重导出闭合 `};` 及其成员行。即：**没有任何一行代码内容被改写**。
3. **编译告警**：拆分后 6 条 warning 与基线逐条对应（pull.rs/initial_sync.rs 各 1 个多余 `mut`、handoff.rs 3 个未读赋值、task_control.rs 1 个未使用方法），没有新增。

## 5. 与计划的偏差

- 测试文件划分按实际测试名归类为 6 个主题文件：`cursor_state`、`snapshot_files`、`ownership_projection`、`bindings_watch`、`handoff_and_errors`、`pull_and_startup`（计划里的 `upload_flow`/`initial_sync`/`handoff_conflict` 名称对应调整；`upload_*`/`pending_*` 归入 `cursor_state`，`initial_sync`/`pull` 归入 `pull_and_startup`）。
- `conflict.rs` 最后一个方法区间实际到 9625：9626 是原 `impl TaskSync` 的闭合 `}`，不属于任何 item。
- `task_sync/tests/mod.rs` 承载 `use crate::agent::store::AgentConfig;` 与 `use tokio::io::{AsyncReadExt, AsyncWriteExt};`，子文件用 `use super::*;` 继承。
- 已按 6.7 更新 `.trellis/spec/desktop/tauri-commands/index.md`：新增"agent 大模块的目录化拆分"场景（布局、可见性契约、验证矩阵）。

## 6. 提交

- 范围：`packages/desktop/src-tauri/src/agent/task_sync.rs`、`packages/desktop/src-tauri/src/agent/task_sync/`、`.trellis/spec/desktop/tauri-commands/index.md`、本任务目录。
- 信息：`refactor(desktop): 拆分 task_sync.rs 为职责子模块`，正文列模块清单与"行为不变"证据。

## 回滚点

| 回滚点 | 操作 |
| --- | --- |
| 任意阶段 | `git checkout -- packages/desktop/src-tauri/src/agent/task_sync.rs && rm -rf packages/desktop/src-tauri/src/agent/task_sync` |

## 执行约束（本轮已遵守）

- 逐字节搬移：不改数值、字符串、错误文案、注释措辞、item 顺序。
- 未跑 `cargo fmt`、未做 clippy 清理、未改其他文件。
