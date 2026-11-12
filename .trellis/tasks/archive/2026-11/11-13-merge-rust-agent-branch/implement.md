# 实施计划：合并 Rust 单文件客户端分支并迁移快速初始化编码 Agent

## Step 0 预检

- `git status --short` 确认工作区只有已知未跟踪构建产物（`apps/desktop/src-tauri/gen/**`、`apps/desktop/src-tauri/target/**`）。
- `git rev-parse main codex/rust-desktop-agent-single-exe`、`git merge-base main codex/rust-desktop-agent-single-exe` 记录到报告。

## Step 1 执行合并

- `git merge --no-ff codex/rust-desktop-agent-single-exe`（预期 12 个冲突，见 design.md 冲突矩阵）。
- 冲突解决顺序：删除类 → 新文件落盘 → Rust main.rs → 前端三个组件 → capabilities。
- `git status` 确认无残留 `web/`、`shared/`、`server/`、根 `tests/`、`agent/`、`desktop/sidecar/`。

## Step 2 Rust 后端

1. `apps/desktop/src-tauri/src/main.rs`：加 `MAX_AGENT_TOOLS`、`validate_developer_id`、`validate_agent_tools`、`approved_association_for_task_space`（`agent_service::LocalAssociation`）。
2. 加两条 `#[tauri::command]`，调用 `agent_service::{list_associations, inspect_project, initialize_project}`，注册进 `generate_handler!`。
3. 改造 `initialize_pending_project` / `preflight_pending_project` / `associate_pending_project` 复用校验函数。
4. 末尾 `#[cfg(test)] mod tests` 写 3 个单测。
5. `permissions/desktop.toml` 与 `capabilities/board-local-association.json` 补权限。

## Step 3 Web 前端

1. 新增 `apps/web/src/lib/project-inspection.js`、`.d.ts`。
2. 新增 `apps/web/src/features/board/dialogs/AgentToolSelector.tsx`、`AgentQuickInitDialog.tsx`。
3. `ProjectOnboardingDialog.tsx`：删本地 normalize/类型/`stringList`，接入共享 normalize 与 `AgentToolSelector`，保留 `path` 属性。
4. `ProjectRail.tsx`：`Bot` 入口按钮 + `quickAgentTaskSpaceId` 状态 + 弹窗渲染。
5. 新增 `apps/web/test/project-inspection.test.js`（3 用例）。

## Step 4 文档与规格

- `apps/desktop/README.md`：快速初始化章节去掉 sidecar 措辞，核对命令列表与验证清单。
- `.trellis/spec/backend/desktop-agent-runtime.md`：补 4 条快速初始化不变量。
- `.trellis/spec/frontend/rendering-and-state.md`：核对自动合并的 bullets。
- 确认 `.trellis/spec/backend/desktop-sidecar-packaging.md` 未复活。

## Step 5 验证

```
cd apps/desktop/src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

```
npm test
npm run check:boundaries
npm run build:desktop
npm run desktop:package
```

- 前端行为：真实 Tauri 窗口（或 dev 壳）打开 Board，验证 approved 关联出现入口、未批准不出现、弹窗预检与初始化成功/失败路径。

## Step 6 收尾

- 清理临时文件（`tmp/` 下的 merge-tree 输出等）。
- 汇报变更范围与验证结果，等待用户确认后再提交；提交内容包含 `.trellis/tasks/11-13-merge-rust-agent-branch/`。
