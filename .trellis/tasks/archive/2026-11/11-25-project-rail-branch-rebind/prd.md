# 项目栏已关联分支图标支持重新绑定分支

## Goal

项目栏中已关联项目的分支绑定图标不再是死按钮：点击后弹出本地分支弹窗，列出该仓库的本地分支、标记当前检出与已绑定分支。用户可把本地仓库重新绑定到当前检出的另一个分支（需先在本地手动切换分支），从而恢复因分支不一致而暂停的同步。

## Background

- 现有入口：`packages/web/src/components/layout/project-rail/ProjectEntry.tsx:145-196`。仅未批准关联渲染可点击的“关联/重新关联”图标；已批准关联渲染的是静态 `<span>`（148-157 行，`FolderGit2` 或只读态 `LockKeyhole`），没有任何点击行为，因此用户点击无反应。
- 现有接入流程：`packages/web/src/components/layout/ProjectRail.tsx:228-244` 先调用 `pick_local_project_folder` 选目录，再打开 `ProjectOnboardingDialog`；该弹窗（`packages/web/src/features/board/dialogs/ProjectOnboardingDialog.tsx:142-175`）通过 `inspect_local_project` 读取目录当前检出的分支，并在绑定分支不同时给出“将替换当前仓库的旧分支绑定”确认（235-247、397-420 行）。
- 桌面端只按目录当前检出分支绑定：`packages/desktop/src-tauri/src/main.rs:657-701` 在 `associate_pending_project` 中重新 inspect 并用 `/project/branchName` 作为绑定分支；`packages/desktop/src-tauri/src/agent/git.rs:526-538` 在同步前校验当前分支与绑定分支一致，不一致即暂停同步。
- 产品约束（`docs/product-prd.md`）：同一仓库在一个客户端只能绑定一个分支（:330、:389），客户端不得自动 checkout/switch/merge/reset（:489、:693-700、:774），多分支必须使用独立 Git worktree 并分别绑定（:389、:917）。
- 现有能力：已有关联查询 `list_local_associations` 与“按已批准任务空间只读检查”的 `inspect_associated_project_agents`（`packages/desktop/src-tauri/src/main.rs:1104`、`permissions/desktop.toml:104-106`），但没有读取本地分支列表的命令；`GitOperation` 白名单（`agent/git.rs:38-145`）也没有分支列表操作。
- 远程 Board 由服务端下发页面、在桌面 WebView 中运行：新前端可能跑在旧客户端上，缺少新命令时必须给出可读提示，不能崩溃。

## Requirements

### R1 已关联状态的分支图标可点击

- 已批准关联（`status === 'approved'`）时，分支绑定图标改为可聚焦的 `Button size="icon-xs"`，保留原有 `FolderGit2` / 只读态 `LockKeyhole` 视觉与位置，带 `aria-label` 与 `title`（例如“重新绑定分支（当前 main）”）。
- 点击或键盘激活后打开分支选择弹窗；不再保留静态 `<span>`。
- 未批准关联的“关联/重新关联”按钮、Bot 快捷 Agent 按钮、分支行其他按钮行为不变。
- 只读关联（`readOnly`）仍可打开弹窗；本任务不改变只读语义。

### R2 新增只读分支查询命令

- 新增 Tauri 命令 `inspect_associated_project_branches(task_space_id) -> { repoPath, currentBranch: string | null, branches: string[] }`。
- 命令必须先 `ensure_board_caller(&app, &window)`，用 `validate_live_id` 校验任务空间 ID，并只允许 `status === 'approved'` 的关联（复用 `approved_association_for_task_space`）。
- 只读取该关联已绑定的 `repoPath`，不接受前端传入的任意路径。
- `branches` 为该仓库 `refs/heads` 下的本地分支名；`currentBranch` 为当前检出分支，detached HEAD 时为 `null`。
- 新增权限 `allow-inspect-associated-project-branches`：写入 `packages/desktop/src-tauri/permissions/desktop.toml`，并加入 `packages/desktop/src-tauri/capabilities/board-local-association.json`；不得加入 `main.json`。
- 命令注册到 `main.rs` 的 `generate_handler!`。

