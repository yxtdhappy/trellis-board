# Design: 客户端 UI 迁移到 React + shadcn

## 目录与文件

| 文件 | 作用 |
| --- | --- |
| `web/desktop/index.html` | 登录/环境检查入口（HTML 只留 `<div id="root">` + 模块脚本） |
| `web/desktop/control.html` | 实时确认窗入口 |
| `web/src/desktop/main-index.tsx` | `createRoot` 挂载 `LoginApp`，设置根主题类 |
| `web/src/desktop/main-control.tsx` | `createRoot` 挂载 `ControlApp` |
| `web/src/desktop/LoginApp.tsx` | 环境检查 + 登录表单状态机 |
| `web/src/desktop/ControlApp.tsx` | 轮询 + 三类事件渲染 + 动作调用 |
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
- `web/tsconfig.node.json` 的 `include` 增加 `vite.desktop.config.ts`（否则新配置不进类型检查）。
- `tsc -b` 用现有 `tsconfig.json` 项目引用，`web/src/desktop/**` 已落在 `tsconfig.app.json` 的 `include` 内。
- Tailwind 内容扫描：`desktop.css` 里 `@source '../../src';`（web root 的源码）+ 默认扫描自身目录，避免 `components/ui` 的类被裁剪。
- `base` 保持默认 `/`：Tauri 用自定义协议从根提供 `index.html`，与 web 一致。
- 两个入口 HTML 保留 legacy 结构：`lang="zh-CN"`、`<meta charset>`/`viewport`、原 `title`（`Trellis Board 登录` / `Trellis Board 实时同步确认`）、`<div id="root">` + 模块脚本；`control.html` 保留原 `Content-Security-Policy` meta，`index.html` 保持无 CSP meta（与现状一致）。

## 状态机（LoginApp）

```
env: checking | needs_setup | installing | failed | ready
login: idle | submitting | error
```

- 挂载：`runtime_status` → 按 `state` 落到 `ready/needs_setup/installing/failed`；`listen('runtime-progress')` 更新步骤进度。
- `state === 'ready'` → 展示登录卡片，`app_status` 读版本/配置路径/上次服务器/账号/密码 → 自动登录一次（`autoLoginAttempted` ref）。
- 安装：`runtime_install` → 期间 `installing`，步骤条按 `PROGRESS_STEP` 归并到 5 个可见步骤（`node:check`、`trellis:check`、`node:download`、`trellis:install`、`ready`）；`runtime-progress` 只有 `{stage, message}`，状态文本直接显示 `message`（下载百分比在文案里），`Progress` 的 value 用「已完成步骤数 / 5」推算，不自造百分比；失败展示错误并提供「重试」。
- 提交：`validateInput()` 规则照搬（URL `http/https`、用户名 ≥3、密码 ≥6）；`desktop_login` 成功后 Rust 会 `window.navigate(board)`，前端无需跳转。
- 错误展示统一 `message.replace(/^Error:\s*/i, '')`。

组件映射：面板用 `Card/CardHeader/CardTitle/CardDescription/CardContent/CardFooter`；步骤用 `Progress` + lucide `Check/Loader2/Circle`；按钮 `Button`；表单 `Label + Input`；错误用 `text-destructive` + `border-destructive/40`。

## ControlApp 结构

