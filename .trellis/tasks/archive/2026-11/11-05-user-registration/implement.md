# 实现计划：服务端用户管理（仅管理员建号）

## 顺序

1. `server/team/auth.js`
   - `validatePassword()` 改为最少 6 个 code point、最多 1024 字节。
   - `createUser()` 增加 `teams`，先校验、插入账号后调用 `setUserTeams()`；`mustChangePassword` 默认 false。
   - `resetUserPassword()` 接收 `password`，哈希后写 `must_change_password = 0`、撤销会话、写 `user_password_reset`。
   - `updateUserAdmin()` 只在账号字段实际变化时写 `user_updated`。
2. `server/team/http.js`
   - 抽取团队分配解析：接受 `teamIds`（字符串数组）和兼容的 `teams`（字符串或 `{teamId,role}`），保留已有角色。
   - `POST /api/admin/users` 强制密码、返回用户含 teams、移除临时密码分支。
   - `PATCH /api/admin/users/:id` 支持 teamIds/teams。
   - 重置密码接口读取 `{ password }` 并返回 `{ user }`。
   - 删除不再使用的 `randomPassword()`。
3. 前端
   - `web/src/api/admin.ts`：更新输入/响应契约，移除 `temporaryPassword`。
   - `web/src/hooks/useAdminConsole.ts`：创建不回显凭证，重置接收密码。
   - `web/src/features/admin/UsersTab.tsx`：密码字段、团队多选、团队展示、重置密码对话框。
   - `web/src/features/admin/AccountDialog.tsx`：账号表单增加团队多选。
4. 测试
   - `tests/team-registration.test.js`：密码 5/6、`abcdef`、无注册路由、仅系统管理员建号、响应无临时密码、团队创建/校验、跨团队列表隔离、重置撤销会话、旧哈希登录、审计。
   - 更新现有测试对 `createUser` / 重置契约的断言。
5. 文档
   - 更新本任务 `design.md` / `implement.md`。
   - 在 `.trellis/spec/backend/` 记录 6 位密码策略决策。

## 验证命令

```bash
python3 .trellis/scripts/task.py validate .trellis/tasks/11-05-user-registration
node --test tests/team-registration.test.js tests/team-core.test.js tests/team-isolation.test.js tests/team-release.test.js
npm test
npm run build
git diff --check
```

## 回滚点

- 后端 auth/http 改完后先跑 `node --test tests/team-*.test.js`。
- 前端契约改动后跑 `npm run build`；失败时先回滚前端，不影响已通过的后端测试。
- 提交前确认 `public/`、`web/node_modules` 未被加入暂存区。
