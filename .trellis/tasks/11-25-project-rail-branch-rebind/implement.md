# 实施清单：项目栏已关联分支图标支持重新绑定分支

> 环境前置：本机无 Rust 工具链（`cargo`/`rustc` 不在 PATH），Rust 编译与测试只能在 CI（`.github/workflows/windows.yml` → `Rust unit tests`）执行；本地能跑的是 Node/TS 侧检查与纯文本等价性自查。实现过程中不得声称“本地编译通过”。

## 0. 基线（改动前，本地）

- [ ] `git status --short` 确认工作区只有本任务目录与既有未跟踪项（`.trellis/.kit-version`、`.trellis/tasks/11-25-company-spec-bootstrap/`），不触碰它们。
- [ ] 记录基线：`wc -l packages/desktop/src-tauri/src/agent/git.rs`（1261）；导出 `git show HEAD:packages/desktop/src-tauri/src/agent/git.rs | grep -nE '^(pub )?(async )?fn |^pub enum |^pub struct |^struct '` 的函数名集合到临时文件。
- [ ] 记录 `rg -n '^mod tests \{' packages/desktop/src-tauri/src` 为空（基线已满足）。
- [ ] 创建任务分支（命名遵循 Trellis 约定，例如 `feat/11-25-project-rail-branch-rebind`），不要在 `main` 上直接提交。

## 1. 机械拆分 `agent/git.rs`（单独提交）

目标：根 ≤500 行，`args.rs` / `query.rs` / `diagnose.rs` ≤1200 行，外部 `crate::agent::git::*` 路径不变。

- [ ] 新建 `packages/desktop/src-tauri/src/agent/git/args.rs`：搬入
  - `GitOperation` 枚举与 `impl GitOperation`（`ALL`、`as_str`）
  - `GitParams`、`git_args`、`require_paths`、`absolute_path`
  - import：`std::path::Path`、`crate::agent::protocol::{code, AgentError, AgentResult}`、`super::{FIXED_SSH_COMMAND, GIT_STATE_MARKERS}`。
- [ ] 新建 `packages/desktop/src-tauri/src/agent/git/query.rs`：搬入
  - `ensure_hooks_dir`、`show_toplevel`、`current_branch`、`assert_repository_branch`、`head_commit`、`status`、`status_paths`、`remote_url`、`ls_remote`、`GitWorktree`、`worktree_list`、`ls_tree`、`is_tracked`、`staged_paths`、`diff_tree`、`is_full_git_oid`、`fetch`、`rev_list`、`merge_ff_only`、`check_ref`、`config_sparse`
  - import：`std::path::{Path, PathBuf}`、`crate::agent::protocol::{code, AgentError, AgentResult}`、`crate::agent::process::...`（按需）、`super::{run_git, require_success, git_failure, failure_with_code, tail_text, LOCAL_TIMEOUT, NETWORK_TIMEOUT, GitParams, GitOperation, GIT_STATE_MARKERS}`（只保留实际使用的项，编译器会报未使用）。
- [ ] 新建 `packages/desktop/src-tauri/src/agent/git/diagnose.rs`：搬入
  - `detect_git_state`、`common_dir`、`parse_status`、`classify_fetch_failure`、`classify_push_failure`、`classify_commit_failure`、`is_remote_unreachable`、`unreachable_remote_error`、`classify_merge_failure`、`parse_status_line`、`parse_diff_tree_paths`、`resolve_git_dir`
  - 依赖 `super::{GitStatusEntry, code, AgentError}` 等。
- [ ] 根文件保留：模块声明 `mod args; mod diagnose; mod query; mod write;`、显式 `pub use`、常量、`GitStatusEntry`、`run_git`、`git_environment`、`map_process_error`、`require_success`、`git_failure`、`failure_with_code`、`output_tail`、`tail_text`、`#[cfg(test)] mod tests;`。
- [ ] 全仓 `rg "crate::agent::git::|agent::git::|use crate::agent::git"` 核对调用点无需改动；`agent/git/tests.rs` 的 `use super::*;` 仍能拿到全部被测试符号。
- [ ] 行数与等价性自查：
  - `wc -l` 根文件 ≤500，三个子文件 ≤1200。
  - Python 脚本对比 `git show HEAD:.../git.rs` 与拆分后文件集合：去掉 `use`/`mod`/`pub use`/空行后，行多重集一致；函数名集合一致。
  - `rg -n '^mod tests \{' packages/desktop/src-tauri/src` 无输出。
