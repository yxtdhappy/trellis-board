# 检查报告：修复任务归属确认被非 UTF-8 文件整体阻断

日期：2026-11-23

## 变更范围

| 文件 | 变更 |
| --- | --- |
| `packages/desktop/src-tauri/src/agent/task_sync/sync_api.rs` | `set_task_ownership` 先解析 decisions，再只扫描涉及的 taskDir |
| `packages/desktop/src-tauri/src/agent/task_sync/local_files.rs` | 快照扫描 UTF-8 错误带相对路径 |
| `packages/desktop/src-tauri/src/agent/task_sync/ownership.rs` | ownership 索引扫描 UTF-8 错误带相对路径 |
| `packages/desktop/src-tauri/src/agent/task_command.rs` | `read_task_json_opt` / `read_utf8` 增加 `label`，错误带任务相对路径 |
| `packages/desktop/src-tauri/src/agent/task_sync/tests/*` | 4 个回归测试 |
| `.trellis/spec/backend/desktop-realtime-sync.md` | 补充契约：错误带相对路径；归属预检只扫 decisions 目录 |

## 自动化检查

| 检查 | 结果 |
| --- | --- |
| `cargo test agent::task_sync agent::task_command` | **未执行**：本机无 `cargo`/`rustc`（`command not found`，常见安装目录也不存在） |
| Node 测试 | 未执行：本次未改 `packages/server`、`packages/web`、`packages/shared`，无适用用例 |
| `git diff --check` | 通过 |
| 行尾 | `git ls-files --eol` 显示 `i/lf w/lf`，符合仓库约定 |
| IDEA `get_file_problems`（sync_api.rs） | 返回空；IDE 项目仅注册 Java 模块，未启用 Cargo/Rust 分析，**不作为编译通过证据** |

## 静态审查

- 所有用户可见的 UTF-8 解码错误均带 `{relative}` / `{label}`；`task_directory_digest` 保留旧文案，其错误被调用方吞掉，不进入用户错误或同步失败日志。
- 错误文案只包含 `.trellis/tasks/...` 相对路径，不含仓库绝对路径；与 `desktop-task-path-resolution.md` 的 `repoPath` 禁令一致。
- `set_task_ownership` 无 `local_groups(&binding, None)`；`list_task_ownership` 仍保留全量扫描（不在本任务范围）。
- 失败关闭语义保留：目标任务自身非 UTF-8、目录缺失/非法、重复 decision、非法 action/branch 仍然失败。
- `groups_by_dir` 变为 decisions 子集；`sync_ownership_inbox` 对其余 pending 目录会定向补扫，删除差集只覆盖本次决议目录，无新增写入路径。
- 无新增调试日志、无 suppressed warning、无无关文件改动。

## 测试覆盖

| 场景 | 测试 |
| --- | --- |
| 快照扫描错误带相对路径且不含绝对路径 | `local_task_scan_reports_invalid_utf8_path` |
| ownership 索引错误带相对路径 | `ownership_index_reports_invalid_utf8_path` |
| 兄弟目录坏文件不阻断归属 | `assign_ownership_ignores_invalid_utf8_in_sibling_task_dir` |
| 目标任务坏文件仍失败且带路径 | `assign_ownership_reports_target_invalid_utf8_path` |

## 未覆盖 / 风险

1. **未编译、未跑测试**：新增/修改的 Rust 代码与测试尚未经过编译器验证。需要在具备 Rust 工具链的机器上执行 `cargo test agent::`。
2. 归属成功用例使用 `defer`；`use-branch` 复用同一预检，但其后的 `task.py set-branch` 与上传链路未在单测中覆盖（测试夹具没有 `task.py`）。
3. `task_command` 的 `label` 变更没有独立单测；由编译检查和既有命令测试覆盖。
4. 真实客户端 E2E 未执行：需要复现环境（含非 UTF-8 文件的任务目录）和已构建客户端。

## 结论

代码与测试已按 PRD 完成，静态检查通过；**验收未完成**，因为本机无法编译/运行 Rust 测试。下一步应在有 Rust 工具链的机器上补跑测试，再进行真实客户端验证。