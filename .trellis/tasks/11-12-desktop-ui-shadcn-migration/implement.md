# Implement: 客户端 UI 迁移到 React + shadcn

## 前置

- 确认 `11-12-web-controls-unification` 已归档（控件三档尺寸定稿）。
- 确认 `11-12-rust-desktop-agent-single-exe` 已归档（`desktop/ui/setup.js` 环境门 UI 不再被改）。
- 从 `git status` 确认 `desktop/ui/**`、`desktop/src-tauri/src/main.rs` 无未提交改动再动手。

## 步骤

1. **通读旧实现**：`desktop/ui/index.html`、`setup.js`（267 行，全部函数）、`styles.css`、`control.html`、`control.js`（422 行）、`control.css`。把函数清单抄成 checklist（`readStatus`、`showLogin`、`renderRuntime`、`markSteps`、`validateInput`、`setSubmitting`、`refresh`、`render`、`runAction`、`appendDiff`、`appendInitialDifference`、`button`）。
2. **构建链**：新增 `web/vite.desktop.config.ts`、`web/desktop/{index,control}.html`、`web/src/desktop/desktop.css`；`web/package.json` 加 `build:desktop`；`.gitignore` 加 `desktop/ui/`；`git rm -r --cached desktop/ui` 并删除旧文件。
3. **适配层**：`web/src/desktop/tauri.ts`（`invoke`/`listen` 封装 + 全局类型）。
4. **登录/环境页**：`LoginApp.tsx` 按状态机实现；用 `Card`/`Progress`/`Button`/`Input`/`Label`/`Badge` + lucide 图标；文案与旧文件逐字对齐（「首次启动环境检查」「正在检查运行环境…」「安装运行环境」「重新检查」「正在登录…」等）。
5. **实时确认窗**：`ControlApp.tsx` 轮询 + 四类事件；diff 视图双栏；`overwrite-server` 二次确认；`close` 走 `live_control_dismiss` 后立刻 `refresh()`。
6. **清理**：删 `desktop/ui/*` 旧源码；确认无 `desktop/ui` 引用残留在脚本/测试之外。
7. **测试/CI/文档**：按 `design.md` 更新 `tests/desktop-package.test.js`、`.github/workflows/windows.yml`、`desktop/README.md`、`.trellis/spec/backend/desktop-sidecar-packaging.md`（若描述 `desktop/ui` 形态）。
8. **验证**：
   ```
   pwsh> npm --prefix web run build:desktop
   pwsh> cargo run --manifest-path desktop/src-tauri/Cargo.toml
   pwsh> npm test
   pwsh> npm --prefix web run lint
   ```
   手工路径：无环境 → 环境检查 → 安装（或已有环境直达登录）→ 登录 → Board → 触发四类控制事件（可用「暂停同步/修改本地文件」制造 `task_file_conflict`）→ diff → overwrite 确认 → dismiss。

## 验收要点（逐条勾）

- [ ] `desktop/ui/index.html`、`desktop/ui/control.html` 由构建产出，含 `assets/*.js|css`
- [ ] 登录卡片视觉与 web `/login.html` 一致（圆角 `--radius`、紫色主按钮、Inter 字体）
- [ ] 环境步骤条 5 步状态正确（等待/进行中/完成/失败），安装百分比正常
- [ ] 自动登录仅触发一次，失败后停在表单并显示错误
- [ ] 控制窗空态 / 四类事件 / diff / overwrite 二次确认 / dismiss 全部正常
- [ ] `npm test` 断言已指向新源码且通过
- [ ] CI 在 `tauri build` 前执行 `build:desktop`

## 注意

- 不改 Rust 逻辑；窗口尺寸需要时才动，并在提交说明里写原因。
- 不引入新依赖；图标只用 `lucide-react` 已有导出。
- 不为客户端加路由/状态库；两个入口各自一个 `createRoot`。
