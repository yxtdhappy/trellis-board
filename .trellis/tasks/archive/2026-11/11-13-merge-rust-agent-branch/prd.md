# 合并 Rust 单文件客户端分支并迁移快速初始化编码 Agent

## Goal

把 `codex/rust-desktop-agent-single-exe` 合并进当前分支 `main`：保留该分支对 sidecar/Node 运行时的删除，同时把 `main` 上独有的语义改动（项目栏快速初始化编码 Agent、stale sequence 冲突测试）迁移到 Rust 进程内 agent 与 npm workspaces 目录结构上，合并后全部检查通过。

## Background

- `main` 在合并基点 `a9a41d4` 之后新增 9 个提交，其中只有两个含代码语义：`927f443`（team-gitless stale sequence 409 测试）与 `617b09f`（快速初始化编码 Agent）。
- `codex/rust-desktop-agent-single-exe` 把 sidecar 子进程替换为进程内 Rust agent，并把仓库重排为 `apps/desktop`、`apps/server`、`apps/web`、`packages/*` 工作区，删除了 `agent/**`、`desktop/sidecar/**`、`tests/**`、`web/`、`shared/`、`server/` 以及 `.trellis/spec/backend/desktop-sidecar-packaging.md`。
- `617b09f` 直接修改的是 sidecar 时代路径与 `sidecar::` 调用，必须改写成 `agent_service::` 调用与 monorepo 路径后才能保留其行为。
- 快速初始化功能在 `main` 上已有归档任务 `11-12-project-rail-quick-agent-init` 的需求与验收标准，可直接沿用其行为契约。

## Requirements

### R1 合并与冲突解决

- 用 `git merge --no-ff codex/rust-desktop-agent-single-exe` 生成合并提交，保留 `main` 上 9 个提交的历史。
- 12 个冲突路径按“保留 Rust 结构 + 迁移 main 语义”解决，不得把 `web/`、`shared/`、`server/`、根 `tests/`、`agent/**`、`desktop/sidecar/**`、`desktop/src-tauri/binaries|resources` 重新带回工作区。
- `.trellis/spec/backend/desktop-sidecar-packaging.md` 保持删除，其仍有效的约束迁移到 `.trellis/spec/backend/desktop-agent-runtime.md`。
- `tests/desktop-device-auth.test.js`、`tests/desktop-package.test.js` 的 `main` 侧修改随 sidecar 测试一起删除。

### R2 保留 `main` 的团队同步测试

- `apps/server/test/team-gitless-http.test.js` 必须包含 `927f443` 新增的 stale sequence 断言：`batchId: 'batch-stale-sequence'`、`clientSequence: 1` 返回 409 `CONFLICT`，`details` 为 `{ previousSequence: 1, requiredClientSequence: 2 }`。

### R3 快速初始化编码 Agent 的 Rust 迁移

- 新增 `MAX_AGENT_TOOLS: usize = 22`（与 `packages/shared/trellis-agent-tools.js` 的 22 项目录一致）、`validate_developer_id()`、`validate_agent_tools()`、`approved_association_for_task_space()`（基于 `agent_service::LocalAssociation`，只接受同 `task_space_id` 且 `status == "approved"`）。
- 新增 `#[tauri::command] inspect_associated_project_agents(app, window, task_space_id)` 与 `initialize_associated_project_agents(app, window, task_space_id, developer_id, agent_tools)`：先 `ensure_board_caller()`，再 `validate_live_id()`，从 `agent_service::list_associations(&app)` 解析 `repo_path`，最后调用 `agent_service::inspect_project(&app, &repo_path)` / `agent_service::initialize_project(&app, &repo_path, &developer_id, &agent_tools)`。
- 两条命令注册进 `generate_handler!`，并在 `apps/desktop/src-tauri/permissions/desktop.toml` 与 `apps/desktop/src-tauri/capabilities/board-local-association.json` 补齐权限；远程页面只允许提交 `taskSpaceId`、`developerId`、`agentTools`。
- 既有 `initialize_pending_project`、`preflight_pending_project`、`associate_pending_project` 改用共享校验函数，消除重复的 developer ID / Agent 校验，并把“二十个”上限改为 `MAX_AGENT_TOOLS`。
- `main.rs` 末尾新增 `mod tests`：approved 选择、缺失/revoked/pending 拒绝、22 项接受且 23 项拒绝。

