# 实施报告：项目栏已关联分支图标支持重新绑定分支

## 结果

已按 `implement.md` 完成桌面 IPC、Web 弹窗与项目栏入口；`agent/git.rs` 拆分后新增分支读取能力。Web/TS 侧检查全部通过，Rust 侧因本机无 `cargo`/`rustc` 未编译，待 CI 验证。

## 改动文件

### 桌面端（Rust）

- `packages/desktop/src-tauri/src/agent/git.rs`：1261 → 164 行，保留常量、`GitStatusEntry`、进程层与显式 `pub use`。
- `packages/desktop/src-tauri/src/agent/git/args.rs`（新增，400 行）：操作白名单、`GitParams`、`git_args`、`require_paths`、`absolute_path`；新增 `GitOperation::BranchList`（`ALL` 25 项）。
- `packages/desktop/src-tauri/src/agent/git/query.rs`（新增，542 行）：只读 Git 操作；新增 `pub async fn branch_list`（`for-each-ref --format=%(refname:short) refs/heads`）。
- `packages/desktop/src-tauri/src/agent/git/diagnose.rs`（新增，232 行）：状态检测、失败分类与 porcelain/diff-tree 解析。
- `packages/desktop/src-tauri/src/agent/git/tests.rs`：新增参数构造测试与临时仓库分支读取/detached HEAD 测试；补 `use std::path::PathBuf;`（拆分后根模块不再导入该类型）。
- `packages/desktop/src-tauri/src/agent/branch_inspect.rs`（新增）：`inspect_branches` 读取 `{repoPath,currentBranch,branches}`；`inspect_associated_project_branches` 负责取 service/hooks 并附 `ok`。
- `packages/desktop/src-tauri/src/agent/mod.rs`：注册 `pub mod branch_inspect;`。
- `packages/desktop/src-tauri/src/agent_service.rs`：仅将 `service`、`ephemeral_hooks` 改为 `pub(crate)`，无净新增行（该文件同时存在其他任务的未提交改动，提交时需按 hunk 选取）。
- `packages/desktop/src-tauri/src/main.rs`：新增 `inspect_associated_project_branches(task_space_id)` 并注册到 `generate_handler!`。
- `packages/desktop/src-tauri/permissions/desktop.toml`、`capabilities/board-local-association.json`：新增仅 Board capability 可用的只读命令权限。
- `packages/desktop/test/desktop-ui-build.test.js`：新增 IPC/权限静态契约测试。

### Web

- `packages/web/src/lib/branch-rebind.js` + `.d.ts`（新增）：响应归一化、分支视图、旧客户端错误映射。
- `packages/web/test/branch-rebind.test.js`（新增，4 个用例）。
- `packages/web/src/features/board/dialogs/BranchRebindDialog.tsx`（新增，173 行）。
- `packages/web/src/components/layout/project-rail/ProjectEntryBranchActions.tsx`（新增）：已批准态的分支重绑与 Agent 入口。
- `packages/web/src/components/layout/project-rail/ProjectEntry.tsx`：静态 `<span>` 改为可点击 `Button size="icon-xs"`，挂载弹窗；473 行。
- `packages/web/src/components/layout/ProjectRail.tsx`：新增 `startRebindOnboarding(repoPath)` 并传入（本任务新增 7 行）。工作区并发叠加其他任务后当前为 712 行；本任务改动落地时该文件为 691 行。

## 与计划的偏差

1. `branch_inspect.rs` 拆为 `inspect_branches`（纯读取）与 `inspect_associated_project_branches`（IPC 适配）；后者放在该模块而不是 `agent_service.rs`，避免继续增长已超 1200 行的 `agent_service.rs`。
2. Rust 测试合并为 `builds_branch_list_arguments` 与 `lists_local_branches_and_reports_detached_head`，覆盖计划中的参数断言、仅本地分支、detached HEAD 三类断言。
3. Web 弹窗确认按钮文案为 `重新绑定到 <branch>`，与设计一致。

## 本地验证

| 命令 | 结果 |
| --- | --- |
| `node --test packages/web/test/branch-rebind.test.js` | 4 pass / 0 fail |
| `node scripts/test.mjs --scope=web` | 135 pass / 0 fail |
| `node scripts/test.mjs --scope=desktop` | 39 pass / 0 fail / 1 skipped（既有 POSIX 跳过） |
| `tsc -b --noEmit`（packages/web） | 通过，无输出 |
| `node scripts/build.mjs --target=desktop-ui` | 构建成功 |
| `oxfmt --check`（本次 Web 改动文件） | 全部通过 |
| `oxlint`（本次 Web 改动文件） | 仅既有模式警告，无 error |

## 未本地验证

- `cargo test` / `cargo check`：本机无 Rust 工具链，未执行。
- 桌面端手工验收：需要可运行的 Tauri 构建，未执行。
- `yarn test --scope=lint` 全仓失败于 38 个既有文件的格式问题（与本次改动无关）；本次改动文件单独检查通过。
