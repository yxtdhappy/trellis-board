# 前端开发规范

适用范围：`packages/web/`（源码）与 `packages/server/public/`、`packages/desktop/ui/`（构建产物）。前端是 **React 19 + Vite 8 + TypeScript + Tailwind v4 + shadcn/ui** 的多页应用，构建产物由 `packages/server/index.js` 直接静态托管。

## 规范索引

| 文档 | 内容 |
| --- | --- |
| [目录与模块](./directory-structure.md) | 源码结构、共享纯逻辑模块、构建产物落点 |
| [渲染与状态](./rendering-and-state.md) | hooks、SSE/REST 对齐、任务空间、操作项、冲突弹层与安全边界 |
| [质量与验证](./quality-guidelines.md) | 类型检查、构建、测试、可访问性、浏览器验收 |

## 页面入口

- `packages/web/index.html` → `src/main-board.tsx` → [BoardPage](../../../packages/web/src/pages/board/BoardPage.tsx)：任务流水线 / 团队视角 / 归档索引。
- `packages/web/admin.html` → `src/main-admin.tsx` → [AdminPage](../../../packages/web/src/pages/admin/AdminPage.tsx)：团队管理七个 tab。
- `packages/web/login.html` → `src/main-login.tsx` → [LoginPage](../../../packages/web/src/pages/login/LoginPage.tsx)：登录与首登改密跳转。
- 构建：根目录 `yarn build`（执行 `packages/web` 的 `tsc -b && vite build`），产物写入 `packages/server/public/`；桌面 UI 用 `yarn build:desktop` 写入 `packages/desktop/ui/`。
- 本地联调：`yarn web:dev`，Vite 把 `/api` 代理到 `http://127.0.0.1:4317`。

## 必须记住的契约

- 只调用 `packages/server/` 暴露的现有 `/api/*`；请求方法、路径、字段名保持与迁移前一致。
- 纯逻辑模块 `dom/markdown/execution-filter/archive-sort/team-client` 位于 `packages/web/src/lib/`，`slug` 位于 `packages/shared/`；它们被 `packages/test-support/` 直接 import，**不得改写其导出行为**。
- 列表先读 `/api/board` 的轻量任务，打开详情才请求 `/api/task`。
- 服务端文本由 React 默认转义；只有 Markdown 预览允许 `dangerouslySetInnerHTML`，且必须走 `renderMarkdown()`。
- 弹层统一使用 `components/ui/dialog`，Esc 关闭由该组件的栈式监听处理。
- 主题只有 `Mode: Light|Dark` 两套 token；禁止写死颜色。

## 当前明确不做

- 不引入第二个状态库（Redux/Zustand/React Query）；页面级 hook 已覆盖需求。
- 不把 shadcn 组件手工重写；`components/ui/` 由 CLI 生成，只做必要包装。
- 不在浏览器代码里导入 Node 内置模块。
- 不新增路由库；三个页面是独立的 HTML 入口。
