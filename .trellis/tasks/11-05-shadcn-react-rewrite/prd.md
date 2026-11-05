# shadcn 重构看板前端

## Goal

用 React + Vite + TypeScript + Tailwind + shadcn/ui 重写 `public/` 下的三个页面（看板 / 管理台 / 登录），视觉对齐 `design/trellis-board-redesign.pen`（16 个画板，浅色 + 深色），功能与现有实现逐条对等，服务端 API 与业务逻辑保持不变。

## Background

- 现状：`public/index.html`、`public/admin.html`、`public/login.html` + 原生 ES Module（`app.js` 3957 行 / `admin.js` 952 行）+ `styles.css` 76KB + `team.css` 23KB，无构建步骤，由 `server/index.js` 直接静态托管。
- 设计已就绪：`design/trellis-board-redesign.pen` 含 1 个 shadcn 组件库帧（88 个 reusable 组件）+ 16 页浅色 + 16 页深色。
- shadcn 主题 preset：`b3awTjpuKm`（`style=mira`、`baseColor=neutral`、`theme=violet`、`chartColor=indigo`、`iconLibrary=lucide`、`font=inter`、`fontHeading=geist`、`radius=default`、`menuAccent=subtle`）。
- 当前基线：`node --test tests/*.test.js` = 150 passed。

## Scope

### In scope

- 新建 Vite + React + TypeScript + Tailwind v4 + shadcn/ui 前端工程，构建产物由现有 Node 服务静态托管。
- 三个页面入口 `/`、`/admin.html`、`/login.html` 的组件化重写。
- 主题：preset `b3awTjpuKm` 的语义 token，浅色 + 深色两套，按设计稿落地。
- 保持全部现有 `/api/*` 调用、查询参数、轮询与错误处理语义。
- 保持 `state`→渲染→事件绑定的功能对等（列表、筛选、分页、弹窗、表单、轮询）。
- 更新 `.trellis/spec/frontend/` 中与新栈冲突的条款（原规范明确禁止框架与构建链）。

### Out of scope

- `server/` 业务逻辑、数据库、扫描 worker、Trellis CLI 脚本的行为改动（只允许为构建产物调整静态托管路径）。
- 新增产品功能（如任务评论、通知、权限模型变更）。
- 移动端专用交互改造（保持现有响应式断点行为即可）。

## Requirements

### R1 主题与视觉还原

- 采用 preset `b3awTjpuKm` 生成的 CSS 变量（`--background/--foreground/--card/--primary/...`），主色为 violet 系；与设计文件里的 `#7008E7 / #5D0EC0` 一致或可追溯到同一 preset。
- 字体：正文 Inter，标题 Geist（回退到系统字体栈，中文回退 `Microsoft YaHei`）。
- 圆角：preset `radius=default`，与设计稿 8/10/12/16 的层级一致。
- 提供浅色 / 深色主题，切换即时生效、持久化到本地，并在首屏渲染前应用以避免闪烁。
- 三个页面与 16 个设计画板逐一对照：布局分区、间距层级、字号字重、徽章与按钮形态一致。

### R2 页面与入口

- `/`：看板（侧栏项目 + 执行视图 + 筛选 + 注意力队列 + 4 列 Kanban）。
- `/admin.html`：管理台（项目协作 / 用户账号 / 项目接入 / Agent 设备 / 系统审计 五个 tab）。
- `/login.html`：登录 + 首次登录强制改密。
- 服务端 `serveStatic` 行为不变：三个 HTML 入口与 `/assets/*` 由同一目录直接托管。

### R3 看板功能对等清单

- 项目侧栏：白名单项目列表、当前项目高亮、`管理`入口、`重新扫描仓库`、扫描状态与时间。
- 顶栏：全局搜索、`创建任务`、`待我接受`、账号菜单（修改密码 / 退出）。
- 执行视图切换：全部进行中 / P0+P1 / 临近截止 / 长时间未动 / 实现中 / 被阻断；范围切换：全部 / 只看我的。
- 筛选：项目、负责人、优先级、阶段、阻断状态；应用筛选与分页（总数与页码）。
- 流动信号：实现中 WIP 计数、WIP 软上限编辑与保存、注意力队列（排序规则与原因标签）。
- Kanban：4 个泳道（规划 / 待放行 / 实现 / 检查·收尾），任务卡含 13 阶段证据条、负责人、截止、优先级、分组父子关系、关注信号。
- 任务操作：创建、派发、接受、编辑计划字段、发布状态、组合视图保存与切换。

