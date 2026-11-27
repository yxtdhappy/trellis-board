# Implementation Report

## Files Changed

- `packages/web/src/features/admin/ProjectsTab.tsx`
- `packages/web/src/api/admin/members.ts`

## Decisions

- 复用 `AdminConsole.users`、`AdminConsole.reloadUsers()` 和现有 `SelectField`，未新增接口、账号查询逻辑或选择器组件。
- 管理员选择器只把 `status === 'active'` 的账号列为普通候选，选项文案为“显示名 · 登录名”，提交值仍为账号内部 `id`。
- 编辑中的成员若不是 active 账号或不在当前账号目录结果中，则临时补入选项并标注账号非 active 状态，避免当前值无法回显或被静默移除。
- 项目负责人继续使用手工 `用户 ID` 输入，并明确提示必须填写账号内部 UUID，不是登录名。
- 管理员账号目录为空或请求失败时显示手工内部 UUID 输入作为兼容路径；请求失败原因继续由现有 `reloadUsers()` 的 toast 错误提示呈现。账号加载过程不会重置角色或 developer ID。
- 保存接口、请求结构和 developer ID 校验保持不变；保存按钮在没有选择用户时禁用，保存成功后沿用原有逻辑刷新成员并清空新增表单。
- 浏览器 E2E 确认成员保存接口实际返回 `{ member }`，与 `readProjectMembers()` 只读取成员集合的结构不一致。`saveMember()` 现在保留原 PUT 请求，成功后复用 `fetchMembers(projectId)` 获取权威成员列表，唯一调用方 `useAdminProjects.saveMember()` 无需修改。

## Verification

- IDEA MCP `get_file_problems`：目标文件 0 个错误。
- `yarn oxfmt --check packages/web/src/features/admin/ProjectsTab.tsx`：通过。
- `yarn oxfmt --check packages/web/src/api/admin/members.ts`：通过。
- `yarn workspace @trellis-board/web exec oxlint src/features/admin/ProjectsTab.tsx`：退出码 0；仅保留原有插件绑定 effect 的 2 条 `set-state-in-effect` 警告，本次未新增该警告。
- `yarn workspace @trellis-board/web exec oxlint src/api/admin/members.ts`：退出码 0。
- `yarn workspace @trellis-board/web exec tsc -b --pretty false`：通过，退出码 0。
- `git diff --check`：通过。
- 隔离 Team 服务 + Vite + Chrome DevTools MCP 浏览器 E2E：通过。
- `zsw` 选择的真实 PUT 请求体为内部 UUID，保存后 GET 返回 3 名成员，页面成员数和 `zsw` 行保持；停用成员编辑回显、项目负责人手工 UUID 路径、浅色/深色主题均已验证。

## Not Verified / Risks

- 登录态浏览器 E2E 已覆盖管理员选择、保存后刷新、停用成员编辑回显和项目负责人兼容路径；详细证据见 `e2e-report.md`。
- 未做 Base UI `Select` 的完整键盘交互矩阵；组件沿用现有 `SelectField`，本轮验证了展开、选择、回显和保存。
- `/api/admin/users` 的 5xx toast 未做故障注入；非管理员无目录权限路径已实际验证，源码确认失败后会回到手工 UUID 路径。
- 写入式 `oxfmt` 曾触发本机 Esafenet DLP 对 `members.ts` 的透明加密；已用 Git 精确恢复该文件并重新应用最小 patch，最终文件为可编译明文，`tsc` 已再次通过。
