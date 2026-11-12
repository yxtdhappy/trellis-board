# PRD: 客户端与 web 视觉统一 + 接入弹窗体验 + 控件规范

## Goal

桌面客户端（`desktop/ui` 的原生 HTML/CSS/JS）与 web 看板（`web/` 的 React + Tailwind v4 + shadcn）当前是两套视觉实现：字体、圆角、间距、按钮高度、图标来源都不一致。本父任务做三件事：

1. 客户端页面改用与 web 完全相同的技术栈与组件（Vite + React + Tailwind + `web/src/components/ui/*` + lucide 图标），视觉与 web 一致，不再维护手写 CSS。
2. 「任务流水线」页接入本地 Git 项目时，选完仓库目录后立即弹出 dialog（内部 skeleton loading），不要再等待 `inspect_local_project` 返回才弹窗。
3. 统一 web 各页面控件高度与实现来源：优先用 shadcn 组件，控件高度收敛到 32/28/24 px 三档，消除 `h-7/h-8/h-9/h-10/h-7.5` 混用与裸 `<button>`。

父任务只维护需求集、任务地图与跨子任务验收口径，不直接实现。

## Background

- 客户端 `desktop/ui/` 是手写 HTML + 全局 CSS（`styles.css`、`control.css`）+ 原生 DOM 脚本（`setup.js` 267 行、`control.js` 422 行）。字体、色值、圆角（`--radius` 自定）与 web 的 oklch token 体系无关；图标用文字/emoji/自绘，与 web 的 lucide 不一致。
- `inspect_local_project`（`desktop/src-tauri/src/main.rs:366-397`）把「选目录」与「读取仓库信息」合成一次调用：`blocking_pick_folder()` 之后同步 `await sidecar::inspect_project(...)`，Rust 侧返回后前端才 `setOnboardingOpen(true)`（`web/src/components/layout/ProjectRail.tsx:270`）。仓库大 / git 远端慢（`git fetch`、分支探测）时用户看到按钮一直转圈，误以为卡死。
- 控件高度现状：`web/src/components/ui/input.tsx` 默认 `h-7`，`select.tsx` 默认 `h-8`、`sm` 变体 `h-7`，`button.tsx` 默认 `h-7`、`sm h-6`、`lg h-8`；页面层再用 `h-8`（约 30 处）、`h-9`/`h-10`（`ProjectManagerDialog.tsx:152/161/173`）覆盖，且多处交互元素是裸 `<button>` 而非 shadcn `Button`。

## Requirements

### R1 客户端视觉与实现栈统一（子任务 `11-12-desktop-ui-shadcn-migration`）

- `desktop/ui/*.html|js|css` 迁移为 React + TSX 源码，构建进 `desktop/ui/`，`tauri.conf.json` 的 `frontendDist` 仍为 `../ui`，Rust 打开的 `index.html` / `control.html` 两个入口文件名不变。
- 组件与 token 直接复用 `web/src/components/ui/*`、`web/src/index.css` 的 oklch token（`--primary` 紫色体系、`--radius`、Inter/Geist 字体），不新增第二套设计变量；图标统一 lucide-react。
- 开发依赖**不新增**：复用 web 已有的 Vite/Tailwind/React 依赖链，`desktop/package.json` 保持零运行时依赖。
- 所有 Tauri 命令名、参数、返回结构不变；本子任务不改 Rust 逻辑（仅当窗口尺寸导致内容裁切时才允许调整窗口尺寸常量）。
- 环境检查页（`#env-panel`）、登录页（`#login-panel`）、实时确认窗（`control.js` 的全部交互）三项功能与现状逐条对齐。

### R2 接入本地项目 dialog 即时弹出（子任务 `11-12-project-onboarding-instant-dialog`）

- 拆开「选目录」与「读仓库」：新增 `pick_local_project_folder` 只返回路径；`inspect_local_project` 改为接收 `path` 参数并只做检查。
- 前端拿到路径后立即打开 `ProjectOnboardingDialog`，弹窗内先用 skeleton 占位渲染 header/表单骨架，`inspect_local_project` 完成后替换为完整表单。
- 检查失败时弹窗内展示错误与「重试 / 取消」，不再回到「没有读取到有效的本地 Git 仓库，请重新选择仓库根目录」的死路。
- 检查过程中关闭弹窗要能正常关闭（不阻塞、不残留 pending 状态）。
- `inspect_local_project` 的原有返回结构与 `pending_project_path` 语义不变，后续 `initialize/check_push/preflight/associate/cancel` 流程零改动。

### R3 web 控件统一（子任务 `11-12-web-controls-unification`）

- 控件高度收敛三档：`32px`（`h-8`，主档：Input、Select 默认、Button 默认）、`28px`（`h-7`，紧凑：Button sm、Select sm、icon-sm）、`24px`（`h-6`，微型：Button xs、badge/pill、icon-xs）。
- `components/ui/{input,button,select}.tsx` 的默认尺寸改为上述三档；页面层冗余的 `h-8` 覆盖删除，`h-9`/`h-10`/`h-7.5` 全部消除。
- 可交互元素优先 shadcn `Button`；纯布局/命中区包装（如 `TaskCard.tsx:56` 卡片覆盖层）可保留裸元素。
- 同一工具栏内图标尺寸一致（`size-3.5`/`size-4` 按控件档位），控件文字不小于 `text-xs`，11px 只允许出现在 badge/pill。
- 视觉 token 不变：不改 `--primary` 等色值，不改 dialog 的固定 header/footer + 单一 `DialogBody` 滚动壳。

## Out of Scope

