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
| `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`（GitHub Actions，tag `v0.4.57`） | **通过**：run `45107316470`，`376 passed; 0 failed; 0 ignored`；4 个新增测试均在通过列表中 |
| 本地 `cargo test` | **未执行**：本机无 `cargo`/`rustc`（`command not found`，常见安装目录也不存在） |
| GitHub Node 测试（`node tests (windows)`） | 通过 |
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

## CI 验证（2026-11-23）

- 提交：`35dbc73 fix(desktop): 任务归属确认不再被非 UTF-8 文件整体阻断`、
  `1e67c08 chore(release): 0.4.57`；标签 `v0.4.57`（annotated）已推送。
- tag 推送 run `45107307925`：成功转发。
- 实际构建 run `45107316470`（`windows`，`workflow_dispatch`，`release_tag=v0.4.57`）：
  `node tests (windows)` 与 `desktop build (windows)` 均 **success**。
- `Rust unit tests`：`test result: ok. 376 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out`。
  新增测试均通过：
  - `agent::task_sync::tests::ownership_inbox::assign_ownership_reports_target_invalid_utf8_path`
  - `agent::task_sync::tests::ownership_inbox::assign_ownership_ignores_invalid_utf8_in_sibling_task_dir`
  - `agent::task_sync::tests::ownership_projection::ownership_index_reports_invalid_utf8_path`
  - `agent::task_sync::tests::snapshot_files::local_task_scan_reports_invalid_utf8_path`
- Release `Trellis Board v0.4.57` 已发布（非 draft / 非 prerelease），资产：
  `TrellisBoard_0.4.57_x64-portable.zip`、对应 `.sha256`、`latest.json`；
  发布时间 `2026-11-23T03:45:58Z`。

## 未覆盖 / 风险

1. 本地机器没有 Rust 工具链，本地 `cargo test` 未执行；编译与全部单测已由 GitHub Actions 在 tag `v0.4.57` 上完成并通过。
2. 归属成功用例使用 `defer`；`use-branch` 复用同一预检，但其后的 `task.py set-branch` 与上传链路未在单测中覆盖（测试夹具没有 `task.py`）。
3. `task_command` 的 `label` 变更没有独立单测；由编译检查和既有命令测试覆盖。
4. 真实客户端 E2E 未执行：需要复现环境（含非 UTF-8 文件的任务目录）；CI 的 `Launch smoke test` 只能证明构建产物可启动（且该步骤为 `continue-on-error`）。

## 结论

代码与测试已按 PRD 完成，静态检查通过，GitHub Actions 编译、Rust 单测（376 通过）、打包与 Release 发布均成功。任务验收完成；真实客户端 UI E2E 未覆盖，属于已知剩余风险。