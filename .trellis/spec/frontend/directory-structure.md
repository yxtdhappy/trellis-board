# 目录与模块

## 源码结构

| 路径 | 职责 |
| --- | --- |
| `apps/web/index.html` · `admin.html` · `login.html` | Vite 多页入口，含首屏主题探测脚本 |
| `apps/web/src/main-*.tsx` | 每个入口的 `createRoot` 挂载与 Provider |
| `apps/web/src/app/` | `AppProviders`（主题 + Tooltip + Toaster）、`theme.tsx` |
| `apps/web/src/pages/` | 页面级组件：`board/`、`admin/`、`login/` |
| `apps/web/src/features/` | 按领域拆分的业务组件与弹层（`board/`、`admin/`） |
| `apps/web/src/api/` | `request.ts`（fetch 封装、`ApiError`）、`board.ts`、`admin.ts` |
| `apps/web/src/hooks/` | `useBoard`、`useAdminConsole`、`useAdminProjects` |
| `apps/web/src/components/ui/` | shadcn 生成的原语，不手工改结构 |
| `apps/web/src/components/layout/` | `TopBar`、`ProjectRail` |
| `apps/web/src/browser/` | 浏览器专用 DOM/Web API 适配器（如 `clipboard`） |
| `apps/web/src/lib/` | 浏览器/Node 共用的纯逻辑模块（`.js`）与其 `.d.ts` |
| `packages/shared/` | 前后端共用纯模块：`slug`、`task-snapshot`、`trellis-watcher`、`remote-identity`、`trellis-agent-tools`、`zip` |
| `apps/server/public/` | **构建产物**，由根目录 `npm run build` 生成，不手改 |
| `apps/desktop/ui/` | 桌面控制窗口**构建产物**，由 `npm run build:desktop` 生成，不手改 |

## 模块边界

- `features/*` 依赖 `hooks/*`、`api/*`、`browser/*`、`lib/*`、`components/ui/*`；页面只做组合，不写数据请求。
- `hooks/*` 是唯一的数据源；组件不直接 `fetch`。
- `apps/web/src/lib/*.js` 与 `packages/shared/slug.js` 必须保持无 DOM 依赖、无 Node 内置依赖，Node 测试可直接 import。
- `apps/web/src/browser/*.js` 可依赖浏览器全局对象，但不得依赖 React、hooks、api 或 Node 内置模块；Node 测试通过注入全局对象覆盖行为。
- 跨端增加的纯模块放 `packages/shared/`，以 `@trellis-board/shared/…` 引入；`apps/web/tsconfig.app.json` 的 `paths` 需登记 `@trellis-board/shared/*`。
- `apps/server/` 通过 `@trellis-board/shared/slug.js` 复用 slug 逻辑；不要让它再依赖 `apps/server/public/`（构建会清空该目录）。

## 命名

- 组件文件 `PascalCase.tsx`；hook `useXxx.ts`；纯函数模块 kebab-case。
- 数据结构类型与组件同文件导出，跨文件复用放 `features/<domain>/task-view.ts` 这类领域模块。
- 样式一律使用 Tailwind token 类（`bg-card`、`text-muted-foreground`、`border-border`），不写任意色值。

## 构建产物

`apps/web/vite.config.ts` 设 `build.outDir = ../server/public`、`emptyOutDir = true`，入口为三个 HTML。产物包含 `apps/server/public/{index,admin,login}.html` 与 `apps/server/public/assets/*`；`apps/server/index.js` 的 `publicDir` 指向 `apps/server/public`，无需额外配置。

`apps/web/vite.desktop.config.ts` 以 `apps/web/desktop/` 为 root，产物写入 `apps/desktop/ui/`，供 Tauri `frontendDist` 使用。