- 不改服务端 `server/**` 与 `/api/*` 协议；不改 `AGENT_PROTOCOL_VERSION`、控制事件类型与判定键。
- 不引入 Radix / 第二套状态库 / 路由库；不新增前端依赖（`package.json`/`web/package.json` 依赖块保持）。
- 不做暗色主题切换 UI（沿用现有 token 与系统偏好），不改 web 页面信息架构。
- 不改 `web/src/lib/**`、`shared/**` 纯逻辑模块的导出行为。
- 不与进行中的 `11-12-rust-desktop-agent-single-exe`（Rust 单 exe 重写，同源文件在改）并行改 `desktop/ui/**` 与 `desktop/src-tauri/src/main.rs`，见 Dependencies。

## Acceptance Criteria

1. 客户端两个窗口（登录/环境页、实时确认窗）与 web 使用同一套 token 与 shadcn 组件：字号、圆角、按钮/输入框高度与 web 页面目视一致，图标全部来自 lucide。
2. `desktop/ui/` 不再包含手写 `setup.js`/`control.js`/`styles.css`/`control.css`；构建产物由 `npm --prefix web run build:desktop` 生成，`desktop/ui/{index,control}.html` 两个入口可被 Tauri 正常加载。
3. 选完仓库目录后 dialog 立即出现（<100ms 量级）并显示 skeleton；数据返回后自动填充；慢仓库（人为制造 `git fetch` 延迟）下无「转圈无反馈」。
4. 检查失败/代理不可达时，dialog 内给出错误文案与「重试」「取消」，取消后 `pending_project_path` 已清理，可立即重新接入。
5. web 全站 grep 无 `h-9`/`h-10`/`h-7.5` 控件高度类（`h-7` 仅出现在 sm 变体定义处），页面层无冗余 `h-8` 覆盖；`ProjectManagerDialog` 不再用 `h-10`/`h-9`。
6. 视觉验收：pipeline/team/archive/plugins/admin/login 六类页面 + 全部 dialog 截图对比，控件对齐同一基线，无遮挡、无滚动条抖动、无文字截断。
7. 质量门：`npm test`（根）、`npm --prefix web run build`、`npm --prefix web run lint` 通过；`cargo test --manifest-path desktop/src-tauri/Cargo.toml` 通过（R2 有 Rust 改动）。
8. 控件尺寸档位与「优先 shadcn」规则写入 `.trellis/spec/frontend/`，后续页面按规范实现。

## Dependencies / Ordering

- `11-12-rust-desktop-agent-single-exe` 正在进行中（`main.rs`、`Cargo.toml`、`src/agent/**` 有未提交改动），其 PRD R4 声明「Tauri 命令名与返回结构保持不变」「`desktop/ui/**` 与 `web/src/**` 无需改动」。
- 因此顺序：先 `11-12-web-controls-unification`（纯 web，无冲突）→ `11-12-project-onboarding-instant-dialog`（Rust 改动为新增命令 + 参数，需在该任务落地后同步到 in-process agent 实现）→ `11-12-desktop-ui-shadcn-migration`（重写 `desktop/ui/**` 与 CI/打包断言，必须等上面那个 Rust 任务归档后再开始，避免双方互毁工作）。
- 若用户要求打乱顺序，需先确认 `desktop/ui/**` 与 `main.rs` 的归属，避免同一文件并发改写。

## Key Decisions

- 客户端选 React 重建而非「手写 CSS 对齐 token」：用户明确要求「同样采用 shadcn 实现」，手写 CSS 无法复用 `components/ui`，后续两边继续漂移。
- 构建复用 web 的 Vite 依赖链（新增 `web/vite.desktop.config.ts` + `build:desktop` 脚本），而不是给 `desktop/` 新建一套 npm 依赖：零新增依赖，`cn`/`@base-ui/react` 等裸导入按 importer 目录解析到 `web/node_modules`，CI 已先装 web。
- `desktop/ui/` 由「手写源码」转为「构建产物」：需要 `git rm` 旧文件、加 `.gitignore`、更新 `tests/desktop-package.test.js` 的断言目标（改为断言源码入口与构建脚本），并在 CI `tauri build` 前插入构建步骤。
- 接入弹窗拆成两个命令而非在 Rust 侧异步推送：前端拿到路径即可弹窗，不需要新的事件通道与权限声明，改动面最小。
- 控件高度取 32px 主档：与 `Select` 现有默认一致，改动集中在 `Input`/`Button` 默认值与页面层覆盖清理，页面按 `h-8` 写死的代码删除后自然对齐。

## Risks

- 客户端迁移是「重写两个窗口的全部交互」，`control.js` 的 4 类确认流程（`assignment_warning`/`remote_overwrite`/`initial_sync_review`/`task_file_conflict`）与 750ms 轮询、`live_control_*` 载荷必须逐条对齐，回归风险最高 → 迁移后逐流程手工走查（含 diff 对比视图、`overwrite-server` 二次确认、initial review 逐项下拉）。
- `tauri.conf.json` 的 CSP 为 `style-src 'self'`：React 通过 CSSOM 设置样式不受影响，但禁止引入 `style` 字符串注入/`dangerouslySetInnerHTML` 内联样式方案。
- `desktop/ui/` 变为构建产物后，忘记先构建会得到空白窗口或旧产物 → CI 与本地脚本固定 `build:desktop` → `tauri build` 顺序，并在 `desktop/README.md` 写明。
- 控件高度收敛会改变既有页面密度，可能出现换行/溢出 → 逐页截图验收，不改 token 与间距体系，只动高度档位。
- 两个 Rust 任务同源文件：与 `11-12-rust-desktop-agent-single-exe` 的时序冲突是本父任务最大工程风险，靠 Dependencies 的串行顺序规避。
