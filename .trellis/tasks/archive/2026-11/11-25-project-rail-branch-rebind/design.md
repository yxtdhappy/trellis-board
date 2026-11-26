# 设计：项目栏已关联分支图标支持重新绑定分支

## 1. 架构与边界

```
ProjectEntry (web)                        main.rs (Tauri command)
  └─ BranchRebindDialog ──invoke──▶ inspect_associated_project_branches(task_space_id)
        │                                   │ ensure_board_caller / validate_live_id
        │                                   │ approved_association_for_task_space
        │                                   ▼
        │                          agent::branch_inspect::inspect_project_branches
        │                                   │ AgentService::ephemeral_hooks
        │                                   ▼
        │                          agent::git::{show_toplevel, current_branch, branch_list}
        │
        └─ onConfirm(repoPath) ─▶ ProjectRail: setOnboardingPath(repoPath) + setOnboardingOpen(true)
                                        │
                                        ▼
                              ProjectOnboardingDialog（既有流程）
                              inspect_local_project → preflight_pending_project
                              → associate_pending_project（既有唯一写绑定路径）
```

- 读：新增一个只读 IPC 命令，前端只提交 `taskSpaceId`，不提交任意路径。
- 写：完全复用 `ProjectOnboardingDialog → associate_pending_project`，不新增写命令、不改绑定数据结构。
- 客户端不执行任何 checkout/switch，也不处理 worktree。

## 2. 模块拆分（本次任务的前置重构）

用户已确认：先在本次任务内把 `packages/desktop/src-tauri/src/agent/git.rs` 拆到 1200 行守门内，再落功能。

### 2.1 目标布局

| 文件 | 内容 | 预计行数 |
| --- | --- | --- |
| `agent/git.rs` | 模块声明与重导出、`GIT_BINARY`/`FIXED_SSH_COMMAND`/`GIT_STATE_MARKERS`/超时常量、`GitStatusEntry`、`run_git`、`git_environment`、`map_process_error`、`require_success`/`git_failure`/`failure_with_code`/`output_tail`/`tail_text` | ≈ 180 |
| `agent/git/args.rs` | `GitOperation`（含 `ALL`/`as_str`）、`GitParams`、`git_args`、`require_paths`、`absolute_path` | ≈ 390 |
| `agent/git/query.rs` | `ensure_hooks_dir`、`show_toplevel`、`current_branch`、`assert_repository_branch`、`head_commit`、`status*`、`remote_url`、`ls_remote`、`worktree_list`/`GitWorktree`、`ls_tree`、`is_tracked`、`staged_paths`、`diff_tree`、`is_full_git_oid`、`fetch`、`rev_list`、`merge_ff_only`、`check_ref`、`config_sparse`、新增 `branch_list` | ≈ 470 |
| `agent/git/diagnose.rs` | `detect_git_state`、`common_dir`、`parse_status`、`classify_*`、`is_remote_unreachable`、`unreachable_remote_error`、`parse_status_line`、`parse_diff_tree_paths`、`resolve_git_dir` | ≈ 330 |
| `agent/git/write.rs` | 不变 | 161 |
| `agent/git/tests.rs` | 不变，继续 `use super::*` | 410 |

根文件用 `mod args; mod diagnose; mod query; mod write;` + 显式 `pub use` 重导出，保证所有既有的 `crate::agent::git::X` 路径不变。

### 2.2 可见性与依赖

- 子模块可访问父模块私有项（`super::run_git`、`super::require_success` 等），因此执行层留在根文件即可，不需要把 `run_git` 提升为 pub。
- 根文件对子模块的公开项做显式重导出：`pub use args::{git_args, GitOperation, GitParams};`、`pub use query::{...};`、`pub use diagnose::{...};`。
- `tail_text` 留在根（`output_tail` 使用），`query.rs` 通过 `super::tail_text` 访问。
- `absolute_path` 仅被 `git_args` 使用，移入 `args.rs`；`git_args` 需要 `GIT_STATE_MARKERS`/`FIXED_SSH_COMMAND`，通过 `super::{...}` 引入。