### R3 分支选择弹窗

- 打开后显示：项目名、当前绑定分支、仓库路径、本地分支列表。
- 每行标记：当前检出分支显示“当前检出”，已绑定分支显示“已绑定”。
- 只有当前检出分支可选；其他分支行禁用，并给出提示“请先在本地仓库切换到该分支”——客户端不会代为切换。
- 当前检出分支与已绑定分支相同时：主按钮禁用，提示“当前检出分支已是绑定分支”；用户需先在仓库切到其他分支再重新打开弹窗。
- 当前检出分支与已绑定分支不同时：主按钮为“重新绑定到 <branch>”，可点击。
- detached HEAD、仓库没有本地分支、读取失败（目录不存在/不是 Git 仓库）都必须显示明确文案，且不崩溃、可直接关闭。
- 弹窗关闭不改变任何绑定。

### R4 确认后复用既有关联流程

- 主按钮点击后关闭分支弹窗，并以该关联的 `repoPath` 直接打开现有 `ProjectOnboardingDialog`（跳过目录选择）。
- 用户在该弹窗中完成既有的团队/开发者/同步方式选择与“替换旧分支绑定”确认；关联成功沿用 `ProjectRail` 现有 `onAssociated` 逻辑（同一仓库路径的旧任务空间关联被替换）。
- 不在本任务复制 `associate_pending_project` 逻辑，也不新增“直接重绑”快捷命令。

### R5 边界与安全

- 不执行 `git switch/checkout/merge/reset`，不创建、删除、重命名分支，不处理远端分支。
- 不枚举、绑定或修改 Git worktree；worktree 自动接入逻辑不变。
- 不改变“分支不一致暂停同步”的判定与提示。
- 不改变服务端 API、数据库或同步协议。
- 不做 `inspect_local_project` 的契约变更，避免影响接入流程。

### R6 旧客户端兼容

- 桌面客户端缺少新命令时，弹窗显示可读提示（如“当前客户端版本不支持重新绑定分支，请升级客户端”），不是原始 `Command not found`/`not allowed` 文本，也不能白屏。
- 纯浏览器（无 Tauri `invoke`）不出现新的可点击入口。

### R7 验证与质量

- Web 纯逻辑（分支列表归一化、可选状态判定、提示文案）放入 `packages/web/src/lib/branch-rebind.js` 并由 Node 测试覆盖；不新增 React 渲染测试，Web 测试不新增“读取源码文本”的断言；桌面契约测试沿用 `packages/desktop/test/desktop-ui-build.test.js` 既有的权限/capability/注册静态断言风格。
- Rust 覆盖新 Git 操作的参数契约与本地分支读取（含当前分支标记、排除远端分支、detached HEAD）。
- 权限/能力契约测试覆盖新命令只在 Board capability 生效。
- 本机无 Rust 工具链：`cargo test`/`cargo check` 不能本地执行，Rust 侧由 `windows` GitHub Actions（`Rust unit tests` 步骤）验证；Web 侧本地执行 `tsc -b`、`oxlint src`、改动文件 `oxfmt`、Node 测试。
- 手工验收：在带最新构建的桌面客户端中完成一次“手动切换分支 → 弹窗重绑 → 看板分支行更新”；本机无法本地构建时，以 CI 产物或用户已安装的对应版本为准。

### R8 前置重构：git.rs 拆分

- 按 `.trellis/spec/desktop/tauri-commands` 的 1200 行守门，先把 `packages/desktop/src-tauri/src/agent/git.rs`（1261 行）机械拆为根文件 + `args.rs` / `query.rs` / `diagnose.rs`，根文件 ≤500 行、子文件 ≤1200 行，对外 `crate::agent::git::*` 路径不变。
- 拆分只搬移代码与调整 import/可见性，禁止改文案、错误码、参数顺序或逻辑；不跑 `cargo fmt`。
- 拆分单独提交，功能提交在其后，便于独立回滚。
- `agent_service.rs`（1306 行）不做整体拆分，只允许对既有函数做不增加行数的 `pub(crate)` 可见性调整。

