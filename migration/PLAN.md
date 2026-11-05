# 迁移计划：纵向切片 + Playwright Parity

## 1. 目标

把 `public/` 下的原生前端迁移为 `frontend/` 下的 Vue 3 + Vite + TypeScript SPA，同时满足：

- 现有 standalone / team 模式行为不回归。
- 旧应用在迁移期间保持可运行，可随时回退。
- 每个纵向切片独立交付、独立评审、独立 E2E。
- 新功能（SSE、多团队、用户管理等）与旧行为迁移解耦。

**非目标：**

- 不重写后端、SQLite、Git 操作和 Trellis 业务逻辑。
- 不重做视觉设计；先沿用现有 CSS 和设计语言。
- 不一次性替换 `public/`。
- 不为了“纯 Vue”重写 `team-client.js`、`execution-filter.js`、`markdown.js` 等纯逻辑。

## 2. 迁移原则

1. **行为是 spec，DOM 不是。** 旧应用只约束用户可见行为、API 调用语义和权限结果，不约束组件结构、类名和像素。
2. **一次一个切片。** 每个切片有独立的旧入口、新入口、验收场景和回退开关。
3. **先裁判，后翻译。** 没有 Playwright parity harness，不开始任何切片。
4. **旧应用只修关键 bug。** 迁移期间冻结旧 board 的新功能，避免双轨实现。
5. **新功能单独验收。** SSE、多团队切换、新用户管理不是旧版已有行为，不能拿旧版 parity 当唯一标准。
6. **共享纯逻辑不搬家。** 先通过 `shared/` 或原路径复用；需要移动时，服务端 import 一起改。

## 3. 目标结构

```text
frontend/
  index.html
  vite.config.ts
  tsconfig.json
  package.json                 # 仅前端构建依赖；服务端运行时不依赖它
  src/
    main.ts
    App.vue
    router/
      index.ts
    api/
      client.ts                # requestJson / ApiError / ETag / 幂等键 / 401
      auth.ts
      board.ts
      tasks.ts
      team.ts
      admin.ts
      plugins.ts
      events.ts                # SSE
    stores/
      session.ts               # runtime、user、memberships、mustChangePassword
      team.ts                  # activeTeamId、切换协议、权限
      board.ts                 # projects、tasks、filters、cursor、ETag
      ui.ts                    # dialog、toast、loading
    features/
      auth/
      board/
      team/
      archive/
      plugins/
      admin/
    components/
      layout/
      task/
      filters/
      ui/
    shared/                    # 可复用纯逻辑；初期直接 re-export public/*.js
  tests/
    unit/                      # Vitest + Vue Test Utils
    e2e/                       # Playwright parity + new behavior
```

构建产物：

```text
frontend/dist/
```

服务端托管策略：

- 迁移期：`/next` → `frontend/dist`；`/` 仍指向 `public/`。
- 对等后：`/` → `frontend/dist`；`/legacy` → `public/` 保留一个发布周期。
- 删除旧版前，必须完成 `06-post-parity`。

路由：

| 路径 | 页面 | 备注 |
|---|---|---|
| `/login` | 登录 | 未认证重定向目标 |
| `/` | Pipeline | 默认看板 |
| `/team` | 团队视角 | 团队模式 |
| `/archive` | 归档索引 | 只读 |
| `/plugins` | 插件 | 含日志 dialog |
| `/admin` | 管理后台 | 用户/项目/Agent/审计 |

## 4. 状态与数据流

### 4.1 状态归属

| 状态 | 归属 | 说明 |
|---|---|---|
| runtime、user、memberships | `stores/session.ts` | 只由 `/api/runtime`、`/api/auth/me` 更新 |
| `activeTeamId`、团队权限 | `stores/team.ts` | 切换时触发全局重置 |
| projects、tasks、filters、cursor、ETag | `stores/board.ts` | 服务端数据 + 查询状态 |
| dialog、toast、局部 loading | `stores/ui.ts` 或组件本地 | 不进入全局业务 store |
| 表单草稿 | 组件本地 | 不跨页面复用 |

### 4.2 团队切换协议

任何团队切换必须按顺序执行：

1. 关闭当前 SSE 连接。
2. 取消进行中的请求（AbortController）。
3. 清空 board/team 查询缓存和分页游标。
4. 更新 `activeTeamId`。
5. 重新拉取 `/api/runtime` 或团队上下文。
6. 重新建立 SSE（如果已启用）。
7. 重新加载当前页面数据。

