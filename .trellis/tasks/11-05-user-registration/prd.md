# 服务端用户管理（仅管理员建号）

## Goal

保持“用户只能由管理员创建”的边界，并把用户管理做到最简：系统管理员创建账号时填写用户名、显示名、密码（最少 6 个字符，不做复杂度校验）并勾选所属团队；不提供公开注册、邀请、强制改密或复杂密码策略。普通用户和团队管理员不能创建账号或团队，用户只能在系统管理员分配的团队之间切换。

## Dependencies

- 依赖 `11-05-team-isolation`：团队、多团队成员关系、活动团队与隔离查询必须先存在。
- 客户端 `11-05-workspace-bootstrap` 使用管理员创建的用户名初始化 Trellis developer；本任务需冻结用户名规则与 developer ID 映射。

## Current State（仓库事实）

- 只有管理员建号：`server/team/http.js:546` 的 `POST /api/admin/users` 先 `requireAdmin`，再调用 `server/team/auth.js:202` 的 `createUser()`；当前接口接受 `password`/`temporaryPassword`，未传时用 `randomPassword()` 生成一次性临时密码，`mustChangePassword` 默认 `!suppliedPassword`，响应会返回 `temporaryPassword`。
- 首个系统管理员只能通过本机 CLI 创建：`server/team/cli.js:175`（`init-admin`）。
- 没有 `/api/auth/register` 或任何公开注册路由；`server/team/http.js` 只有 login/logout/password/me。登录页 `web/src/pages/login/LoginPage.tsx` 已提示“账号由系统管理员创建、忘记密码联系管理员”，没有注册入口。这正是需要保持的行为。
- 现有建号接口支持 `systemAdmin`、`mustChangePassword`、可选密码；未传密码时生成临时密码；没有团队分配，`createUser()` 也没有 `teams` 参数。
- 现有重置密码：`server/team/http.js` 的 `POST /api/admin/users/:id/reset-password` 调用 `server/team/auth.js:525` `resetUserPassword()`，生成随机临时密码、设置 `must_change_password=1`、撤销全部会话，并返回 `temporaryPassword`。
- 用户名规则：`server/team/auth.js:15` 的 `/^[A-Za-z0-9._-]{3,64}$/`，统一转小写后作为 `username_key`；数据库全局唯一。
- 密码规则：`server/team/auth.js:97` 当前要求至少 12 个字符、最多 1024 字节；本任务要改为至少 6 个字符，且不做大小写/数字/符号等复杂度校验。`scrypt` 参数 `N=32768, r=8, p=1, keylen=64` 保持不变。
- 登录限流：`server/team/auth.js` 的 `LOGIN_WINDOW_MS = 15 分钟`、`LOGIN_MAX_FAILURES = 5`，按用户名 + IP 记录 `login_attempt`。
- 会话 Cookie：`trellis_team_session`；会话可撤销，`must_change_password` 控制首次登录改密；`server/team/http.js:1019` 对未改密用户除改密/登出外一律 403。
- 管理界面现状：`web/src/pages/admin/AdminPage.tsx:14` 的用户页签使用 `web/src/features/admin/UsersTab.tsx`，创建表单只有 `username`、`displayName`、`systemAdmin`，由服务端生成临时密码；`web/src/features/admin/AccountDialog.tsx` 只改显示名/状态/系统管理员；`web/src/api/admin.ts:354` 的 `NewUserInput` 没有 `password`/`teams`；`OneTimeCredentialDialog` 用于展示临时密码。
- 审计表 `audit_event` 已有 `actor_user_id`、`action`、`target_type`、`target_id`、`result`、`detail_json`；当前用户相关 action 是 `user_created`、`user_updated`、`user_password_reset`，启停通过 `user_updated` 的 detail 记录，没有独立的 `user_disabled`/`user_enabled`，也没有 `team_member_*`。
- 当前 `user_account` 没有团队字段；团队归属由 `11-05-team-isolation` 的 `team_member` 提供。

## In Scope