### R4 快速初始化前端迁移

- 新增 `apps/web/src/lib/project-inspection.js` 与 `.d.ts`（`normalizeProjectInspection()`），接入向导改用共享实现，删除本地 `ProjectInspection` 类型、`stringList`、`normalizeInspection`。
- 新增 `apps/web/src/features/board/dialogs/AgentToolSelector.tsx`（搜索 + 双列多选，已初始化禁用并标记“已初始化”）与 `AgentQuickInitDialog.tsx`（按 `taskSpaceId` 预检、默认 developer ID、只提交缺失工具、成功提示后关闭）。
- `ProjectRail` 在 `approved` 关联（含只读）的文件夹/锁图标右侧增加 `Bot` 入口按钮，并渲染快速初始化弹窗；未批准关联不显示。
- 保留该分支既有的 `ProjectOnboardingDialog` `path` 属性 API（弹窗内部自行预检），不得回退为 `inspection` 属性。
- 新增 `apps/web/test/project-inspection.test.js`（3 个用例：`project` 包装、直接响应默认值、缺少身份字段返回 null），符合根 `npm test` 的 `apps/*/test/*.test.js` 扫描规则。

### R5 文档与规格

- `apps/desktop/README.md` 的“快速追加本机编码 Agent”章节按单 EXE 架构改写：删除 sidecar 措辞，命令列表包含两条新命令，验证清单保留第 22–24 行场景。
- `.trellis/spec/backend/desktop-agent-runtime.md` 增加快速初始化的安全不变量（只提交 id、从 approved binding 解析路径、工具上限覆盖完整目录、不重启同步、不改服务端数据）。
- `.trellis/spec/frontend/rendering-and-state.md` 的快速入口与共享组件约束保留。

### R6 验证

- `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test`（`apps/desktop/src-tauri`）。
- 根目录 `npm test`、`npm run check:boundaries`、`npm run build:desktop`。
- 单 EXE 打包路径仍可用：`npm run desktop:package`（或等价 `cargo tauri build`）。

## Acceptance Criteria

- [ ] `git log --graph` 显示 `codex/rust-desktop-agent-single-exe` 已合并进 `main`，且 `main` 原 9 个提交仍在历史中。
- [ ] `git ls-files` 中不存在 `web/`、`shared/`、`server/`、`tests/`、`agent/`、`desktop/sidecar/`、`desktop/src-tauri/binaries`、`desktop/src-tauri/resources`、`.trellis/spec/backend/desktop-sidecar-packaging.md`。
- [ ] `apps/desktop/src-tauri/src/main.rs` 含两条新命令、共享校验函数与 3 个单测，`cargo test` 全部通过。
- [ ] 远程 capability 同时包含 `allow-inspect-associated-project-agents` 与 `allow-initialize-associated-project-agents`，permission 文件定义对应命令。
- [ ] `apps/web` 存在 `lib/project-inspection.{js,d.ts}`、两个新弹窗组件、`apps/web/test/project-inspection.test.js`，`ProjectOnboardingDialog` 使用共享规范化与 `AgentToolSelector` 且仍接收 `path`。
- [ ] 项目栏 approved 关联行出现“初始化编码 Agent”按钮，未批准关联不出现；点击后无需目录选择即可查看/追加本机 Agent。
- [ ] `apps/server/test/team-gitless-http.test.js` 的 stale sequence 用例保留并通过。
- [ ] `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test`、`npm test`、`npm run check:boundaries`、`npm run build:desktop` 全部通过。
- [ ] 文档与 spec 不再描述 sidecar 运行方式，快速初始化约束在 Rust 架构下可执行。

## Out of Scope

- 不修改服务端 API、数据库结构、任务空间字段或 agent 协议版本。
- 不重写既有 Rust agent 模块，不新增第三方依赖。
- 不提供移除本机 Agent 工具、跨设备批量管理或远程初始化能力。
- 不改变首次接入、差异处理、commit/push 策略与同步生命周期。
- 不恢复任何 sidecar/Node 运行时路径或脚本。