禁止只改 `activeTeamId` 然后让各组件自行刷新；这会产生跨团队脏数据。

### 4.3 API 契约

`api/client.ts` 必须保留 `public/team-request.js` 的语义：

- `credentials: "same-origin"`
- `cache: "no-store"`
- 写请求自动 `content-type: application/json`
- `ApiError` 保留 `status`、`code`、`details`、`recoverable`、`payload`
- 401 → 跳转登录并带 `returnTo`
- 支持 ETag、幂等键、操作轮询
- 不把 token 写入 `localStorage` / `sessionStorage`

## 5. 纵向切片

`manifest.tsv` 是唯一队列。每个切片必须满足“完成定义”，才允许下一片开始。

### S0 foundation-shell

- 范围：Vite/Vue/TS 脚手架、路由、Pinia、API client、app shell、`/next` 托管。
- 旧入口：无。
- 新入口：`/next`。
- 验收：
  - `npm run build`、`vue-tsc --noEmit` 通过。
  - `/next` 能加载，未登录跳 `/login`。
  - 旧 `/` 完全不受影响。
- 备注：不迁移任何业务页面。

### S1 auth-login

- 范围：登录页、登出、runtime 检测、会话过期、改密 dialog。
- 旧入口：`public/login.html`、`public/login.js`、`public/app.js` 的 auth 部分。
- 新入口：`/login`、`/next`。
- Parity：
  - 正确/错误密码。
  - 未登录访问 `/next` 跳转。
  - 登录后返回 `returnTo`。
  - 登出后回到登录页。
  - 改密成功/失败、旧会话失效。
- 新行为：密码策略按最新 PRD（最少 6 位）验收，标 `NEW-BEHAVIOR`；不要复制旧 UI 的 12 位提示。

### S2 admin-users

- 范围：用户列表、创建、编辑、启停、重置密码、团队分配。
- 旧入口：`public/admin.html`、`public/admin.js` 用户页签。
- 新入口：`/admin` 用户页签。
- 依赖：`11-05-user-registration` 的 API 契约。
- Parity：现有建号/启停/重置/团队操作。
- 新行为：新用户管理 PRD 的字段和权限；单独验收。

### S3 admin-rest

- 范围：项目管理、Agent、审计、secret/approval dialog。
- 旧入口：`admin.html` 其余页签。
- 新入口：`/admin` 其余页签。
- Parity：项目接入/成员、Agent 配对/批准、审计过滤、敏感 dialog。

### S4 board-read

- 范围：侧栏、项目列表、pipeline、搜索/筛选、任务卡、归档只读、插件页只读。
- 旧入口：`public/index.html`、`app.js` 的 pipeline/archive/plugins 渲染。
- 新入口：`/`、`/archive`、`/plugins`。
- Parity：
  - 项目切换、scope、执行视图、搜索、筛选。
  - 任务卡字段、阶段胶带、注意力队列、归档排序。
  - 空状态、错误状态、加载状态。
- 备注：先只读；写操作留给 S6。

### S5 task-detail

- 范围：任务详情 dialog、产物预览、执行元数据、复制任务名、依赖展示。
- 旧入口：`app.js` 的 task-dialog / artifact-dialog。
- 新入口：同页面 dialog。
- Parity：打开/关闭、产物切换、长文档截断、复制反馈、键盘/焦点。

### S6 board-write

- 范围：创建任务、派发、阶段、依赖、执行计划、保存视图、WIP 设置。
- 旧入口：`app.js` 的写操作与 dialog。
- 新入口：同页面。
- Parity：
  - 创建成功/失败、slug 校验、幂等键。
  - 派发成功/失败、成员校验、版本冲突。
  - 阶段/依赖/保存视图/ WIP。
  - Git operation pending/push/retry 状态。
- 备注：每个写操作必须复用现有 API 语义，不新增“前端专用”捷径。

### S7 team-view

- 范围：团队看板、待接受、分页、权限、团队状态、操作轮询。
- 旧入口：`app.js` 的 team 视图。
- 新入口：`/team`。
- Parity：
  - 团队任务查询、项目筛选、负责人筛选。
  - 待接受/接受、权限拒绝、分页前进/后退。
  - Git 操作状态展示与重试。
- 备注：依赖 `11-05-team-isolation` 的 API。

### S8 team-switch-sse

