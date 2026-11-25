# git.rs 拆分合同（摘自 `.trellis/spec/desktop/tauri-commands/index.md`）

原 spec 文件超过 `context_injection.max_file_bytes`，注入会被截断；这里保留本次拆分需要遵守的原文要点。

## 规范原文要点

- `packages/desktop/src-tauri/src/` 下任何 `.rs` 超过 1200 行（测试代码计入行数）时适用：要么把测试搬走，要么把职责拆成 `foo.rs` + `foo/`。
- `foo.rs` 保留：`mod` 声明、常量、主类型定义与其构造/`Drop`、对外重导出、`#[cfg(test)] mod tests;`。
- `foo/tests.rs`：默认测试文件，业务文件里只留 `#[cfg(test)] mod tests;`。
- 测试外移只做缩进回退，不改测试体；拆分禁止 `cargo fmt`，禁止顺手改逻辑；验证以“行内容多重集等价 + 测试集合等价”证明。
- 任何后续改动（加功能、加测试、改注释）如果使某个文件超过上限，必须在同一次改动内拆完再提交：超限文件不得新增行。
- `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` 全绿；测试名集合与拆分前 `-- --list` 结果逐项比对为空差集。

## 本任务基线（2026-11-25，HEAD 2483457）

| 文件 | 行数 | 处理 |
| --- | --- | --- |
| `packages/desktop/src-tauri/src/agent/git.rs` | 1261 | 本任务拆分 |
| `packages/desktop/src-tauri/src/agent/git/write.rs` | 161 | 不动 |
| `packages/desktop/src-tauri/src/agent/git/tests.rs` | 410 | 不动（可追加测试） |
| `packages/desktop/src-tauri/src/agent/onboarding.rs` | 1295 | 不动 |
| `packages/desktop/src-tauri/src/agent_service.rs` | 1306 | 只做不增行的 `pub(crate)` 可见性调整 |
| `packages/desktop/src-tauri/src/main.rs` | 1168 | 新增命令 ≤ 约 14 行 |

## 拆分映射

- 根 `agent/git.rs`：模块声明、常量、`GitStatusEntry`、`run_git`、`git_environment`、`map_process_error`、`require_success`、`git_failure`、`failure_with_code`、`output_tail`、`tail_text`、`#[cfg(test)] mod tests;`。
- `agent/git/args.rs`：`GitOperation` + `ALL` + `as_str`、`GitParams`、`git_args`、`require_paths`、`absolute_path`。
- `agent/git/query.rs`：hooks 目录、仓库/分支/提交/状态/远端/worktree/diff/fetch/merge 等读取操作，新增 `branch_list`。
- `agent/git/diagnose.rs`：状态与失败分类、porcelain/`diff-tree` 解析、`detect_git_state`、`common_dir`、`resolve_git_dir`。

## 等价性自查（本机无 Rust 工具链）

- 拆分前后的顶层函数/类型名集合一致。
- 去掉 `use` / `mod` / `pub use` / 空行后，原文件与拆分后所有文件的行多重集一致。
- `rg -n '^mod tests \{' packages/desktop/src-tauri/src` 无输出。
- 编译与测试由 `.github/workflows/windows.yml` 的 `Rust unit tests` 步骤验证；本地不得声称编译通过。
