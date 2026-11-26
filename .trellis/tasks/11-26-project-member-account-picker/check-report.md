---
mode: independent
agent: trellis-check
session: 01a21728-4707-71b2-9ad6-4e92f5e6f0f2
commit: ""
base: fbc609b1c544e59de626176ea59a08ce2d10866b
scope: packages/web/src/api/admin/members.ts,packages/web/src/features/admin/ProjectsTab.tsx,.trellis/spec/frontend/rendering-and-state.md
diff: sha256:4ed99c6a9793ea15055534e07d1dc765889155766f24225045796e9209ff4d54
---
# Check Report: 项目成员账号选择器

## 结论

最终 full-scope 检查通过。管理员使用现有账号目录与 `SelectField` 选择 active 账号，选项展示显示名和登录名，提交值仍是账号内部 UUID；非管理员继续使用手工内部 UUID 输入；后端接口、权限边界和 developer ID 校验均未改动。

真实浏览器 E2E 发现并闭环了 PUT 响应解析问题：服务端 PUT 返回 `{member}`，原实现错误地按成员列表解析并得到空列表；`saveMember()` 现在只在 PUT 成功后复用 `fetchMembers()`，以 GET 的权威成员列表更新页面。E2E 已证明修复前失败、修复后通过。

## Scope Notes

- 本任务代码改动只有 `packages/web/src/api/admin/members.ts` 和 `packages/web/src/features/admin/ProjectsTab.tsx`。
- 工作树中同时存在其他任务目录、desktop onboarding、server lifecycle/spec 等并发改动；这些内容未纳入本任务结论，未修改或删除。

## Findings (fixed)

- File: `packages/web/src/features/admin/ProjectsTab.tsx`
- Issue: 账号目录曾经加载成功后，切页重载失败时仍可能使用共享 `users` 缓存，管理员无法退回到要求的手工 UUID 路径。
- Fix: 使用本次 `reloadUsers()` 的结果作为选择器候选，并用 `adminTeamId` 标记结果归属；失败或空目录时保留原有输入值并显示手工 UUID 输入。

- File: `packages/web/src/features/admin/ProjectsTab.tsx`
- Issue: 手工输入了不在目录或现成员中的值时，后续目录加载成功会切换到 `SelectField`，但隐藏的旧值仍可提交，可能再次产生 `用户不存在 (NOT_FOUND)`。
- Fix: 当 `userId` 无法匹配当前候选或现有成员时继续保留手工输入，避免选择器显示占位符却提交不可见的旧值。

- File: `packages/web/src/features/admin/ProjectsTab.tsx`
- Issue: 仅含空白的手工输入仍可触发保存。
- Fix: 保存按钮改用 `!userId.trim()` 判断，提交逻辑仍会对 `userId` 做 `trim()`。

- File: `packages/web/src/features/admin/ProjectsTab.tsx`
- Issue: 失败提示文案要求用户“按错误提示重试”，但成员表单没有单独重试按钮。
- Fix: 文案改为明确目录错误会单独提示，同时允许直接填写账号内部 UUID。

- File: `packages/web/src/api/admin/members.ts`
- Issue: 服务端 `PUT /api/projects/:projectId/members` 返回 `{member}`，原代码却把 PUT 响应当作 `{members}` 列表解析，导致保存虽成功但页面成员列表被替换成空数组；首轮真实 E2E 已复现。
- Fix: `saveMember()` 仅在 PUT 成功后调用现有 `fetchMembers(projectId)`，返回权威 GET 成员列表；函数签名仍是 `Promise<ProjectMember[]>`，未新增接口或修改请求形状。

## Cross-Layer Review

- 唯一调用链：`ProjectsTab → AdminConsole.saveMember → useAdminProjects.saveMember → api.saveMember`；唯一直接调用点是 `useAdminProjects.ts`，它继续用返回值 `setMembers()`，调用方无需改类型或状态契约。
- 服务端契约：`packages/server/team/http/routes/projects.js` 的 GET 返回 `{ members }`，PUT 返回 `{ member }`；本次只修正前端读取方式，没有修改后端路由、请求体、权限或 developer ID 校验。
- 错误语义：若 PUT 失败，保持原有错误上报；若 PUT 成功但随后 GET 刷新失败，`saveMember()` 会 reject，现有 hook 显示错误并返回 `false`，表单不会清空。不会把无法获得权威列表的刷新误报为成功，重试仍是同一成员 ID 的幂等 upsert。
- 加载/状态：`useAdminProjects` 只在 PUT 和后续 GET 都完成后一次性 `setMembers()`，不会先写入空列表；本次没有新增第二份成员状态或共享 loading 契约。