### R4 弹层功能对等清单

- 任务详情（阶段条、计划字段、依赖、派发、产物 PRD/Design/Implement/Implementation Report/Check Report/E2E）。
- 创建任务、待我接受、工件查看（Markdown 只读渲染）、项目管理（选择文件夹）、修改密码、一次性凭证、计划字段、发布状态、组合视图。

### R5 团队模式功能对等清单

- 登录：会话检查、登录失败提示、首登强制改密、回跳只接受同源相对路径。
- 团队查询面板：跨项目分页、负责人 / 阶段 / 项目筛选、行内任务详情。
- 管理台：项目协作（成员角色、Agent 绑定、项目审计）、用户账号（创建 / 重置密码 / 编辑）、项目接入（克隆检查、工具链摘要审批、已接入项目）、Agent 设备（配对码一次性展示、撤销）、系统审计（筛选 / 分页）。
- 轮询与一致性：团队状态轮询沿用 ETag / 304 语义，`assignments.pending` 与项目版本号保持。

### R6 数据与安全契约

- 只调用现有 `/api/*`，不新增服务端接口；请求体字段名保持不变。
- 所有服务端文本进入 DOM 前保持转义语义（现状 `safe()` 与 `renderMarkdown()` 的边界），不得因 React 改造放松。
- Markdown 渲染继续走现有 `renderMarkdown()` 输出；一次性凭证等敏感字段不得进入日志或持久化。

### R7 工程与质量

- `npm run build` 产出可直接被 `node server/index.js` 托管的前端产物。
- 现有 150 个测试全部通过；测试引用到的纯逻辑模块（`dom.js`、`team-client.js`、`markdown.js`、`slug.js`、`execution-filter.js`、`archive-sort.js`）行为不变（路径可迁移，断言不弱化）。
- 组件和样式无死代码：旧 `public/*.js|*.html|*.css` 在切换完成后删除。
- 基础可访问性：可聚焦控件有可见焦点、弹层有 `role="dialog"` + Esc 关闭 + 焦点回收、图标按钮有 `aria-label`。

## Constraints

- 用户全局规则默认禁止验证阶段执行构建与启动 dev server；本任务交付物就是构建产物，因此 `npm run build` 属于交付步骤，不用于日常验证。验证以“构建产物 + 目标检查 + 运行 `node server/index.js` 后用浏览器核对”为主。
- 不改动 `server/` 的 API 契约；如必须改静态托管，只做路径映射的最小改动。
- 文案保持中文，术语与现有界面一致（阶段名、状态名、按钮文案）。
- 单次提交内不混入无关格式化改动。

## Acceptance Criteria

- [ ] `npx shadcn@latest preset decode b3awTjpuKm` 的配置落地到工程（style/theme/font/radius/icon 一致），`--primary` 与设计稿紫色一致。
- [ ] 浅色 / 深色主题可切换并持久化，首屏无闪烁。
- [ ] 看板页 R3 清单逐条可用：侧栏项目、搜索、创建任务、执行视图、筛选、分页、WIP 软上限、注意力队列、4 列 Kanban 与 13 阶段条。
- [ ] R4 的 9 类弹层全部可开可关，数据来自与现状相同的接口。
- [ ] 团队模式 R5 清单逐条可用：登录/改密/回跳、团队查询分页、管理台五个 tab、配对码与审计分页。
- [ ] 轮询仍使用 ETag/304，不发生全量重渲染抖动。
- [ ] `node --test tests/*.test.js` 全部通过（150 项，允许迁移 import 路径，不允许删除断言）。
- [ ] `npm run build` 产物由 `node server/index.js` 托管，`/`、`/admin.html`、`/login.html` 均可打开且可直接刷新。
- [ ] 无遗留旧前端文件（`public/app.js`、`admin.js`、`login.js`、`styles.css`、`team.css` 等），无未引用组件。
- [ ] 设计稿 16 个画板逐页核对完成，记录对照结论。

## Notes

- 任务规模大，实施阶段按“骨架 → 登录 → 管理台 → 看板 → 弹层 → 对照核查”推进，每阶段结束跑一次目标检查。
- 相关规范：`.trellis/spec/frontend/`，其中“禁止框架/构建链/TypeScript”的条款需在本任务内改写。
