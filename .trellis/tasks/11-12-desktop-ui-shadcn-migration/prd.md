# PRD: 客户端 UI 迁移到 React + shadcn（与 web 同一套组件与 token）

## Goal

桌面客户端的两个窗口（登录/环境检查页、实时确认窗）不再用手写 HTML + 全局 CSS + 原生 DOM 脚本，改为 **React 19 + TypeScript + Tailwind v4 + `web/src/components/ui/*` + lucide-react**，构建产物仍落在 `desktop/ui/`，`tauri.conf.json` 的 `frontendDist` 不变。视觉、字体、圆角、按钮/输入框高度、图标与 web 看板完全一致。

## Background

- `desktop/ui/index.html` + `setup.js`（267 行）实现「首次启动环境检查 → 登录」；`control.html` + `control.js`（422 行）实现实时同步确认窗；`styles.css` / `control.css` 是自定变量与卡片样式。
- 这套实现的字体、色值、圆角、按钮高度与 web 的 oklch token 体系（`web/src/index.css`）无关，图标为文字/自绘，与 web 的 lucide 不一致——用户要求「同样采用 shadcn 实现」。
- web 已有完整可复用的组件层：`web/src/components/ui/{button,input,label,card,progress,separator,badge,tooltip,scroll-area}`，`cn` 工具、`@` 别名、Tailwind v4 + `@tailwindcss/vite`、Inter/Geist 字体。
- Tauri 侧：`withGlobalTauri: true`（`window.__TAURI__.core.invoke` / `.event.listen`），窗口由 Rust 打开 `index.html`（`main.rs:787`）与 `control.html`（`sidecar.rs:326`）。
- 当前工作没有安装 `cargo tauri` CLI，本地只能 `cargo run` 起 debug 版验证。

## Requirements

### R1 构建链（零新增依赖）

- 新增 `web/vite.desktop.config.ts`：`root = web/desktop`，`build.outDir = ../../desktop/ui`、`emptyOutDir: true`，入口 `index.html`、`control.html`；`resolve.alias` 与 `web/vite.config.ts` 一致（`@` → `web/src`、`@shared` → `../shared`）；插件 `react()` + `tailwindcss()`。
- `web/package.json` 新增脚本 `build:desktop`；根/`desktop` 的依赖块不新增任何包（`desktop/package.json` 保持零运行时依赖）。
- `desktop/ui/` 由「手写源码」变为「构建产物」：删除 `desktop/ui/{index.html,control.html,setup.js,control.js,styles.css,control.css}`，`.gitignore` 忽略 `desktop/ui/`；`tauri.conf.json` 的 `frontendDist: "../ui"` 保持。
- CI（`.github/workflows/windows.yml` 的 `desktop-build` job）在 `tauri build` 之前插入 `npm --prefix web run build:desktop`；`desktop/README.md` 写明本地构建顺序。

### R2 组件与 token 复用

- 页面外壳用 `web/src/index.css` 的 token：`bg-background text-foreground`、`bg-card`、`border-border`、`text-muted-foreground`、`--radius` 体系；新增 `web/src/desktop/desktop.css` 仅做 `@import '../index.css'` + `@source '../../src'`（Tailwind 内容扫描）+ 窗口级 `body` 基线。
- 控件全部使用 `components/ui/*`：`Button`、`Input`、`Label`、`Card`、`Progress`、`Separator`、`Badge`、`Tooltip`（按需），图标全部 `lucide-react`。
- 暗色跟随 `prefers-color-scheme`（入口模块设置根类），不做主题切换 UI。

### R3 功能逐条对齐（不允许简化）

**登录/环境页（`index.html`）**

