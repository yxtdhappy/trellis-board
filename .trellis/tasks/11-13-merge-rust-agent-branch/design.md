# 设计：合并 Rust 单文件客户端分支并迁移快速初始化编码 Agent

## 1. 合并策略

```
git merge --no-ff codex/rust-desktop-agent-single-exe
```

- 基点 `a9a41d4`，`ours = main`（9 个提交），`theirs = codex/rust-desktop-agent-single-exe`（重排 + Rust agent）。
- 合并方向决定 rename 检测把 `main` 侧改动映射到新路径；`git merge-tree --write-tree --name-only main codex/rust-desktop-agent-single-exe` 已给出确定的 12 个冲突路径，无需试错。
- 冲突一律“保留 Rust/monorepo 结构（theirs 路径），迁移 main 的语义改动（人工重写）”，不做 `-X theirs` 之类整树覆盖，避免丢失 `main` 的 `927f443` 测试。

### 冲突矩阵

| 路径 | 冲突类型 | 解决方式 |
| --- | --- | --- |
| `.trellis/spec/backend/desktop-sidecar-packaging.md` | modify/delete | 保持删除；有效不变量写入 `desktop-agent-runtime.md` |
| `apps/desktop/src-tauri/capabilities/board-local-association.json` | content | 取 theirs 列表，追加两条 agent 权限 id（`allow-inspect-…`、`allow-initialize-…`） |
| `apps/desktop/src-tauri/src/main.rs` | content | 取 theirs，追加常量/校验/两条命令/注册/单测，改造既有三个命令复用校验 |
| `apps/server/test/project-inspection.test.js` | file location | 删除误放文件，改写为 `apps/web/test/project-inspection.test.js`（导入 `../src/lib/project-inspection.js`） |
| `apps/web/src/components/layout/ProjectRail.tsx` | content | 取 theirs，加入 `Bot` 入口按钮、`quickAgentTaskSpaceId` 状态与弹窗；保留 `path={onboardingPath}` |
| `apps/web/src/features/board/dialogs/AgentQuickInitDialog.tsx` | file location | 落盘到 `apps/web/src/features/board/dialogs/` |
| `apps/web/src/features/board/dialogs/AgentToolSelector.tsx` | file location | 同上 |
| `apps/web/src/features/board/dialogs/ProjectOnboardingDialog.tsx` | content | 取 theirs（`path` 属性版本），套用共享 normalize + `AgentToolSelector`，删除本地实现 |
| `apps/web/src/lib/project-inspection.d.ts` / `.js` | file location | 落盘到 `apps/web/src/lib/` |
| `tests/desktop-device-auth.test.js` / `tests/desktop-package.test.js` | modify/delete | 保持删除（sidecar 时代测试） |

自动合并但必须复核的文件：`apps/desktop/src-tauri/permissions/desktop.toml`（应含两条新 permission）、`apps/desktop/README.md`（章节措辞仍写 sidecar）、`.trellis/spec/frontend/rendering-and-state.md`（新增 bullets 已落地）、`apps/server/test/team-gitless-http.test.js`（stale sequence 用例已落地）。

## 2. Rust 迁移

文件：`apps/desktop/src-tauri/src/main.rs`

```rust
// 与 packages/shared/trellis-agent-tools.js 当前目录数量保持一致。
const MAX_AGENT_TOOLS: usize = 22;

fn validate_developer_id(value: &str) -> Result<String, String>;      // trim，非空，≤120 chars
fn validate_agent_tools(agent_tools: &[String]) -> Result<Vec<String>, String>;
// 非空、≤MAX_AGENT_TOOLS、逐项 trim 后 1..=40 字节且仅 [a-z0-9-]

fn approved_association_for_task_space<'a>(
    associations: &'a [agent_service::LocalAssociation],
    task_space_id: &str,
) -> Result<&'a agent_service::LocalAssociation, String>;
```

命令（`sidecar::` → `agent_service::`，且不再传 `config::agent_root()`）：

```rust
#[tauri::command]
async fn inspect_associated_project_agents(app, window, task_space_id: String) -> Result<Value, String> {
    ensure_board_caller(&app, &window)?;
    let task_space_id = validate_live_id(&task_space_id, "任务空间 ID")?;
    let associations = agent_service::list_associations(&app).await?;
    let repo_path = approved_association_for_task_space(&associations, &task_space_id)?.repo_path.clone();
    agent_service::inspect_project(&app, &repo_path).await
}

#[tauri::command]
async fn initialize_associated_project_agents(app, window, task_space_id, developer_id, agent_tools) -> Result<Value, String> {
    ensure_board_caller(&app, &window)?;
    let task_space_id = validate_live_id(&task_space_id, "任务空间 ID")?;
    let developer_id = validate_developer_id(&developer_id)?;
    let agent_tools = validate_agent_tools(&agent_tools)?;
    let associations = agent_service::list_associations(&app).await?;
    let repo_path = approved_association_for_task_space(&associations, &task_space_id)?.repo_path.clone();
    agent_service::initialize_project(&app, &repo_path, &developer_id, &agent_tools).await
}
```