## Acceptance Check

- AC1 通过：E2E 在真实管理页看到“用户账号”选择器，选项包含 `显示名 · 登录名`；停用账号未进入新成员候选，浅色和深色主题均检查通过。
- AC2 通过：E2E 选择 `zsw` 后，`PUT /api/projects/22222222-2222-4222-8222-222222222222/members` 的真实请求体为 `{"userId":"58717f60-6995-4c79-b4e1-ca1c352e42df","role":"member","trellisDevId":"zsw"}`，返回 `200`；随后 GET 返回 3 名成员并包含 `zsw`。修复前首轮 E2E 复现“PUT 成功但页面成员变 0”，修复后复测通过。
- AC3 通过：E2E 编辑停用账号时选择器回显 `停用账号 · disabled-user`，只读角色和 developer ID 输入正确，当前成员未被移除。
- AC4 通过：E2E 以非管理员项目负责人验证到手工“用户 ID”输入和“内部 UUID，不是登录名”文案，页面没有请求 `/api/admin/users`。
- AC5 部分验证：源码路径确认失败或空目录时保留角色、developer ID 和当前输入并切换为手工 UUID；管理员目录 5xx toast 未做故障注入，见未覆盖项。
- AC6 developer ID 规则：E2E 验证可写成员提交 developer ID、只读成员不要求；服务端校验代码未改动，全量服务端测试通过。
- 保存后刷新：E2E 证明 PUT 后 GET 得到 3 名成员、`zsw` 行保留、成员计数保持且新增表单清空。

## Findings (not fixed)

- `/api/admin/users` 的 5xx 故障 toast 未做浏览器故障注入。E2E 已覆盖非管理员无权目录路径，源码也确认请求失败后会退回手工 UUID，但“错误原因 toast 实际可见”仍依赖现有 `reloadUsers()` 错误路径，建议后续补一个失败注入回归。
- `implementation-report.md` 仍只列 `ProjectsTab.tsx`，并写着未执行浏览器 E2E，已落后于最终的 `members.ts` 修复和 `e2e-report.md`。该文件不属于本次“只更新 check-report”的授权范围，建议主会话提交前同步更新。
- 保存按钮仍没有独立的 in-flight 禁用状态，这是原交互既有行为。PUT 为成员 upsert，重复点击不会创建重复成员，但会重复发起 PUT/GET；本次未见验收要求，未扩大改动。
- E2E 控制台仍有一条仓库既有 Base UI `nativeButton` 可访问性错误，定位在 `AdminPage` 顶部头像触发器，不属于本次改动区域。

## Test Coverage

- 未新增 React 组件单元测试；仓库未使用 React 渲染测试框架。该修复由真实浏览器 E2E 覆盖 PUT 请求体、PUT 成功、GET 权威刷新和页面成员列表结果，符合前端规范的行为验收边界。
- 未修改后端接口，API E2E 不适用；真实浏览器 E2E 已实际穿过本机 Team API，并用网络请求体和响应复核结果。

## Verification

- Lint: pass（`yarn workspace @trellis-board/web lint` 退出码 0；仅仓库既有 warnings，本次未新增 `ProjectsTab.tsx` warning）
- TypeCheck: pass（`yarn workspace @trellis-board/web exec tsc -b --pretty false`）
- Format: pass（`yarn oxfmt --check packages/web/src/api/admin/members.ts packages/web/src/features/admin/ProjectsTab.tsx`）
- Whitespace: pass（`git diff --check`）
- Tests: pass（全量 `yarn test`：793 pass / 0 fail / 2 skip，用时 157936 ms）
- Browser E2E: pass（隔离 Team 服务、真实 Chrome DevTools MCP、真实 PUT/GET 网络证据；源码 HEAD `3ca8c7b11e4d9e8fc8dddf62b91b1e79e925c743`）
- API E2E: not applicable（本次没有后端/API 改动）
- Spec sync: updated `.trellis/spec/frontend/rendering-and-state.md`，记录成员 PUT/GET 响应差异和浏览器验收断言