- 环境检查：`runtime_status` 结果驱动 `#env-panel` 展示（检查中 / 缺失 / 安装中 / 失败 / 就绪），步骤序列 `node:check → trellis:check → node:download → trellis:install → ready` 与 `runtime-progress` 事件进度映射 `PROGRESS_STEP`（含 `node:verify/node:extract/node:validate/trellis:validate/write-flag`）保持等价。
- 「安装运行环境」/「重新检查」按钮、失败原因展示、安装步骤 loading 与百分比。
- 就绪后切到登录表单：`app_status` 读取版本/配置路径/上次服务器与账号 → 自动登录（仅一次）→ `desktop_login` 提交；校验规则保持（URL 必须 http/https、登录名 ≥3、密码 ≥6）；提交中禁用输入并显示「正在登录…」；错误去掉 `Error: ` 前缀后展示。
- 「记住服务器/账号/密码」行为与现状一致。

**实时确认窗（`control.html`）**

- 750ms 轮询 `live_control_pending`；四类事件渲染与操作保持等价：`assignment_warning`（`live_control_decide`）、`remote_overwrite`（`live_control_restore`）、`initial_sync_review`（`review-open/review-collapse` + 每任务下拉决策 + `live_control_initial` `mode:review|dismiss|...`）、`task_file_conflict`（`view-difference` → `live_control_diff` 双栏 diff、`overwrite-server` 需二次确认、`live_control_decide`）。
- 交互细节保持：提交中禁用除 `close` 外的按钮并显示「正在提交，请稍候…」，失败展示错误并可返回；`close` 走 `live_control_dismiss` 后立即 `refresh()`；`reviewChoices` 默认值与选项集合与现状一致（`use-server/use-local/save-local/skip` 按差异类型给选项）。
- diff 展示：本地/服务端双栏、缺失文件文案「该文件在对应版本中不存在」、变更来源行（displayName · deviceName · 本地化时间）。

### R4 Rust 侧最小改动

- 命令名、参数、返回结构全部不变；`withGlobalTauri` 保持 `true`。
- 仅当新布局在既有窗口尺寸下出现裁切时，才允许调整 `main.rs` / `sidecar.rs` 中窗口宽高常量，并在 PR 说明中标注。

## Out of Scope

- 不改任何 Rust 业务逻辑、sidecar/agent 实现、命令签名。
- 不改 web 看板页面（`web/src/pages/**`、`features/**`）；控件高度统一由 `11-12-web-controls-unification` 负责。
- 不做主题切换 UI、不做 i18n、不改登录/同步协议。
- 不与 `11-12-rust-desktop-agent-single-exe` 并行改 `desktop/ui/**`（见 Dependencies）。

## Dependencies

- **必须**在 `11-12-rust-desktop-agent-single-exe`（Rust 单 exe 重写 + 环境门）归档之后开始：该任务同改 `desktop/ui/setup.js`（环境门 UI）与 `main.rs`，且其 check 清单明确要求校验 `desktop/ui/setup.js`。并行会互相覆盖。
- 依赖 `11-12-web-controls-unification` 完成（控件三档尺寸定稿），否则客户端控件高度会按旧尺寸写死。

## Acceptance Criteria

1. `npm --prefix web run build:desktop` 产出 `desktop/ui/{index.html,control.html}` 与 `desktop/ui/assets/*`；`desktop/ui` 内不再有 `setup.js`/`control.js`/`styles.css`/`control.css`。
2. `cargo run --manifest-path desktop/src-tauri/Cargo.toml`（或 `tauri build`）后：无环境时显示环境检查卡片并可安装；就绪后显示登录表单并可登录；`control.html` 窗口能渲染四类事件。
3. 视觉一致性：客户端登录卡片/按钮/输入框/进度条与 web 登录页（`/login.html`）的字体、圆角、高度、主色（紫）一致；图标全部来自 lucide，无 emoji/自绘图标残留。
4. 功能回归：环境检查→安装（含失败重试与百分比）→登录→自动登录→实时确认四类事件→diff 双栏→overwrite 二次确认→dismiss 后刷新，全部与改造前行为一致。
5. `npm test` 通过（`tests/desktop-package.test.js` 的断言改指向新源码与构建脚本）；`.github/workflows/windows.yml` 在 `tauri build` 前执行 `build:desktop`。
6. `desktop/README.md` 说明「先 `npm --prefix web run build:desktop` 再 `cargo run`/`tauri build`」，且说明 `desktop/ui/` 是构建产物不可手改。
