# 项目成员账号选择器代码上下文

## 当前行为

- `packages/web/src/features/admin/ProjectsTab.tsx:117` 将“用户 ID”输入框文本直接传给 `saveMember()`。
- `packages/web/src/api/admin/members.ts:29` 使用 `PUT /api/projects/:projectId/members` 提交 `{ userId, role, trellisDevId }`。
- `packages/server/team/task-space/membership.js:69` 按 `user_account.id` 精确查有效账号，查不到时返回 `404 NOT_FOUND / 用户不存在`。
- `packages/server/team/task-space/shared.js:345` 的查询条件是 `id = ? AND status = 'active'`。

## 可复用能力

- `packages/web/src/hooks/useAdminConsole.ts:29` 的 `AdminConsole` 已暴露 `isAdmin`、`users` 和 `reloadUsers()`。
- `packages/web/src/hooks/useAdminConsole.ts:166` 通过 `/api/admin/users` 加载账号，并按当前管理团队范围过滤。
- `packages/web/src/features/admin/TeamsTab.tsx:180` 已使用 `SelectField` 按账号内部 ID 选择用户，可作为交互参考。
- `packages/web/src/features/board/SelectField.tsx:23` 是现有下拉组件，不需要新增选择器组件。
- `packages/web/src/api/admin/types.ts:61` 的项目成员视图包含 `userId`、`username`、`displayName` 和 `status`；`AdminUser` 同样包含内部 ID、登录名、显示名和状态。

## 约束与边界

- `/api/admin/users` 仅对团队/系统管理员开放，项目负责人仍使用手工 UUID 输入。
- 新成员候选只展示有效账号；编辑已有成员时不能因为候选过滤导致当前值意外消失。
- 前后端保存契约和 developer ID 校验不变，本次没有后端接口变更。