- `useEffect` 750ms `setInterval(refresh)`；`refresh()` 调 `live_control_pending`，`JSON.stringify` 比较签名，变化才 `setCurrent`（否则轮询会把用户已选的下拉重置）。`null` 渲染空态标题「当前没有待处理事件」。
- `event.type` → 子组件：`InitialSyncReview`、`TaskFileConflict`、`TaskSyncError`，共享 `busy` / `error` / `title` / `message` / `details` 槽位。
- `InitialSyncReview`：`differences` 过滤 `type !== 'same'`；折叠态三个按钮（`safe` / `review-open` / `close`），展开态每行一个 `Select`（选项与默认值按差异类型，见 `prd.md` R3），`apply-review` 组 `{ taskId, action }[]` 调 `live_control_initial({ mode: 'review', decisions })`；`review-open/review-collapse` 只改本地 `expanded`。
- `TaskFileConflict`：`view-difference` → `live_control_diff({ taskSpaceId, conflictId })` 结果存入 `diff` 子状态并渲染 diff 视图 + `back`；`overwrite-server` 用 `window.confirm` 二次确认（保留原生 confirm，避免引入额外 dialog 栈）；conflict 明细行格式（`path · r{revision} · 仅换行差异/内容变化 · displayName · deviceName · 本地化时间`）与 `处理建议` 逐字保留；diff 视图用 `ScrollArea` + 单列堆叠的 `pre`（`bg-muted/40 font-mono text-xs`、`md:grid-cols-2` 仅在窗口 ≥768px 生效），与现状一致。
- `TaskSyncError`：标题「任务同步失败」，正文 `event.message` 或默认文案，仅一个 `close` 主按钮。
- 动作按钮一律 `Button`；进入 busy 时除 `close` 外全部 `disabled`，并显示「正在提交，请稍候…」。
- 动作失败：`error` 展示 `String(err)`（不剥前缀，与现状一致），`busy = false` 后按 `current` 重新 `render`。

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

旧的 `tests/desktop-package.test.js` 已在 `fbe97e3`（single-exe 重写）删除，当前 `tests/` 无任何桌面打包断言。新增 `tests/desktop-ui-build.test.js`（`node --test`，与现有测试同风格）守护构建契约：

- `desktop/src-tauri/tauri.conf.json`：`build.frontendDist === '../ui'`、`app.withGlobalTauri === true`、CSP 未放宽（仍含 `style-src 'self'`）。
- `web/package.json`：存在 `scripts['build:desktop']` 且调用 `vite build --config vite.desktop.config.ts`。
- `web/desktop/index.html`、`web/desktop/control.html`、`web/vite.desktop.config.ts` 存在。
- `.gitignore` 含 `desktop/ui`。
- `desktop/ui/` 不存在 `setup.js` / `control.js` / `styles.css` / `control.css`（若目录存在）。
- `.github/workflows/windows.yml`：`build:desktop` 的行号小于 `tauri build` 的行号（同一 job 内先后顺序）。

`.github/workflows/windows.yml` `desktop-build` job：在 `npm run build` 之后、`cargo test` / `tauri build` 之前加 `npm --prefix web run build:desktop`（`tauri build` 读 `frontendDist`，顺序错会打包旧产物）。

`desktop/README.md` 补构建顺序与「`desktop/ui` 是产物」。

## 风险

- **CSP `style-src 'self'`**：只允许外部样式表与 CSSOM 赋值；不得用 `dangerouslySetInnerHTML` 注入 `<style>`，不得内联 `style` 字符串进入 HTML。React 的 `style={{}}` 走 CSSOM，安全。
- **字体资源**：`@fontsource-variable/*` 会被 Vite 产出到 `assets/`，`default-src 'self'` 覆盖；若出现字体 404，说明 `assets` 未随产物拷贝（`emptyOutDir` 与打包顺序问题）。
- **HTML 入口的相对脚本路径**：`root = web/desktop` 时脚本写成 `../src/desktop/main-index.tsx`；打包后路径被重写为 `./assets/index-*.js`。
- **窗口尺寸**：新布局若在既有宽高下裁切，才允许改 Rust 窗口常量（记录在 PR 说明）。
- **行为漏项**：`setup.js`/`control.js` 必须逐函数对照迁移（`readStatus`、`markSteps`、`renderRuntime`、`showLogin`、`refreshRuntime`、`installRuntime`、`validateInput`、`setSubmitting`、`refresh`、`render`、`runAction`、`renderConflictDiff`、`appendDiff`、`appendInitialDifference`、`conflictLabel`、`differenceTitle`、`differenceTypeLabel`），漏掉任一分支都算未完成。