## Acceptance Criteria

- [ ] AC1：已关联项目的分支图标是可用键盘聚焦的按钮；点击/回车会打开分支弹窗，视觉与现有一致。
- [ ] AC2：弹窗列出绑定仓库的本地分支；当前检出与已绑定标记正确；非当前分支禁用且带“请先在本地仓库切换到该分支”，无法选中。
- [ ] AC3：已绑定 main、本地已手动切到 feature 时，弹窗主按钮可用并显示“重新绑定到 feature”；走完接入流程后，`list_local_associations` 的该任务空间分支变为 feature，项目栏分支行同步更新，旧 main 关联被替换。
- [ ] AC4：已绑定分支等于当前检出分支时，主按钮禁用并说明原因，点击不会有副作用。
- [ ] AC5：detached HEAD 时显示明确提示，无可用主按钮。
- [ ] AC6：仓库目录被删除或不是 Git 仓库时，弹窗显示错误文案，可关闭，项目栏其余功能不受影响。
- [ ] AC7：未批准关联的“关联/重新关联”按钮、Bot 按钮、解绑/监听/归属入口行为与改动前一致。
- [ ] AC8：纯浏览器无新增入口；旧客户端缺少命令时显示升级提示而非原始错误。
- [ ] AC9：新权限只存在于 `board-local-association` capability，`main.json` 不包含；命令经 `ensure_board_caller` 且只接受已批准任务空间。
- [ ] AC10：`git.rs` 根文件 ≤500 行、拆分出的子文件 ≤1200 行；所有既有 `crate::agent::git::*` 导出路径不变；拆分前后测试名集合无差异（由 CI 的 `cargo test -- --list` 对比与 `yarn test --scope=rust` 证明）。

## Out of Scope

- `agent_service.rs`、`onboarding.rs` 的整体模块拆分（仅允许不增行的可见性调整）。
- 自动切换/检出分支，或在客户端内创建、删除分支。
- worktree 列表、worktree 绑定与自动接入策略调整。
- 同时绑定同一仓库的多个分支。
- 修改分支不一致暂停同步、冲突检测或任务同步语义。
- 修改 `ProjectInspection` / `inspect_local_project` / `ProjectOnboardingDialog` 的既有契约。
- 服务端 API、数据库结构与权限模型变更。

## Technical Notes

- 前端入口在 `ProjectEntry.tsx`；`BranchRebindDialog` 挂在 `ProjectEntry` 内（`ProjectRail.tsx` 已 683 行，避免逼近 web 700 行上限），确认回调上抛给 `ProjectRail` 打开既有 `ProjectOnboardingDialog`。
- 新命令应仿照 `inspect_associated_project_agents`（`main.rs:757-768`）的结构：`ensure_board_caller` → `validate_live_id` → `list_associations` → `approved_association_for_task_space` → service。
- 分支读取需要新增 `GitOperation` 条目（当前 `git.rs:38-145`，拆分后位于 `agent/git/args.rs`）并在 `git_args` 中走 `for-each-ref --format=%(refname:short) refs/heads`；沿用 `run_git` 的固定 hooks/env 前缀，不直接调用 `std::process::Command`。
- `agent_service` 已有 `ephemeral_hooks()`（`agent_service.rs:521-535`）模式，读取后需清理临时 hooks 目录。
- `current_branch` 对 detached HEAD 返回 `DETACHED_HEAD` 错误（当前 `git.rs:506-524`，拆分后位于 `agent/git/query.rs`），service 层应映射为 `currentBranch: null` 而不是整体失败。
- 既有 `ProjectRail.onAssociated` 会删除同仓库路径的旧任务空间关联（约 630-660 行），重绑后的本地状态无需新增清理逻辑。
- 兼容性：命令不存在时 invoke 会返回 `not allowed`/`Command not found` 类错误，需在 Web 侧归一化为升级提示。

## Open Questions

- 无。已确认：新增分支弹窗；非当前分支禁用并提示手动切换；本任务不处理 worktree。
