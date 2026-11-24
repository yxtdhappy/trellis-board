# @trellis-board/web

Trellis Board 前端：React 19 + Vite 8 + TypeScript + Tailwind v4 + shadcn/ui，多页入口（board / admin / login）
加一个 Tauri 桌面登录窗口入口。

## 构建与开发

在仓库根执行（通过统一构建/开发脚本驱动）：

```powershell
yarn build                      # tsc -b && vite build -> packages/server/public
yarn build --target=desktop-ui  # tsc -b && vite build --config vite.desktop.config.ts -> packages/desktop/ui
yarn dev --mode=web             # Vite dev server，/api 代理到 127.0.0.1:4317
```

`packages/web` 下也可直接 `yarn dev|build|build:desktop|lint`。

## 目录

| 路径 | 职责 |
| --- | --- |
| `index.html` · `admin.html` · `login.html` | Board 多页入口 |
| `desktop/index.html` | Tauri 桌面登录窗口入口 |
| `src/pages/` · `src/features/` | 页面组合与领域组件 |
| `src/hooks/` · `src/api/` | 唯一数据源与 fetch 封装 |
| `src/lib/` | 浏览器/Node 共用纯逻辑（`.js` + `.d.ts`），被 Node 测试直接 import |
| `src/desktop/` | 桌面登录、环境门与看板内同步确认弹窗 UI |

## 约束

- 纯模块与共享代码：`src/lib/*` 不得依赖 DOM/Node 内置；跨端模块放 `packages/shared/`，通过
  `@trellis-board/shared/…` 引入（`tsconfig.app.json` 的 `paths` 登记）。
- 组件不直接 `fetch`，数据请求只走 `src/hooks/`。
- 构建产物 `packages/server/public/` 与 `packages/desktop/ui/` 都是生成目录，不手改。
- 规范细节见 `.trellis/spec/frontend/`。