### 2.3 机械拆分规则

- 只做「整函数整块搬移 + 调整 import/可见性」，禁止改文案、错误码、参数顺序、默认值与逻辑。
- 禁止 `cargo fmt`；只在搬移处补必要的 `use`。
- 拆分单独提交（`refactor(desktop): 拆分 git 模块`），功能在其后提交，便于回滚与评审。
- 本地无 Rust 工具链：拆分等价性用文本校验（原函数名集合、去 `use` 后的行多重集）自查，编译与测试由 CI（`.github/workflows/windows.yml` 的 `Rust unit tests` 步骤）验证。

## 3. 新增 Git 操作

`packages/desktop/src-tauri/src/agent/git/args.rs`：

- `GitOperation::BranchList`；`ALL` 长度 24 → 25；`as_str()` 返回 `"branch-list"`。
- `git_args` 分支：

```rust
GitOperation::BranchList => {
    args.extend([
        "for-each-ref".to_string(),
        "--format=%(refname:short)".to_string(),
        "refs/heads".to_string(),
    ]);
}
```

- 不加入 `fsmonitor` 关闭列表（与现有读操作分类保持一致，不改变任何既有操作的参数）。

`query.rs`：

```rust
pub async fn branch_list(repo_path: &Path, hooks_dir: &Path) -> AgentResult<Vec<String>> {
    ensure_hooks_dir(hooks_dir).await?;
    let output = run_git(
        GitOperation::BranchList,
        repo_path,
        hooks_dir,
        &GitParams::default(),
        LOCAL_TIMEOUT,
    )
    .await?;
    let value = require_success(&output, "无法读取本地分支")?;
    Ok(value
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect())
}
```

- 只返回本地 `refs/heads`；远端分支天然不出现。
- 排序依赖 `for-each-ref` 默认 refname 顺序，稳定且无需额外排序。

## 4. 服务层与 IPC 命令

### 4.1 `agent/branch_inspect.rs`（新文件）

不放进 `agent_service.rs`（1306 行，已超限）。新模块负责：

```rust
pub async fn inspect_project_branches(
    app: &AppHandle,
    repo_path: &str,
) -> Result<serde_json::Value, String>
```

- 通过 `crate::agent_service::service(app)` 取 `AgentService`，`ephemeral_hooks()` 建临时 hooks 目录，结束时 `remove_dir_all`。
- `show_toplevel` 校验并 canonical 化仓库根（目录不存在/非 Git 仓库 → `NOT_GIT_REPOSITORY`）。
- `current_branch`：`DETACHED_HEAD` 映射为 `currentBranch: null`；其他错误原样返回。
- 返回 `{ "repoPath": root, "currentBranch": string|null, "branches": string[] }`（`serde_json::json!`，前端按 camelCase 读取）。
- 需要把 `agent_service::service` 与 `AgentService::ephemeral_hooks` 的可见性改为 `pub(crate)`——只改既有行，不新增行，避免继续扩大超限文件。

### 4.2 `main.rs` 命令

```rust
#[tauri::command]
async fn inspect_associated_project_branches(
    app: AppHandle,
    window: WebviewWindow,
    task_space_id: String,
) -> Result<serde_json::Value, String> {
    ensure_board_caller(&app, &window)?;
    let task_space_id = validate_live_id(&task_space_id, "任务空间 ID")?;
    let associations = agent_service::list_associations(&app).await?;
    let repo_path = approved_association_for_task_space(&associations, &task_space_id)?
        .repo_path
        .clone();
    agent::branch_inspect::inspect_project_branches(&app, &repo_path).await
}
```

- 与 `inspect_associated_project_agents` 完全同构；未批准关联返回错误，不暴露路径。
- 注册进 `generate_handler!`；`main.rs` 预计 1168 → ≈ 1182，仍低于 1200。

