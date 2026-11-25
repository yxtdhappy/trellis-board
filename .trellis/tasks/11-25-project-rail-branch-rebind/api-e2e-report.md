# API / E2E 报告：项目栏已关联分支图标支持重新绑定分支

## HTTP API

不存在新增或修改的 HTTP API；本任务只新增桌面端 Tauri IPC 命令，服务端接口未变。HTTP 接口 E2E 验证不适用。

## 新增 IPC 契约

命令：`inspect_associated_project_branches`

请求参数：

```json
{ "taskSpaceId": "<任务空间 ID>" }
```

成功响应：

```json
{
  "ok": true,
  "repoPath": "<已批准关联的仓库绝对路径>",
  "currentBranch": "<当前检出分支或 null>",
  "branches": ["<本地分支名>", "..."]
}
```

调用链：`ensure_board_caller` → `validate_live_id` → `list_associations` → `approved_association_for_task_space` → `agent::branch_inspect::inspect_associated_project_branches` → `git::current_branch` / `git::branch_list`。

错误路径：

- 非 Board 调用方：`ensure_board_caller` 拒绝。
- 任务空间 ID 非法：`validate_live_id` 拒绝。
- 任务空间无已批准关联：`approved_association_for_task_space` 返回错误。
- 仓库不可读 / Git 失败：透传 `AgentError.message`。
- detached HEAD：不报错，`currentBranch` 为 `null`，前端给出切换提示。
- 旧客户端缺少命令：前端归一化为“当前客户端版本不支持重新绑定分支，请升级客户端”。

## 验证方式

- 静态契约：`packages/desktop/test/desktop-ui-build.test.js` 的 `desktop board can inspect branches of an approved local association` 已通过，覆盖命令注册、`ensure_board_caller`、关联校验、权限与 capability 归属。
- 前端纯逻辑：`packages/web/test/branch-rebind.test.js` 4 个用例通过，覆盖归一化、禁用态、detached/空列表与旧客户端错误映射。
- 运行时 IPC 往返与桌面手工 E2E：本机无 Rust 工具链与可运行 Tauri 构建，未执行；待 CI 构建后由用户环境验收。