- [ ] 提交：`refactor(desktop): 拆分 git 模块`（不夹带功能改动）。

## 2. 新增分支读取（Git 层）

- [ ] `git/args.rs`：`GitOperation::BranchList`、`ALL` 改 25、`as_str` 返回 `"branch-list"`、`git_args` 增加 `for-each-ref --format=%(refname:short) refs/heads` 分支。
- [ ] `git/query.rs`：新增 `pub async fn branch_list(repo_path, hooks_dir) -> AgentResult<Vec<String>>`，`run_git(GitOperation::BranchList, ...)` + `require_success(..., "无法读取本地分支")`，按行 trim/filter/collect。
- [ ] 根文件 `pub use query::branch_list;`（若 query 采用显式重导出列表）。
- [ ] `agent/git/tests.rs` 增加：
  - `builds_branch_list_arguments`：断言 `git_args(BranchList, ...)` 末尾为 `["for-each-ref", "--format=%(refname:short)", "refs/heads"]`，且固定前缀不变。
  - `branch_list_reads_local_branches_only`：临时目录 `git init -b main` + 一次提交 → `git branch feature` → `git update-ref refs/remotes/origin/main HEAD`；断言返回包含 `main`、`feature`，不包含 `origin/main`；再 `git checkout --detach` 断言 `current_branch` 返回 `DETACHED_HEAD` 且 `branch_list` 仍列出两个分支。测试内自建临时仓库（不要把 `onboarding::tests` 的私有 fixture 跨模块引用）。

## 3. 服务层与 IPC

- [ ] 新建 `packages/desktop/src-tauri/src/agent/branch_inspect.rs`：
  - `pub async fn inspect_project_branches(app: &AppHandle, repo_path: &str) -> Result<Value, String>`
  - 取 `service(app)` → `ephemeral_hooks()` → `show_toplevel` → `current_branch`（`DETACHED_HEAD` → None）→ `branch_list` → `remove_dir_all(hooks)` → `json!({ "repoPath", "currentBranch", "branches" })`。
  - 错误统一 `error.message`。
- [ ] `packages/desktop/src-tauri/src/agent/mod.rs` 增加 `pub mod branch_inspect;`。
- [ ] `agent_service.rs` 只做同行可见性调整（不新增行）：`fn service` → `pub(crate) fn service`，`fn ephemeral_hooks` → `pub(crate) fn ephemeral_hooks`。
- [ ] `main.rs` 新增 `inspect_associated_project_branches` 命令（结构同 `inspect_associated_project_agents`，复用 `ensure_board_caller`/`validate_live_id`/`list_associations`/`approved_association_for_task_space`），并加入 `generate_handler!`。
- [ ] `permissions/desktop.toml` 新增 `allow-inspect-associated-project-branches`（`commands.allow = ["inspect_associated_project_branches"]`）。
- [ ] `capabilities/board-local-association.json` 增加该权限；确认 `capabilities/main.json` 不含。
- [ ] `packages/desktop/test/desktop-ui-build.test.js` 新增静态契约测试（沿用既有风格）：权限标识存在、Board capability 包含、`main.json` 不包含、`main.rs` 注册命令并调用 `ensure_board_caller`。
- [ ] 检查 `main.rs` 行数仍 ≤1200（预计 ≈1182）。

## 4. Web 纯逻辑与单测

- [ ] 新建 `packages/web/src/lib/branch-rebind.js` + `branch-rebind.d.ts`：`normalizeBranchInspection`、`branchRebindView`、`branchRebindErrorMessage`。
- [ ] 新建 `packages/web/test/branch-rebind.test.js`：
  - 正常列表、去重、空串过滤、current 不在列表时前插；
  - detached / empty / already-bound / ready 四种 view；
  - 旧客户端错误（`not allowed`、`Command not found`、`unknown command`）映射为升级提示；
  - 非法形状抛错。
- [ ] 命令：`yarn test --scope=web --file=branch-rebind.test.js`。

## 5. Web UI