- 范围：多团队切换、SSE 事件流、`Last-Event-ID`、重连、去重、轮询降级。
- 旧入口：无（新功能）。
- 新入口：全局团队切换器 + `/api/agent/events`。
- 验收：按 `11-05-client-server-push` / `11-05-team-isolation` PRD。
- 必须测试：
  - 切换团队后旧团队数据不可见。
  - SSE 断线重连补发。
  - 重复事件幂等。
  - 游标过期触发 `resync.required`。
  - SSE 不可用时降级轮询。
- 备注：不要求旧版 parity；标 `NEW-BEHAVIOR`。

### S9 cutover

- 范围：根路径切换、`/legacy` 保留、旧前端删除、Tauri 加载验证。
- 验收：
  - 全量 Playwright parity 绿。
  - standalone / team 两种模式 smoke。
  - Tauri 远程页面和本地构建产物至少一种加载方式验证。
  - 旧 `/legacy` 可回退一个发布周期。
  - 删除旧前端前，`06-post-parity` 完成。

## 6. 每个切片的执行协议

每个切片按以下顺序，不允许并行改写同一片：

1. **确认范围**：从 `manifest.tsv` 取一行，更新状态为 `in_progress`。
2. **实现**：一个 implementer；只改该切片范围。
3. **双评审**：两个独立 reviewer，只读，假设实现是错的；每条 finding 必须引用 `DESIGN.md` 规则或源码行。
4. **修复**：fixer 只应用已确认 finding；无法修复则标 `TODO(vue)` 并记录。
5. **验证**：
   - `vue-tsc --noEmit`
   - `vite build`
   - 该切片的 Vitest
   - 该切片的 Playwright parity
6. **Gate**：人工确认后，状态改为 `done`，才进入下一片。

## 7. 完成定义（DoD）

一个切片只有同时满足以下条件才算完成：

- [ ] 新入口在 `/next` 或对应路由可用。
- [ ] 旧入口仍可用，且未被该切片破坏。
- [ ] `vue-tsc --noEmit` 通过。
- [ ] `vite build` 通过。
- [ ] 该切片的 Playwright parity 全绿。
- [ ] 新行为有独立测试，并有 `NEW-BEHAVIOR` 说明。
- [ ] 没有新增 `localStorage` / `sessionStorage` 凭证。
- [ ] 没有外部 CDN 资源。
- [ ] 没有未登记的 `TODO(vue)` / `PARITY-GAP`。
- [ ] 人工 gate 签字。

## 8. 发布与回退

### 迁移期

- 服务端增加 `/next` 静态托管；`/` 保持旧版。
- 新应用所有 API 仍走同源 `/api`。
- 通过环境变量或运行时开关控制默认入口，例如 `TRELLIS_FRONTEND=legacy|vue`。
- 出问题时把入口切回 `/`，不需要回滚数据库。

### 对等后

- `/` 指向新应用；`/legacy` 指向旧应用。
- 保留至少一个发布周期。
- 确认无回归后删除 `public/` 旧入口和旧测试。
- Tauri 构建要么加载服务端 URL，要么加载 `frontend/dist`；二者只能选一种作为主路径，避免双份行为。

## 9. 风险与应对

| 风险 | 应对 |
|---|---|
| 业务语义回归 | 复用纯逻辑；Playwright 行为对照；每片人工 gate |
| 双轨维护 | 冻结旧 board 新功能；新功能只进 Vue |
| 测试脆弱 | 先建 judge；移除源码字符串断言，改为组件/E2E |
| 团队切换脏数据 | 统一 `team.switch()` 协议；禁止组件自行刷新 |
| SSE 与轮询冲突 | 单一事件层；SSE 失败降级轮询；幂等去重 |
| CSS 失控 | 沿用现有 CSS；新组件 scoped；不并行重做视觉 |
| Tauri 安全边界 | 本地打包资源；严格 capabilities/CSP；不加载任意远程页 |
| 后端契约漂移 | 迁移前冻结 API；新增字段先改 PRD/API |

## 10. 明确不做

- 不迁移后端、数据库、Git 操作。
- 不重写 Trellis 领域逻辑。
- 不在迁移期间做视觉改版。
- 不引入 SSR/Nuxt/Next。
- 不引入重型 UI 组件库。
- 不把旧测试源码字符串断言直接搬进新项目。
- 不用一个大 PR 完成全部迁移。
