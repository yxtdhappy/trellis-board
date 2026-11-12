# PRD: 接入本地项目 dialog 即时弹出（loading 占位）

## Goal

「任务流水线」页点击「接入本地项目」→ 选择本地仓库目录后，`ProjectOnboardingDialog` 必须**立即**弹出并先渲染 skeleton 占位，`inspect_local_project` 的数据返回后再替换为完整表单；不再出现「选完目录后按钮长时间转圈、没有反馈」。

## Background

当前 `inspect_local_project`（`desktop/src-tauri/src/main.rs:389-419`）一次调用做完两件事：`blocking_pick_folder()` 选目录 + `await sidecar::inspect_project(...)` 读仓库（git 远端、分支、trellis 状态，`sidecar.rs:882`）。前端 `ProjectRail.startProjectOnboarding()`（`web/src/components/layout/ProjectRail.tsx:270`）只有在整个命令返回后才 `setOnboardingOpen(true)`。

于是慢仓库（`git fetch` 远端、大工作区）期间用户看到的是侧栏按钮 `animate-pulse` + 「正在检查本地项目…」，无法区分「还在等系统选目录弹窗」与「正在检查」，也看不到任何进度结构。

用户已定方案：把「选目录」与「读仓库」拆成两个命令，前端拿到路径后立刻开弹窗，弹窗内部自己负责 loading/失败/重试。

## Requirements

### R1 命令拆分（Rust）

- 新增 `pick_local_project_folder(app, window) -> Result<Option<String>, String>`：只做 `ensure_board_caller` + `blocking_pick_folder()` + 目录校验，返回绝对路径字符串；用户取消返回 `Ok(None)`。
- `inspect_local_project(app, window, path: String)` 改为接收路径参数，只做检查：校验路径非空且是目录 → 清理旧 `pending_project_path` → `sidecar::inspect_project` → 存 `pending_project_path` → 返回检查结果（不再返回 `Option`）。
- 不新增/不改其它命令：`initialize_pending_project`、`check_pending_project_push`、`preflight_pending_project`、`associate_pending_project`、`cancel_pending_project` 的签名与语义保持不变；`pending_project_path` 仍是唯一的「用户刚选的目录」凭据。

### R2 权限

- `desktop/src-tauri/permissions/desktop.toml` 新增独立权限块 `allow-pick-local-project-folder`（`commands.allow = ["pick_local_project_folder"]`），描述写明「返回路径但不读取仓库」。
- Board 侧 capability（`desktop/src-tauri/capabilities/board-local-association.json`）加入该权限；`allow-inspect-local-project` 的定义保持不变（既有断言 `/commands\.allow = \["inspect_local_project"\]/` 继续成立）。

### R3 前端即时弹窗（web）

- `ProjectRail.startProjectOnboarding()`：先 `invoke('pick_local_project_folder')`，拿到路径后立即 `setOnboardingOpen(true)`；取消时什么都不做。此阶段不再调用 `inspect_local_project`。
- `ProjectOnboardingDialog` 自己执行检查：`open && path` 时 `invoke('inspect_local_project', { path })`，组件内维护 `loading` / `inspection` / `error` 三态，`path` 变化或重新打开时重新检查。
- loading 态界面：`DialogHeader`（标题「接入本地 Git 项目」+ 原有描述）+ `DialogBody` 内 skeleton 占位（仓库/分支/远端/Trellis/Git 状态 5 行 + 团队/开发者 2 行 + 工具勾选区），`DialogFooter` 保留「取消」，主操作按钮禁用。
- 失败态界面：`DialogBody` 内 destructive 提示块显示错误文案，footer 提供「重试」（重新 inspect 同一路径）与「取消」。
- 无效仓库（缺少 `root`/`remoteUrl`/`branchName`）：同样走失败态，文案说明「所选目录不是受支持的 Git 仓库（需要 Git 仓库且配置了远端分支）」，不再出现「请重新选择仓库根目录」这类要求用户重来的死路。
- 关闭语义：`loading` 期间允许关闭（不显示「正在处理」阻塞），关闭时调用 `cancel_pending_project` 清理 pending；`busy`（初始化/预检/关联中）时维持现有阻塞行为。

## Out of Scope

- 不改 `inspect_project` 的 sidecar/agent 实现与返回字段（`sidecar.rs:882`）；`ProjectOnboardingDialog` 的表单字段、`AGENT_TOOLS` 列表、初始化/推送/预检/关联逻辑与文案不动。
- 不做「检查进度百分比/分步进度」——只做骨架占位，不新增事件通道。
- 不改 `desktop/ui/**`（客户端窗口由父任务的 `11-12-desktop-ui-shadcn-migration` 负责）。
- 不改服务端。

## Acceptance Criteria

1. 点击「接入本地项目」→ 系统选目录对话框 → 选完目录后 `<100ms` 内出现 dialog（可用 devtools 时间线证实），此时内容为 skeleton，非空白也非错误。
2. 检查完成后 skeleton 替换为完整表单（仓库 / 当前分支 / 远端 / Trellis / Git 状态 / 团队 / 开发者 / agent 工具），默认团队与开发者按现有逻辑预填。
3. 人为制造慢仓库（远端不可达使 `git fetch` 变慢）时，dialog 先出现，等待期间 UI 可交互（可滚动、可点取消）。
4. 取消选目录：不弹 dialog、不改 pending 状态、无 toast 报错。
5. 检查失败（路径无权限 / 非 Git 仓库 / 远端异常）时 dialog 内显示后端错误文案 + 「重试」「取消」；重试成功后进入完整表单；取消后 `pending_project_path` 已清理，可立即重新接入。
6. loading 期间关闭 dialog 不阻塞、不残留 pending：再次接入可正常完成全流程。
7. 完整链路仍可用：接入 → 初始化（`initialize_pending_project`）→ 推送检查 → 预检 → 关联成功；与改造前返回字段一致。
8. 质量门：`cargo test --manifest-path desktop/src-tauri/Cargo.toml` 通过；`npm test` 通过；`npm --prefix web run lint` / `build` 通过。