### 4.3 权限与能力

- `permissions/desktop.toml` 新增：

```toml
[[permission]]
identifier = "allow-inspect-associated-project-branches"
description = "..."
commands.allow = ["inspect_associated_project_branches"]
```

- `capabilities/board-local-association.json` 的 `permissions` 增加 `allow-inspect-associated-project-branches`。
- 不加入 `capabilities/main.json`；命令必须调用 `ensure_board_caller`。

## 5. Web 设计

### 5.1 纯逻辑 `packages/web/src/lib/branch-rebind.js` + `.d.ts`

- `normalizeBranchInspection(value)`：
  - 校验 `repoPath` 为非空字符串、`currentBranch` 为字符串或 null、`branches` 为字符串数组；
  - 去空、去重、保持顺序；若 `currentBranch` 不在列表中（unborn 仓库等）则前插；
  - 返回 `{ repoPath, currentBranch, branches }`，非法形状抛错。
- `branchRebindView(inspection, boundBranch)` 返回：
  - `rows: [{ name, isCurrent, isBound, disabled }]`（`disabled = !isCurrent`）；
  - `canConfirm` / `targetBranch` / `reason`（`detached | empty | already-bound | ready`）/ `message`。
- `branchRebindErrorMessage(error)`：
  - `not allowed`、`Command not found`、`unknown command`、`not found`（大小写不敏感）→ “当前客户端版本不支持重新绑定分支，请升级客户端后重试”；
  - 其他 → 原始消息（空则“读取本地分支失败”）。

### 5.2 `BranchRebindDialog.tsx`

- props：`{ open, onOpenChange, projectName, association, onConfirm }`；`association` 为 `LocalAssociation`。
- 打开或 `association.taskSpaceId` 变化时 `invoke('inspect_associated_project_branches', { taskSpaceId })`；用请求序号/`cancelled` 标记丢弃过期结果。
- 形态：`Dialog` + `DialogHeader`（标题“重新绑定分支”，描述“项目名 · 已绑定 branch”）；加载态 `Skeleton`；错误态 `Alert variant="destructive"`；空态说明。
- 分支列表：每行显示分支名 + `Badge`（当前检出 / 已绑定）；非当前行 `aria-disabled`、降透明度并显示“请先在本地仓库切换到该分支”；当前行可选。
- 底部：`取消` + 主按钮（`重新绑定到 <current>`，按 `view.canConfirm` 禁用）；`already-bound` 时按钮禁用并显示原因。
- 主按钮点击：`onOpenChange(false)` 后调用 `onConfirm(inspection.repoPath)`；若 Radix 焦点锁导致两个弹窗冲突，用 `setTimeout(0)` 延迟打开 onboarding。
- 只使用 `components/ui/*`（`Button`、`Dialog`、`Alert`、`Badge`、`Skeleton`），不新增原生控件。

### 5.3 入口改造

`ProjectEntry.tsx`：

- 已批准分支的静态 `<span>` 改为：

```tsx
<Button
  type="button"
  size="icon-xs"
  variant="ghost"
  className="text-muted-foreground"
  aria-label={`重新绑定分支（当前 ${activeTaskSpace.branchName}）`}
  title="重新绑定分支"
  onClick={() => setRebindOpen(true)}
>
  {activeAssociation.readOnly ? <LockKeyhole .../> : <FolderGit2 .../>}
</Button>
```

- 组件内新增 `const [rebindOpen, setRebindOpen] = useState(false);`，在返回树末尾渲染 `<BranchRebindDialog ... onConfirm={onRebindBranch} />`。
- `ProjectEntryProps` 新增 `onRebindBranch: (repoPath: string) => void`。
- 选择放在 `ProjectEntry` 而不是 `ProjectRail`：`ProjectRail.tsx` 已 683 行，新增弹窗状态与 JSX 会逼近/超过 web 700 行上限；`ProjectEntry` 仅 +约 12 行。

