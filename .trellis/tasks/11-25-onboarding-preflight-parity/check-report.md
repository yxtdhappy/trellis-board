---
mode: inline-self-check
agent: main-session
session: 9a3b71f6-1783-4edf-957c-7d0bf6530c94
commit:
---

# 自检报告：11-25-onboarding-preflight-parity

## 质量检查汇总

1. **服务端测试**
   - `node --test packages/server/test/team-task-spaces.test.js packages/server/test/team-gitless-http.test.js packages/server/test/team-task-snapshot.test.js packages/server/test/team-task-control.test.js`：68 passed, 0 failed。
   - `yarn test`（含 `team-*`、桌面构建、`onboarding-probe.test.js` 等全部 Node 测试）：742 passed, 7 skipped（既有环境跳过）, 0 failed。
2. **桌面端 Rust 检查与测试**
   - `cargo clippy --manifest-path packages/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`：通过（0 warnings）。
   - `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`：421 passed, 0 failed（含预检过滤、`stop()` 释放 `Arc` 防双传、`overwrite-server` 写栅栏与 `suppressed` 更新、`reopen_conflicts` 标题回退新增测试）。
3. **Web 前端类型检查、构建、Lint 与组件复用审计**
   - `yarn build`（`tsc -b && vite build`）与 `yarn build --target=desktop-ui`：均通过。
   - `yarn workspace @trellis-board/web exec oxlint src/features/board/dialogs/project-onboarding-types.ts src/features/board/dialogs/project-onboarding-normalize.ts src/features/board/dialogs/ProjectOnboardingDialog.tsx src/components/layout/ProjectRail.tsx`：0 errors（5 条为既有 `useEffect` 警告）。
   - `component-reuse.md` 审计正则检查变更前端文件：无裸 `<button>`、无硬编码颜色或 `bg-*-soft`、无禁止标签，差异徽章使用 `StatusPill` 与既有语义 token。
   - 前端交互 UI 渲染通过 `ProjectOnboardingDialog.tsx`、`ProjectRail.tsx` 与 `normalizePreflight`/`normalizeAssociation` 单元测试及 `tsc -b` + `vite build` 静态验证；尚未在真实 Windows Tauri 桌面窗口中人工点击回归。
4. **格式化与行尾检查**
   - `npx oxfmt --check <全部变更 JS/TS/TSX 文件>`：通过。
   - `git ls-files --eol` 检查 `i/crlf`：0 个文件。
