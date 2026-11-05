# 目录与模块

## 源码结构

| 路径 | 职责 |
| --- | --- |
| `web/index.html` · `admin.html` · `login.html` | Vite 多页入口，含首屏主题探测脚本 |
| `web/src/main-*.tsx` | 每个入口的 `createRoot` 挂载与 Provider |
| `web/src/app/` | `AppProviders`（主题 + Tooltip + Toaster）、`theme.tsx` |
| `web/src/pages/` | 页面级组件：`board/`、`admin/`、`login/` |
| `web/src/features/` | 按领域拆分的业务组件与弹层（`board/`、`admin/`） |
| `web/src/api/` | `request.ts`（fetch 封装、`ApiError`）、`board.ts`、`admin.ts` |
| `web/src/hooks/` | `useBoard`、`useAdminConsole`、`useAdminProjects` |
| `web/src/components/ui/` | shadcn 生成的原语，不手工改结构 |
| `web/src/components/layout/` | `TopBar`、`ProjectRail` |
| `web/src/lib/` | 浏览器/Node 共用的纯逻辑模块（`.js`）与其 `.d.ts` |
| `shared/` | 前后端共用纯模块（当前仅 `slug.js`） |
| `public/` | **构建产物**，由 `npm run build` 生成，不手改 |

## 模块边界

- `features/*` 依赖 `hooks/*`、`api/*`、`lib/*`、`components/ui/*`；页面只做组合，不写数据请求。
- `hooks/*` 是唯一的数据源；组件不直接 `fetch`。
- `web/src/lib/*.js` 与 `shared/slug.js` 必须保持无 DOM 依赖、无 Node 内置依赖，Node 测试可直接 import。
- 跨端增加的纯模块放 `shared/`，并在 `web/vite.config.ts` 的 `@shared` 别名与 `tsconfig.app.json` 的 `paths` 同步登记。
- `server/` 通过 `../shared/slug.js` 复用 slug 逻辑；不要让它再依赖 `public/`（构建会清空该目录）。

## 命名

- 组件文件 `PascalCase.tsx`；hook `useXxx.ts`；纯函数模块 kebab-case。
- 数据结构类型与组件同文件导出，跨文件复用放 `features/<domain>/task-view.ts` 这类领域模块。
- 样式一律使用 Tailwind token 类（`bg-card`、`text-muted-foreground`、`border-border`），不写任意色值。

## 构建产物

`web/vite.config.ts` 设 `build.outDir = ../public`、`emptyOutDir = true`，入口为三个 HTML。产物包含 `public/{index,admin,login}.html` 与 `public/assets/*`。服务端 `serveStatic()` 不需要任何改动。