- [ ] 新建 `packages/web/src/features/board/dialogs/BranchRebindDialog.tsx`：
  - `invoke('inspect_associated_project_branches', { taskSpaceId: association.taskSpaceId })`；
  - 加载 / 错误 / 空 / 列表 / 禁用态；分支行显示“当前检出”“已绑定”；
  - 主按钮 `重新绑定到 <branch>`；禁用时显示原因；
  - 点击后关闭本弹窗并 `onConfirm(inspection.repoPath)`。
  - 只用 `components/ui/*` 控件；无原生 `<button>`。
- [ ] `ProjectEntry.tsx`：已批准分支的静态 `<span>` 换为 `Button size="icon-xs"`（保留 `FolderGit2`/`LockKeyhole`、`aria-label`、`title`）；新增 `rebindOpen` 状态与 `<BranchRebindDialog>`；`ProjectEntryProps` 增加 `onRebindBranch(repoPath)`。
- [ ] `ProjectRail.tsx`：`const startRebind = (repoPath) => { setOnboardingPath(repoPath); setOnboardingOpen(true); }`，传给当前项目 `ProjectEntry`。
- [ ] 行数自查：`ProjectRail.tsx` ≤700、`ProjectEntry.tsx` 不逼近超限、`BranchRebindDialog.tsx` 合理拆分。
- [ ] 组件复用自检：`rg -n "<button[ >]" packages/web/src/components/layout packages/web/src/features/board/dialogs/BranchRebindDialog.tsx -g '!**/components/ui/**'` 应无新增命中。

## 6. 验证

本地（必须执行）：

- [ ] `yarn test --scope=web --file=branch-rebind.test.js`
- [ ] `yarn test --scope=desktop`（Node 侧的 desktop 契约测试，含新契约）
- [ ] `yarn test --scope=lint`
- [ ] `yarn build --target=desktop-ui`（含 `tsc -b`）
- [ ] `npx oxfmt --check <本次改动的 ts/tsx/js/d.ts 文件>`
- [ ] Python 行多重集自查（见步骤 1）；`rg -n '^mod tests \{' packages/desktop/src-tauri/src` 无输出。

需要 Rust/桌面环境（本机不可执行，需 CI 或用户环境）：

- [ ] `yarn test --scope=rust`（等价 `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`）全绿，且测试名集合与拆分前一致。
- [ ] `cargo check` / `cargo clippy`（若 CI 或本地环境提供）。
- [ ] 手工验收（需可运行的桌面构建）：准备含 `main` 与 `feature` 两分支的仓库 → 绑定 `main` → 本地 `git switch feature` → 点击项目栏图标 → 弹窗显示 feature 为当前检出、main 为已绑定 → 确认 → 走既有接入弹窗 → 看板分支行变为 feature、旧 main 关联消失。另测 detached HEAD、目录删除、当前==绑定三种态。

**不得**在未实际执行的情况下勾选 Rust/手工项；若无法执行，在 `check-report.md` 明确写明“未本地验证，待 CI/用户环境”，并附原因。

## 7. 报告与 Trellis 收尾

- [ ] `{TASK_DIR}/api-e2e-report.md`：写明“not applicable（无 HTTP API 变更）”，列出本次 IPC 命令的调用/错误路径与验证方式。
- [ ] `{TASK_DIR}/check-report.md`：`mode: inline-self-check`、`agent: main-session`、`session`、`commit`（未提交则空），记录实际执行过的命令与结果；Rust 未本地执行必须如实标注。
- [ ] 复杂任务归档前按流程补 `meta.check_override`（owner 确认）如适用。
- [ ] 工作提交包含 `.trellis/tasks/11-25-project-rail-branch-rebind/`（prd/design/implement/jsonl/报告），不要只提交代码。
- [ ] 若需要 CI 验证 Rust：先征得用户同意再推送分支并 `gh workflow run windows --ref <branch>`（release_tag 留空），不得擅自推送。

## 8. 风险与回滚点

- 拆分提交（步骤 1）独立可 revert；功能提交（步骤 2–5）依赖拆分后的文件布局。
- 高风险文件：`agent/git.rs` 及其子模块（安全敏感：固定参数/hooks/环境）、`main.rs`（行数余量小）、`ProjectRail.tsx`（700 行上限）。
- 若 CI 报 Rust 编译错误，只修 import/可见性，不回退拆分；若拆分导致行为差异，直接 revert 拆分提交后重做。