- **保持关闭注册**：
  - 不新增 `POST /api/auth/register`、`web/register.html` 或任何自助建号入口；未认证请求该路径返回 404。
  - 登录页不显示“注册/创建账号”链接，只提示“请联系管理员开通账号”。
  - 配置项 `TRELLIS_TEAM_REGISTRATION=closed`（默认且唯一支持值）。
  - 增加回归测试，确保公开注册路由不存在、未认证请求不能创建账号。
- 管理员建号（最简表单）：
  - 只有**系统管理员**可以创建账号、配置用户团队和重置密码；普通用户和团队管理员都没有任何建号或改团队归属的入口。团队管理员只管理项目（项目设置、项目角色、项目审计）。
  - 创建字段：`username`、`displayName`、`password`（管理员直接填写，最少 6 个字符）、`teams`（团队多选，可留空，之后补配）、`systemAdmin`（仅系统管理员可设置，默认关闭）。
  - 团队可留空：账号先建好，之后由系统管理员在用户详情中补配团队；无团队账号可以登录，但只看到空状态。
  - 不生成临时密码，不强制首次改密；`mustChangePassword` 保留为兼容字段，默认 `false`，管理界面不暴露。
  - 创建成功后不返回密码；管理员填写的密码只用于哈希入库，不回显、不写日志。
- 团队配置：
  - **团队只能由系统管理员创建和配置**：系统管理员创建/重命名/停用团队，并为每个用户配置所属团队和团队角色；团队管理员不能创建/停用团队，也不能修改团队成员分配（只能管理自己团队内的项目）。
  - 一个用户可以属于多个团队；创建时勾选，创建后可在用户详情中增加/移除。
  - 普通用户不能创建团队、不能自助加入/退出/修改团队归属，只能在管理员已分配的团队之间切换活动团队（复用 `11-05-team-isolation` 的切换接口）。
  - 没有加入任何团队的普通用户（非系统管理员）可以登录，但看不到任何团队、项目、任务、审计或 Agent 数据。
- 密码策略（全局简化）：
  - 最少 6 个字符，最多 1024 字节；只校验长度和类型，不做复杂度、字典、泄露密码或定期轮换校验。
  - 适用于管理员建号、管理员重置密码、用户自己改密（`POST /api/auth/password`）；三处必须共用同一个 `validatePassword()`，避免规则分叉。
  - 已有用户的旧密码哈希继续有效；不强制重置，不因策略从 12 改为 6 而使现有账号失效。
  - 同步更新现有密码策略测试与 `.trellis/spec/` 中的安全说明。
- 账号操作（只保留必要项）：
  - 重置密码：`POST /api/admin/users/:id/reset-password` 改为接收管理员输入的 `password`（>=6），撤销该用户现有会话，记录审计；不再生成临时密码，响应不返回密码。
  - 启用/禁用账号：禁用后现有会话在下次请求失效，Agent 设备凭证同步失效；重新启用后需重新登录/配对。
  - 增加/移除用户团队；移除团队前提示该用户将失去对应数据访问权。
- 管理界面：
  - `web/src/pages/admin/AdminPage.tsx` 用户页签：创建用户（用户名、显示名、密码、团队多选、系统管理员开关）、重置密码（管理员输入新密码）、启用/禁用、增加/移除团队。
  - 列表显示用户名、显示名、状态、所属团队、最近登录时间；按团队过滤。
  - 不做“临时密码只显示一次”、不做强制改密弹窗、不做复杂密码强度提示；现有 `OneTimeCredentialDialog` 在该流程中不再使用。
- 审计：
  - 沿用现有 `user_created`、`user_updated`（启停写入 detail）、`user_password_reset`；新增 `team_member_added`、`team_member_removed`。
  - 不记录密码、token；记录操作者、目标用户、团队、结果与 correlation id。
- CLI：
  - 保留 `init-admin` 用于首个系统管理员；可选 `create-user` 供离线初始化，必须显式指定团队，不打印密码到日志。

## Out of Scope

