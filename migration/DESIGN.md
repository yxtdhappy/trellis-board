# 前端迁移设计约束（替代 RULEBOOK）

> 本文件是本次 redesign 的 `DESIGN.md`，不是语言翻译规则表。所有实现者、评审者、fixer 在改代码前必须读本文件。  
> 本文件在切片循环内**只读**；修订由人工在 gate 上完成，并记录到 §12 的 Deviation log。

## 0. 姿态

- 这是 **redesign migration**：从原生 DOM/全局状态迁移到 Vue 组件/响应式状态。
- 旧应用是**现有行为**的 executable spec，不是 DOM 结构规范。
- 新应用可以先不追求视觉像素级一致，但必须保持：
  - 同样的用户流程
  - 同样的权限结果
  - 同样的 API 语义
  - 同样的错误可理解性
- 不在迁移切片里顺手改业务规则。发现旧行为本身有缺陷时：
  - 如果必须保持：标 `BUG(legacy):` 并写 repro；
  - 如果产品决定修复：单独标 `NEW-BEHAVIOR:`，走新 PRD/验收，不塞进 parity。

## 1. 技术栈与禁令

| 项目 | 决定 |
|---|---|
| 框架 | Vue 3，Composition API + `<script setup>` |
| 构建 | Vite |
| 语言 | TypeScript；新代码 strict；旧纯逻辑可先用 JS + JSDoc |
| 路由 | Vue Router，history 模式；Tauri 本地产物可使用 hash 回退 |
| 全局状态 | Pinia；只放会话、团队上下文、UI 级状态 |
| 服务端数据 | 先自建 `api/` + composable；复杂后再评估 `@tanstack/vue-query` |
| UI 库 | 不引入重型组件库；弹窗优先原生 `<dialog>` 或轻量 headless 组件 |
| CSS | 沿用 `public/styles.css` / `public/team.css`；新组件用 scoped style |
| SSR | 禁止 Nuxt/Next/SSR |
| 外部资源 | 禁止 CDN、外部字体、外链脚本；全部本地打包 |
| 凭证存储 | 禁止 `localStorage` / `sessionStorage` 存 token；Cookie 由服务端管理 |
| 测试 | Vitest + Vue Test Utils；Playwright 做 parity/E2E；纯逻辑保留 `node:test` |

## 2. 目录与所有权

```text
frontend/src/
  api/          # 只做 HTTP/SSE 与响应归一化，不放 UI 状态
  stores/       # 跨页面状态；页面内状态留在组件
  features/     # 按业务域组织页面与组件
  components/   # 跨 feature 复用组件
  shared/       # 纯函数；可 re-export public/*.js
  router/       # 路由与守卫
```

规则：

- 一个 feature 不能直接 import 另一个 feature 的内部组件；跨域复用放 `components/` 或 `shared/`。
- `api/` 不 import store；store 调 `api/`；组件调 store 或 api。
- 页面组件可以编排多个 feature 组件，但不承载业务规则。
- 纯逻辑优先放 `shared/`；不要为了 Vue 把 `team-client.js` 重写一遍。

## 3. 路由与守卫

| 路由 | 组件 | 守卫 |
|---|---|---|
| `/login` | `features/auth/LoginPage.vue` | 已登录可跳回 `returnTo` |
| `/` | `features/board/BoardPage.vue` | 需要 session |
| `/team` | `features/team/TeamPage.vue` | 需要 session + team 模式 |
| `/archive` | `features/archive/ArchivePage.vue` | 需要 session |
| `/plugins` | `features/plugins/PluginsPage.vue` | 需要 session |
| `/admin` | `features/admin/AdminPage.vue` | 需要 `systemAdmin` 或团队管理员 |

守卫规则：

- 启动时只请求一次 `/api/runtime`，结果进 `session` store。
- `runtime.team === false`：standalone 模式，不需要登录。
- `runtime.team === true && !authenticated`：跳 `/login?returnTo=...`。
- `mustChangePassword` 按最新用户 PRD 处理；默认不强制改密。
- 403 不跳登录，显示权限错误；401 才跳登录。
- 路由切换不重复拉取未变化的 runtime；团队切换除外。

## 4. 状态规则

### 4.1 session store

```ts
interface SessionState {
  runtime: Runtime | null;
  user: User | null;
  memberships: TeamMembership[];
  activeTeamId: string | null;
  initialized: boolean;
}
```

- 只由 `initializeSession()`、`login()`、`logout()`、`refreshMe()` 修改。
- `user` 和 `memberships` 不散落在组件里。
- `mustChangePassword` 不再作为默认流程；保留字段仅兼容。

### 4.2 team store

- `activeTeamId` 是唯一团队上下文来源。
- `switchTeam(teamId)` 必须执行 `PLAN.md` §4.2 的 7 步协议。
- 组件不能直接写 `activeTeamId`。
- 团队权限判断统一走 `canManageProject` / `canWriteProject` 等共享函数，不在模板里手写角色字符串。

### 4.3 board store

- 保存 projects、tasks、filters、cursor、ETag、loading、error。
- 查询键至少包含：`teamId`、`projectId`、`scope`、`executionView`、`search`、`filters`、`cursor`。
- 团队切换、项目切换、筛选变化必须使旧请求失效。
- 请求返回后检查 `teamId` 是否仍是当前团队；不是则丢弃。

