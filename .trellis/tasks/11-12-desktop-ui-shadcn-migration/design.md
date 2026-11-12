# Design: 客户端 UI 迁移到 React + shadcn

## 目录与文件

| 文件 | 作用 |
| --- | --- |
| `web/desktop/index.html` | 登录/环境检查入口（HTML 只留 `<div id="root">` + 模块脚本） |
| `web/desktop/control.html` | 实时确认窗入口 |
| `web/src/desktop/main-index.tsx` | `createRoot` 挂载 `LoginApp`，设置根主题类 |
| `web/src/desktop/main-control.tsx` | `createRoot` 挂载 `ControlApp` |
| `web/src/desktop/LoginApp.tsx` | 环境检查 + 登录表单状态机 |
| `web/src/desktop/ControlApp.tsx` | 轮询 + 四类事件渲染 + 动作调用 |
| `web/src/desktop/tauri.ts` | `window.__TAURI__` 的最小类型封装（`invoke` / `listen`） |
| `web/src/desktop/desktop.css` | `@import '../index.css'`、`@source '../../src'`、`body` 基线 |
| `web/vite.desktop.config.ts` | 独立构建配置，产物 `desktop/ui/` |

删除：`desktop/ui/{index.html,control.html,setup.js,control.js,styles.css,control.css}`；`.gitignore` 加 `desktop/ui/`。

## 构建配置

```ts
// web/vite.desktop.config.ts
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const webDir = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(webDir, 'desktop')

export default defineConfig({
  root: desktopDir,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(webDir, 'src'),
      '@shared': path.resolve(webDir, '../shared'),
    },
  },
  build: {
    outDir: path.resolve(webDir, '../desktop/ui'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.resolve(desktopDir, 'index.html'),
        control: path.resolve(desktopDir, 'control.html'),
      },
    },
  },
})
```

- `web/package.json`：`"build:desktop": "tsc -b && vite build --config vite.desktop.config.ts"`。
- `tsc -b` 用现有 `tsconfig.json` 项目引用，`web/src/desktop/**` 已落在 `tsconfig.app.json` 的 `include` 内。
- Tailwind 内容扫描：`desktop.css` 里 `@source '../../src';`（web root 的源码）+ 默认扫描自身目录，避免 `components/ui` 的类被裁剪。
- `base` 保持默认 `/`：Tauri 用自定义协议从根提供 `index.html`，与 web 一致。

## 状态机（LoginApp）

```
env: checking | needs_setup | installing | failed | ready
login: idle | submitting | error
```

- 挂载：`runtime_status` → 按 `state` 落到 `ready/needs_setup/installing/failed`；`listen('runtime-progress')` 更新步骤进度。
- `state === 'ready'` → 展示登录卡片，`app_status` 读版本/配置路径/上次服务器/账号/密码 → 自动登录一次（`autoLoginAttempted` ref）。
- 安装：`runtime_install` → 期间 `installing`，步骤条按 `PROGRESS_STEP` 归并到 4 个可见步骤（`node:check`、`trellis:check`、`node:download`、`trellis:install`）+ `ready`；失败展示 `status.error` 并提供「重试」。
- 提交：`validateInput()` 规则照搬（URL `http/https`、用户名 ≥3、密码 ≥6）；`desktop_login` 成功后 Rust 会 `window.navigate(board)`，前端无需跳转。
- 错误展示统一 `message.replace(/^Error:\s*/i, '')`。

组件映射：面板用 `Card/CardHeader/CardTitle/CardDescription/CardContent/CardFooter`；步骤用 `Progress` + lucide `Check/Loader2/Circle`；按钮 `Button`；表单 `Label + Input`；错误用 `text-destructive` + `border-destructive/40`。

## ControlApp 结构

- `useEffect` 750ms `setInterval(refresh)`；`refresh()` 调 `live_control_pending`，返回 `null` 显示「暂无待处理确认」空态。
- `event.type` → 子渲染函数：`AssignmentWarning`、`RemoteOverwrite`、`InitialSyncReview`、`TaskFileConflict`，共享 `busy`、`error`、`message`。
- `InitialSyncReview`：每个差异行保留原始 select 选项集合与默认值（`reviewChoices` → `useState<Map>`），`apply-review` 组 `{ taskId, action }[]`。
- `TaskFileConflict`：`view-difference` → `live_control_diff` 结果覆盖为 diff 视图；`overwrite-server` 用 `window.confirm` 二次确认（保留原生 confirm，避免引入额外 dialog 栈）；diff 视图用 `ScrollArea` + 双栏 `pre`（`bg-muted/40 font-mono text-xs`）。
- 动作按钮一律 `Button`，`close` 例外不禁用。

## Tauri 适配层

```ts
declare global {
  interface Window {
    __TAURI__?: {
      core?: { invoke?: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> }
      event?: { listen?: (name: string, handler: (event: { payload: unknown }) => void) => Promise<() => void> }
    }
  }
}
export function getInvoke() { /* 返回 window.__TAURI__?.core?.invoke，缺失时抛中文错误 */ }
export function getListen() { /* 同上 */ }
```

保持现状语义：`invoke` 缺失时页面显示「请通过桌面客户端打开」类提示而不是白屏。

## 测试与 CI

- `tests/desktop-package.test.js`：
  - 保留 `:162` `frontendDist === '../ui'`。
  - `:337-339` 改读 `web/src/desktop/ControlApp.tsx`，断言含 `live_control_dismiss`、`正在提交，请稍候`、`/个任务.*个文件/`。
  - `:352-354` 改为断言 `web/desktop/index.html`、`web/desktop/control.html`、`web/vite.desktop.config.ts` 存在，且 `.gitignore` 含 `desktop/ui`，且 `web/package.json` 有 `build:desktop`。
- `.github/workflows/windows.yml` `desktop-build` job：在 `npm run build` 之后、`tauri build` 之前加 `npm --prefix web run build:desktop`。
- `desktop/README.md` 补构建顺序与「`desktop/ui` 是产物」。

## 风险

- **CSP `style-src 'self'`**：只允许外部样式表与 CSSOM 赋值；不得用 `dangerouslySetInnerHTML` 注入 `<style>`，不得内联 `style` 字符串进入 HTML。React 的 `style={{}}` 走 CSSOM，安全。
- **字体资源**：`@fontsource-variable/*` 会被 Vite 产出到 `assets/`，`default-src 'self'` 覆盖；若出现字体 404，说明 `assets` 未随产物拷贝（`emptyOutDir` 与打包顺序问题）。
- **HTML 入口的相对脚本路径**：`root = web/desktop` 时脚本写成 `../src/desktop/main-index.tsx`；打包后路径被重写为 `./assets/index-*.js`。
- **窗口尺寸**：新布局若在既有宽高下裁切，才允许改 Rust 窗口常量（记录在 PR 说明）。
- **行为漏项**：`setup.js`/`control.js` 必须逐函数对照迁移（`readStatus`、`markSteps`、`renderRuntime`、`showLogin`、`appendDiff`、`appendInitialDifference`、`runAction`、`render`），漏掉任一分支都算未完成。
