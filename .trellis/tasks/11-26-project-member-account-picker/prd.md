# 优化项目成员添加体验

## Goal

让有项目成员管理权限的用户能从已有账号中直接选人，页面提交内部用户 ID；不再要求用户凭记忆填写 UUID，也不再因为把登录名填进“用户 ID”而得到 `用户不存在 (NOT_FOUND)`。

## Background

- 线上复现：在 `mom-esop-service` 的“项目成员”表单中填写登录名 `zsw` 后，服务返回 `用户不存在 (NOT_FOUND)`。
- 账号 `zsw` 实际存在且状态为 `active`，内部用户 ID 为 `58717f60-6995-4c79-b4e1-ca1c352e42df`。
- 当前表单把输入值原样作为 `userId` 提交：`packages/web/src/features/admin/ProjectsTab.tsx:117`、`packages/web/src/api/admin/members.ts:29`。
- 后端按 `user_account.id` 精确查询有效账号：`packages/server/team/task-space/membership.js:69`、`packages/server/team/task-space/shared.js:345`。登录名与内部 ID 不同，因此 `zsw` 查询失败。
- 团队管理页已有“选择用户”下拉模式：`packages/web/src/features/admin/TeamsTab.tsx:180`。本次优先复用该交互与现有账号列表接口。
- 已确认产品范围：只增强当前已有账号目录权限的系统管理员和团队管理员；项目负责人保留手工填写内部用户 ID 的兼容路径，不扩大用户目录可见范围。

## Requirements

- 系统管理员或团队管理员进入“项目协作”并选择项目后，可以直接从当前可见的有效账号中选择项目成员，无需先切到“用户账号”页或手工复制 UUID。
- 账号选项必须同时展示可区分的信息，至少包含显示名和登录名；提交给现有成员保存接口的 `userId` 必须是所选账号的内部 UUID。
- 编辑已有成员时，选择器应正确回显该成员当前账号；保存后仍刷新成员列表并清空新增表单。
- 角色和 `Trellis developer ID` 的现有规则保持不变：可写成员必须填写 developer ID，只读成员不要求 developer ID。
- 当当前操作者无权加载账号目录时，保留现有“用户 ID”手工输入作为兼容路径，并明确提示需要填写内部用户 ID，而不是登录名。
- 账号目录加载失败不能静默失败；应提示失败原因，并允许使用兼容的手工输入路径继续操作。
- 停用账号不能作为新成员候选；已存在的成员编辑不应因本次交互改动被意外移除。
- 不新增后端接口，不改变 `/api/admin/users` 和项目成员保存接口的权限边界。

## Technical Notes

- 现有账号列表接口为 `/api/admin/users`，返回 `id`、`username`、`displayName`、`status` 等字段。
- 现有项目成员保存接口和请求结构保持不变：`PUT /api/projects/:projectId/members`，请求体仍为 `{ userId, role, trellisDevId }`。
- “项目协作”页当前也允许项目负责人进入，但 `/api/admin/users` 只对团队/系统管理员开放；本次由前端根据当前管理权限在“账号选择器”和“手工 UUID 输入”之间切换。
- 账号候选使用管理页已有的 `users` 数据和 `reloadUsers()` 加载能力，避免重复实现账号查询逻辑或新增共享抽象。

## Acceptance Criteria

- [ ] 管理员在项目成员表单中能看到账号选择器，选项至少显示“显示名 + 登录名”，且不展示 UUID 作为主要操作信息。
- [ ] 选择 `zsw` 后保存成员，浏览器请求体中的 `userId` 为 `58717f60-6995-4c79-b4e1-ca1c352e42df`，接口返回成功，成员列表出现对应账号。
- [ ] 选择器只提供状态为 `active` 的账号作为新成员候选。
- [ ] 编辑现有成员时选择器回显正确账号，修改角色或 developer ID 后可以正常保存。
- [ ] 项目负责人等无账号目录权限的操作者仍看到手工“用户 ID”输入，页面文案明确说明应填写内部 UUID。
- [ ] 账号目录请求失败时有可见错误提示，且不会清空已填写的角色或 developer ID。
- [ ] 现有“可写成员必须填写 developer ID”和“只读成员不要求 developer ID”的服务端校验行为不变。

## Out of Scope

- 不新增项目级候选账号接口，不允许项目负责人查看全系统用户目录。
- 不改项目成员保存接口、用户账号创建流程、团队管理流程或权限模型。
- 不做模糊搜索、批量添加、邀请待接受账号或在表单内创建新账号。

## Notes

- 轻量前端任务，仅使用 `prd.md` 作为规划制品；不新增 `design.md` 或 `implement.md`。