- `inspect_project` 返回 `{"ok":true,"project":{…}}`，与 `normalizeProjectInspection` 的 `outer.project` 解包一致，无需改 DTO。
- `initialize_project` 内部已做 Git 根目录、Agent 白名单与增量初始化，命令层不重复实现。
- 既有命令改造：`initialize_pending_project`、`preflight_pending_project`、`associate_pending_project` 复用 `validate_developer_id`/`validate_agent_tools`，删除内联检查；错误文案中的“二十个”改为 `MAX_AGENT_TOOLS`。
- 单测放在 `main.rs` 末尾 `#[cfg(test)] mod tests`，helper 构造 `agent_service::LocalAssociation`（字段：`project_id, task_space_id, repo_path, display_name, branch_name, team_id, status, read_only, live_sync_status, live_sync_error, deferred_count, deferred_task_dirs, last_error_code, last_error`）。
- `crate` 级已 `#![allow(clippy::result_large_err)]`，命令返回 `Result<_, String>` 不触发 clippy。

权限与 capability：

- `permissions/desktop.toml` 追加 `allow-inspect-associated-project-agents`、`allow-initialize-associated-project-agents`（描述改为“当前 Board origin 可按已批准关联…”）。
- `capabilities/board-local-association.json` 的 `permissions` 数组加入两条 id，保留 theirs 的 `allow-pick-local-project-folder`、`allow-preflight-pending-project`。

## 3. Web 迁移

- `apps/web/src/lib/project-inspection.{js,d.ts}`：原样迁移（`.d.ts` 手写类型，与 `onboarding-probe` 等同目录约定一致）。
- `apps/web/test/project-inspection.test.js`：导入路径改为 `../src/lib/project-inspection.js`，断言不变。
- `AgentToolSelector.tsx` / `AgentQuickInitDialog.tsx`：原样迁移；import 保持 `@/components/ui/*`、`@shared/trellis-agent-tools.js`、`@/lib/onboarding-probe.js`（该分支已有这些别名与组件）。
- `ProjectOnboardingDialog.tsx`：保留 `path: string` 属性与内部 `inspect_local_project` 流程；删除 `ProjectInspection` 类型、`stringList`、`normalizeInspection`，改为 `import { normalizeProjectInspection } from '@/lib/project-inspection.js'`；内联 Agent 网格（约 737 行的 `visibleAgentTools` 区块）替换为 `<AgentToolSelector …/>`，`visibleAgentTools` memo 删除；`Input` 仍被 developer ID 输入使用，保留。
- `ProjectRail.tsx`：`lucide-react` 增加 `Bot`；新增 `quickAgentTaskSpaceId` 状态；approved 分支渲染 `<span>` 图标 + `Bot` 按钮（`aria-label={\`初始化 ${project.name} ${activeTaskSpace.branchName} 的编码 Agent\`}`）；底部与 `ProjectOnboardingDialog` 同级渲染 `AgentQuickInitDialog`（`open={quickAgentTaskSpaceId !== null}`，关闭时置空）。
- 不引入新的 UI 组件或依赖。

## 4. 文档与规格

- `apps/desktop/README.md`：自动合并后的“快速追加本机编码 Agent”章节把 `sidecar inspectProject` / `sidecar initializeProject` / “重启任务同步 sidecar” 改为 `agent_service::inspect_project` / `initialize_project` / “不重启进程内 Agent”；命令列表与验证清单核对。
- `.trellis/spec/backend/desktop-agent-runtime.md`：在“必须保持的契约”增加四条：远程只提交 `taskSpaceId`/`developerId`/`agentTools`；先 `validate_live_id` 再从 `list_associations` 选 approved 解析 `repoPath`；`MAX_AGENT_TOOLS` 覆盖完整 22 项目录；复用 `inspect_project`/`initialize_project`，不新增 CLI、不重启同步、不改服务端数据。
- `.trellis/spec/frontend/rendering-and-state.md`：自动合并内容保持，核对措辞（不出现 sidecar）。
- 不恢复 `desktop-sidecar-packaging.md`。

## 5. 验证

```
cd apps/desktop/src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test

npm test
npm run check:boundaries
npm run build:desktop
npm run desktop:package        # 单 EXE 打包冒烟
```

前端行为验收：`npm run dev` + 桌面壳加载真实 Board 页面，确认 approved 关联行出现 Bot 入口、未批准关联不出现、弹窗预检/多选/成功关闭；无桌面壳时以 `cargo tauri dev` 或打包产物替代，并在报告中说明实际验证到的层级。

## 6. 风险

- `ProjectOnboardingDialog` 两侧都改：误用 `main` 的 `inspection` 属性会破坏该分支“先弹窗再预检”的行为，必须以 theirs 为准。
- 合并会重新带回 `main` 的根 `tests/` 目录（`project-inspection` 之外还有 `927f443` 已 rename 到 `apps/server/test`），解决后需 `git status` 确认无残留。
- `apps/desktop/src-tauri/target/**` 等未跟踪构建产物会干扰 `git status` 判断，提交前只暂存任务相关路径。
- `panic = "abort"`：新增 Rust 代码不得 `unwrap`/`expect`；单测中 `unwrap` 允许（测试 profile 不受影响）。
