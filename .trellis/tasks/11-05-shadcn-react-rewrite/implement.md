# 实施计划 · shadcn React 重写

> 每个阶段结束都执行「目标检查」，通过后再进入下一阶段。构建与 dev server 不作为日常验证手段，只在阶段末与交付前使用。

## 阶段 0 · 脚手架与主题（可回滚点 A）

- [ ] `npm i -D vite @vitejs/plugin-react typescript tailwindcss @tailwindcss/vite`；`npm i react react-dom lucide-react clsx tailwind-merge class-variance-authority`
- [ ] 建 `web/`：`vite.config.ts`（root=web，outDir=../public，emptyOutDir，三入口，`/api` 代理）、`tsconfig.json`、`components.json`
- [ ] `npx shadcn@latest init -t vite -p b3awTjpuKm`，再 `add button card badge dialog tabs table input select switch checkbox avatar progress pagination tooltip dropdown-menu sonner`
- [ ] `globals.css`：preset 变量 + `.dark` + `@theme inline`；核对 `--primary` 与设计稿一致
- [ ] 迁移纯逻辑模块到 `web/src/lib/`（`dom`、`team-client`、`markdown`、`slug`、`execution-filter`、`archive-sort`），同步 `tests/*.test.js` 的 import（断言不改）
- [ ] 验证：`node --test tests/*.test.js`

## 阶段 1 · 应用骨架（可回滚点 B）

- [ ] 三个 HTML 入口 + `main/*.tsx`（createRoot）
- [ ] `AppShell`（顶栏 / 侧栏 / 内容区）、`ThemeProvider`（浅/深切换 + 持久化 + 首屏无闪烁）
- [ ] `Toast`（sonner）、`ErrorBoundary`、全局 `fetch` 封装（超时、错误归一化）
- [ ] 验证：`npm run build` 后 `node server/index.js` 打开三个入口不报错

## 阶段 2 · 登录与会话

- [ ] `useSession`：检查会话、登录、登出、首登强制改密、`returnTo` 同源校验（复用 `safeReturnTo`）
- [ ] 登录页对齐设计画板 04（品牌区 + 表单卡 + 强制改密态）
- [ ] 验证：目标检查 + 手动登录流程（无后端时可只做组件层断言）

## 阶段 3 · 管理台（画板 05–09）

- [ ] `项目协作`：项目选择、成员角色保存、Agent 绑定、项目审计分页
- [ ] `用户账号`：创建（一次性临时密码展示）、重置密码、编辑账号
- [ ] `项目接入`：克隆检查、工具链摘要确认、已接入项目列表
- [ ] `Agent 设备`：配对码一次性展示、设备撤销
- [ ] `系统审计`：动作/操作人筛选、分页加载更多
- [ ] 弹层：编辑账号、一次性凭证、批准项目接入
- [ ] 验证：目标检查；五个 tab 每个走一次读写路径

## 阶段 4 · 看板数据层（画板 01–03 的数据部分）

- [ ] `useBoard`：`/api/board` 拉取、`/api/board/refresh/start` 进度轮询、扫描状态
- [ ] 执行视图与范围切换（复用 `execution-filter` 的判定函数）
- [ ] 筛选：项目/负责人/优先级/阶段/阻断 + 应用 + 分页
- [ ] 流动信号：实现中 WIP、WIP 软上限保存
- [ ] 注意力队列：排序与原因标签
- [ ] 验证：目标检查；同一筛选组合下与旧实现返回相同任务集合（对拍脚本）

## 阶段 5 · 看板主体（画板 01、02、03）

- [ ] 侧栏项目列表 + 管理入口 + 重新扫描
- [ ] 4 列 Kanban、任务卡（13 阶段条、分组父子、关注信号、负责人/截止/优先级）
- [ ] 归档索引视图（排序 `sortArchivedTasks`、最多 80 条、分页）
- [ ] 团队查询面板（跨项目分页 + 筛选 + ETag 轮询）
- [ ] 验证：目标检查；视图切换与分页不丢状态

## 阶段 6 · 看板弹层群（画板 10–16）

- [ ] 任务详情（阶段、计划字段、依赖、派发、产物）
- [ ] 创建任务、待我接受、工件查看（`renderMarkdown`）、项目管理（选择文件夹）、修改密码、组合视图、发布状态
- [ ] Esc/遮罩关闭、焦点回收、提交中禁用与错误保留
- [ ] 验证：目标检查；每个弹层开关与提交路径至少一次

## 阶段 7 · 视觉对照与响应式

- [ ] 16 个画板逐页对照（浅色 + 深色），记录偏差与修正
- [ ] 窄屏（≤ 1024 / ≤ 768）布局检查
- [ ] 可访问性：焦点可见、`aria-label`、`role="dialog"`、颜色对比

## 阶段 8 · 清理与验收（可回滚点 C）

- [ ] 删除旧 `public/app.js`、`admin.js`、`login.js`、`styles.css`、`team.css`、`dom.js` 等（已被 `web/src` 取代）
- [ ] `npm run build` → `public/` 产出三入口 + assets；`node server/index.js` 逐页核对
- [ ] `node --test tests/*.test.js` 全绿
- [ ] 更新 `.trellis/spec/frontend/`（目录结构、渲染与状态、质量守则改为 React/Vite/shadcn 版本）
- [ ] `git status` 确认无无关改动，按用户确认后提交

## 验证命令

```bash
node --test tests/*.test.js      # 每阶段末
npm run build                    # 阶段 1 / 8
node server/index.js             # 交付验证
```

## 评审关卡

1. 阶段 0 结束：工程结构与主题变量评审（是否与 preset/设计稿一致）。
2. 阶段 3 结束：管理台功能对等评审。
3. 阶段 6 结束：看板与弹层功能对等评审。
4. 阶段 8 结束：全量验收 + 提交确认。

## 回滚点

- A（阶段 0 前）：`git checkout -- public/` 即恢复旧前端。
- B（阶段 1 后）：删除 `web/` 与 `package.json` 新增依赖即可回到阶段 0。
- C（阶段 8 前）：旧文件尚未删除，可直接回退到旧页面。