### 4.4 UI 状态

- dialog 开关、toast、局部 loading 放组件本地或 `ui` store。
- 不把表单草稿放进全局 store。
- 乐观更新只用于明确可回滚的操作；Git 操作状态以服务端为准。

## 5. API 契约

`api/client.ts` 必须等价于现有 `public/team-request.js`：

- `requestJson(url, { method, body, headers })`
- 写请求自动 `content-type: application/json`
- `credentials: "same-origin"`、`cache: "no-store"`
- 非 2xx 抛 `ApiError`，保留 `status/code/details/recoverable/payload`
- 401 统一跳登录，带 `returnTo`
- 204/304 返回 `null`
- 非 JSON 错误截断为文本，避免把 HTML 错误页塞进 UI

额外要求：

- 类型定义从实际响应结构提炼；不要用 `any` 绕过。
- ETag 由调用方传入/返回，不在 client 里偷偷缓存。
- 幂等键由写操作生成并随请求发送；失败重试复用同一个键。
- 操作轮询（`/api/git-operations/:id`）集中在一个 composable/store，不散落在页面。

## 6. 团队上下文

- 所有团队数据请求必须带当前团队上下文（由服务端 session 或显式参数决定；以现有 API 为准）。
- 切换团队后：
  - 旧团队的任务、项目、成员、审计、Agent 数据不得残留。
  - 旧 SSE 连接必须关闭。
  - 旧分页游标必须清空。
- 页面组件不缓存跨团队数据；缓存键必须包含 `teamId`。
- 管理员跨团队操作必须明确显示当前团队，避免“看起来在 A 团队，实际写 B 团队”。

## 7. SSE

- 单连接 `GET /api/agent/events`，Bearer 或 Cookie 鉴权按服务端实现。
- 连接生命周期由 `api/events.ts` + `stores/team.ts` 管理，不放在页面组件。
- 必须支持：
  - `Last-Event-ID`
  - 自动重连（指数退避 + 上限）
  - 事件去重（event id）
  - `resync.required` 触发全量刷新
  - SSE 不可用时降级到现有轮询
- 团队切换时关闭旧连接，使用新团队上下文重连。
- 事件处理只更新对应 store；不要在每个页面重复注册监听。

## 8. 组件规则

- 页面组件只做编排：取数据、组合子组件、处理路由。
- 展示组件通过 props/emits 通信；不直接 `querySelector` 页面其他区域。
- 禁止在组件里拼大段 `innerHTML`；Markdown 预览走现有 `markdown.js` 的安全渲染路径。
- 弹窗统一用 `components/ui/AppDialog.vue` 包装原生 `<dialog>`，保留焦点管理和 Esc 行为。
- 表单错误用可访问的 `role="alert"` / `aria-live`；提交中禁用按钮防重复提交。
- 列表 key 使用稳定业务 ID，不用数组下标。
- 不复制旧代码的全局事件监听；用组件生命周期注册/清理。

## 9. CSS 规则

- 先复用现有 class 和 CSS 变量；不要并行重做视觉。
- 新组件样式用 `<style scoped>`；全局样式只放在 `styles/` 入口。
- 禁止 `!important` 除非有注释说明覆盖来源。
- 保持现有响应式断点和暗色/亮色约束（如已有）。
- 不引入 Tailwind/UnoCSS 等新体系，避免迁移期双栈样式。

## 10. 测试规则

- `tests/team-web.test.js` 中的纯函数测试可以保留/迁移到 Vitest。
- 源码字符串断言（读取 `public/app.js` 并 `assert.match`）必须在旧前端删除时一起移除，不能作为新前端测试。
- 每个切片至少包含：
  - 1 个组件/组合式函数单元测试
  - 1 条 Playwright 用户流程
- parity 测试只断言用户可见行为和 API 语义；DOM 结构变化不算失败。
- 视觉截图可作为辅助，不作为 gate。
- 新功能（SSE/多团队）另有验收测试，不混入旧版 parity 计数。

## 11. 标记与命名

统一使用可 grep 的标记：

| 标记 | 用途 |
|---|---|
| `TODO(vue):` | 迁移中暂未实现、但已确定要做的点 |
| `PARITY-GAP:` | 新旧行为差异，需人工裁决 |
| `NEW-BEHAVIOR:` | 旧版没有、按新 PRD 实现的行为 |
| `BUG(legacy):` | 旧版已有缺陷，迁移时故意保留 |
| `PERF(vue):` | 已知性能折衷，后续优化 |

命名：

- Vue 组件 PascalCase：`TaskCard.vue`
- composable `useXxx.ts`
- store `useXxxStore.ts`
- API 文件按域：`tasks.ts`、`team.ts`、`admin.ts`
- 测试：`*.spec.ts`（Vitest）、`*.e2e.ts`（Playwright）
- 共享纯逻辑保留原名/原导出，避免服务端 import 断裂。

## 12. Deviation log

任何偏离本文件或 `PLAN.md` 的决定，必须在 gate 上记录：

| ID | 日期 | 偏离 | 批准人 |
|---|---|---|---|
| DEV-001 | 2026-11-05 | 初始迁移计划建立；未开始实现 | Fel1xKan |