`ProjectRail.tsx`：

```tsx
const startRebind = (repoPath: string) => {
  setOnboardingPath(repoPath);
  setOnboardingOpen(true);
};
```

并通过 `onRebindBranch={startRebind}` 传入当前项目的 `ProjectEntry`（仅 +约 5 行）。

### 5.4 复用既有接入弹窗

`ProjectOnboardingDialog` 已经：

- `inspect_local_project` 读取仓库当前分支；
- 检测同仓库不同分支的旧关联并提示“将替换当前仓库的旧分支绑定”；
- `preflight_pending_project` / `associate_pending_project` 完成写入。

因此重绑只需把 `repoPath` 传给它，不复制任何绑定逻辑。

## 6. 错误与兼容

| 场景 | 行为 |
| --- | --- |
| 旧客户端无命令 | 错误归一化为“当前客户端版本不支持…请升级”，弹窗可关闭 |
| 任务空间未关联/未批准 | 命令返回错误，弹窗显示原文 |
| 目录被删除/非 Git 仓库 | `NOT_GIT_REPOSITORY` 文案，弹窗可关闭，看板不受影响 |
| detached HEAD | `currentBranch: null`，无可用主按钮，提示先切换分支 |
| 仓库无本地分支 | 空态提示，无主按钮 |
| 当前检出 == 绑定分支 | 主按钮禁用，提示先切换；不会产生任何写入 |
| 当前检出 != 绑定分支 | 主按钮可用，走 onboarding 替换确认 |

## 7. 关键决策与取舍

1. **只读命令按 taskSpaceId 取路径**：避免 Web 侧传任意路径探测本机文件系统；与 `inspect_associated_project_agents` 的安全模型一致。
2. **只允许重绑当前检出分支**：用户已确认；不新增自动 checkout，符合 `docs/product-prd.md:489`、`:693-700`。分支名只用于展示，绝不回传后端，写入仍由 onboarding 自己 inspect。
3. **复用 ProjectOnboardingDialog**：保持“唯一写绑定路径”，自动获得 preflight、替换确认、团队/开发者选择与 toast。
4. **先拆 git.rs**：遵守 `.trellis/spec/desktop/tauri-commands` 的 1200 行守门（用户选择）；拆分与功能分两个提交。
5. **服务层放新模块**：`agent_service.rs` 已超限，新增逻辑放 `agent/branch_inspect.rs`，只对既有函数做同行可见性调整。
6. **不处理 worktree**：用户明确排除；worktree 自动接入与 `list_worktree_status` 不变。

## 8. 风险与缓解

- **Rust 拆分无法本地编译**：本机无 `cargo`/`rustc`（CI 构建）。缓解：纯机械搬移、禁止逻辑改动、函数名/行多重集自查，合并前用 `windows` workflow（`Rust unit tests`）验证；不声称本地编译通过。
- **拆分涉及安全敏感模块**：所有 `git` 调用仍走 `git_args`/`run_git`，固定参数、hooks 与环境不变；测试集合必须不变。
- **`main.rs` 剩余行数有限**（1168/1200）：命令与注册控制在约 14 行内；超出则改放新模块（命令壳仍必须在 main.rs）。
- **两个 Radix 弹窗顺序打开**：必要时延迟一帧打开 onboarding，避免焦点锁冲突。
- **分支列表与实际状态漂移**：弹窗只读一次；用户切换分支后需重新打开（或重试按钮）刷新，不在本任务做轮询。
- **旧客户端**：已做错误归一化；新入口只在 `invoke && activeTaskSpace` 时渲染，浏览器无影响。

## 9. 回滚

- 拆分提交可独立 revert，恢复单文件 `git.rs`。
- 功能提交回滚：删除按钮入口、弹窗、命令、权限与 capability 项即可；无数据迁移、无绑定结构变化，已绑定数据不受影响。
