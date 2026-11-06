# 设计：服务端用户管理（仅管理员建号）

## 边界

- 仅 `systemAdmin` 可创建账号、修改账号字段、重置密码和配置团队；团队管理员继续只能管理项目。
- 不新增注册路由；`/api/auth/register` 未命中现有路由表时由统一 404 分支返回。
- 本次只改新密码校验，不校验旧哈希；已有账号继续用原 scrypt 哈希登录。

## 密码策略

`server/team/auth.js` 的 `validatePassword()` 是唯一入口：

- 最少 6 个 Unicode code point（`Array.from(password).length`），最多 1024 UTF-8 字节。
- 无大小写、数字、符号、字典或泄露密码校验。
- `hashPassword()` 继续先调用 `validatePassword()`，因此建号、管理员重置、用户自助改密三处共用同一规则。
- `PASSWORD_PARAMS`（scrypt `N=32768, r=8, p=1, keylen=64`）不变，旧哈希可继续验证。

## 后端契约

### `createUser(db, input)`

- 输入新增可选 `teams: [{ teamId, role }]`；`password` 必填，`mustChangePassword` 默认 `false`。
- 先校验用户名、显示名、团队分配，再哈希密码并插入 `user_account`；插入后通过 `setUserTeams()` 写入 `team_member`，复用现有团队审计。
- 团队可空；`createdBy` 作为团队变更审计的操作者。
- 不再生成随机密码。

### `resetUserPassword(db, { userId, actorUserId, password })`

- 必填 `password`，通过 `hashPassword()` 校验并哈希。
- 更新 `password_hash` / `password_params_json` / `password_changed_at` / `updated_at`，写 `must_change_password = 0`。
- 撤销该用户全部会话，写 `user_password_reset` 审计；响应不含密码或临时密码。

### HTTP

- `POST /api/admin/users`（仅 `requireAdmin`）
  - body：`username`、`displayName`、`password` 必填；`teamIds?: string[]` 或兼容的 `teams?: (string|{teamId,role})[]`；`systemAdmin?: boolean`。
  - 缺失密码或密码不足 6 字符返回 400，不自动生成；团队 ID 先校验，非法时不建号。
  - 201 返回 `{ user: { ...publicUser, teams } }`，不含 `temporaryPassword`。
- `PATCH /api/admin/users/:id`（仅 `requireAdmin`）
  - 支持 `displayName`、`status`、`systemAdmin`、`teamIds` / `teams`；团队沿用现有 `setUserTeams()`，保留未删除团队的角色，新团队默认 `member`。
- `PUT /api/admin/users/:id/teams` 保留，继续要求系统管理员。
- `POST /api/admin/users/:id/reset-password` 读取 body `{ password }`，成功后返回 `{ user }`。

## 审计

- `user_created`：创建账号一次。
- `user_updated`：仅在显示名、状态或系统管理员字段实际变化时写入；停用同时撤销会话。
- `user_password_reset`：重置密码一次。
- 团队成员增删/角色变化继续由 `setUserTeams()` 写 `team_member_added` / `team_member_removed` / `team_member_updated` 与 `user_teams_updated`，不在 HTTP 层重复写同类事件。
- 审计详情只写状态、权限、团队 ID/角色，不写密码、哈希或 token。

## 前端契约

- `web/src/api/admin.ts`
  - `NewUserInput` 增加 `password`、`teamIds`；`createUser()` 返回 `AdminUser | null`。
  - `UserUpdate` 增加 `teamIds`；`resetUserPassword(userId, password)` 发送密码，返回 void。
- `useAdminConsole`
  - `createUser` 成功后刷新列表，不再调用一次性凭证弹窗。
  - `resetPassword(target, password)` 调用新接口并刷新列表。
- `UsersTab`
  - 创建表单：登录名、显示名、密码（`type=password`，`minLength=6`）、团队多选、系统管理员。
  - 编辑：复用 `AccountForm`，增加团队多选；通过 `fetchAdminTeams()` 获取可选团队。
  - 重置密码：独立对话框输入新密码与确认密码，二次确认一致后提交。
  - 列表展示所属团队；不再展示“待改密”。
- `OneTimeCredentialDialog` 仍用于 Agent 配对码，保留；用户创建/重置不再使用它。

## 兼容与回滚

- 数据库 schema 不变；`must_change_password` 列保留但新流程写 0。
- 旧客户端发送 `teams` 仍被接受；新客户端发送 `teamIds`。
- 回滚只需还原代码；已写入的账号哈希仍符合 scrypt 参数，不受密码下限变化影响。