- 公开注册、邀请码注册、管理员审批注册。
- 用户自助创建团队、自助加入/退出团队、邀请链接；团队和用户团队归属只能由管理员配置。
- 密码复杂度校验（大小写、数字、符号、字典、泄露密码）、密码过期/定期轮换、强制首次改密。
- 邮箱验证、短信验证、SSO/OIDC、LDAP。
- 找回密码 / 邮件重置；首版由管理员直接重置。
- 自助注销账号与数据导出。
- 细粒度自定义角色；团队内只保留团队管理员/普通成员，项目内保留 `lead/member/read_only`。
- 会话管理界面、登录设备列表、审计导出等非必要功能。

## 已确认决策（2026-11-05）

1. **谁可以建号**：只有系统管理员可以创建用户、配置用户团队和重置密码；团队管理员只管理项目，不能建号、不能改团队归属。理由：把身份与租户配置集中到一处，避免团队管理员越权扩张成员。
2. **创建时是否必须选团队**：不必须。团队可留空，账号先建、之后由系统管理员补配；无团队账号登录后看到空状态。理由：允许先开通账号再规划团队，减少建号阻塞。
3. **管理员填密码还是自动生成**：管理员直接填写 >=6 的密码并线下告知用户；不自动生成、不一次性显示、不强制首次改密。理由：流程最简单，减少一次性密码展示与会话状态。

以上三项已冻结，不再作为实现阶段的开放问题；如后续要放开团队管理员建号，需单独提案。

## Acceptance Criteria

- [ ] 未认证请求 `POST /api/auth/register`（或任何等价自助建号路径）返回 404；登录页没有注册入口；该行为有回归测试。
- [ ] 系统管理员可创建用户并配置 0..N 个团队；创建响应不回显密码，数据库中只存 scrypt 哈希与参数。
- [ ] 密码长度为 5 时被拒绝，长度为 6 时通过；`abcdef`、`123456` 等无复杂度密码可以通过，不出现“必须包含大写/数字/符号”的错误。
- [ ] 管理员建号、管理员重置密码、用户自己改密使用同一套密码校验；现有 12 位以上旧密码的账号仍可正常登录。
- [ ] 新账号默认不强制改密；登录后可直接进入看板或空状态，新流程不会返回 `PASSWORD_CHANGE_REQUIRED`；`mustChangePassword` 仅保留字段兼容。
- [ ] 普通用户和团队管理员都不能创建账号、不能修改用户团队归属；团队管理员调用建号/团队分配接口返回 403，前端不显示入口；所有团队归属变更只能由系统管理员发起并留审计。
- [ ] 系统管理员可以在不选任何团队的情况下创建普通账号（非系统管理员）；该账号可登录并看到空状态，之后补配团队即可看到对应数据。
- [ ] 用户可在管理员已分配的团队之间切换；未分配的团队不可见，跨团队用户/项目/任务/审计访问被拒绝。
- [ ] 管理员重置密码接口接受管理员输入的新密码（>=6），不再生成或返回 `temporaryPassword`；旧密码与旧会话立即失效。
- [ ] 禁用账号后现有会话与 Agent 凭证失效；重新启用后需重新登录/配对。
- [ ] 用户名大小写归一后唯一；非法字符、少于 3 位、超过 64 位、预留名被拒绝；用户名可直接用于 `init_developer.py <username>`。
- [ ] 审计记录不包含密码或 token；管理界面沿用现有 React/Vite 构建与本地依赖，不引入远程 CDN/第三方脚本；表单错误可访问，提交中有防重复提交状态。
- [ ] 现有管理员建号、登录、会话撤销测试通过；密码策略测试从 12 位更新为 6 位。

## Notes

- 把密码下限从 12 降到 6 是明确的产品决定，会降低安全性；实现时应在 `.trellis/spec/` 记录该决策与适用范围，避免后续审查误判为缺陷。
- `mustChangePassword` 字段保留是为了兼容现有表和代码，不代表首版产品流程；管理界面默认不展示，创建时写 `false`。
- 本任务不是“注册功能”，而是把现有管理员建号补齐团队配置，并把用户管理保持在最小可用集合。
- 密码明文属于敏感值，不能进入日志、审计正文、URL query、浏览器 `localStorage` 或崩溃转储。
- 用户名全局唯一，避免多团队登录歧义；团队内显示名可以不同。
