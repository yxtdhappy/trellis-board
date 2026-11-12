# Implement: 接入本地项目 dialog 即时弹出

## 步骤

1. **Rust 命令拆分**（`desktop/src-tauri/src/main.rs`）
   - 新增 `pick_local_project_folder`（见 `design.md` 代码块），放在 `inspect_local_project` 之前。
   - 改写 `inspect_local_project`：签名加 `path: String`，返回 `Result<serde_json::Value, String>`；保留「先清 pending → inspect → 写 pending」顺序。
   - `tauri::generate_handler![...]`（`main.rs:853`）插入 `pick_local_project_folder`。
2. **权限**：`permissions/desktop.toml` 加 `allow-pick-local-project-folder`；`capabilities/board-local-association.json` 引用它。
3. **前端接线**（`web/src/components/layout/ProjectRail.tsx`）：`onboardingProject` → `onboardingPath`；先 pick 后开窗。
4. **弹窗三态**（`web/src/features/board/dialogs/ProjectOnboardingDialog.tsx`）：props 改 `path`；加 `loading/loadError/reloadToken` 与 inspect effect；skeleton 与错误块；`handleOpenChange` 允许 loading 期关闭并清理 pending。
5. **测试与文档**：`tests/desktop-package.test.js` 已在 `11-12-rust-desktop-agent-single-exe` 中删除，无需再改；`desktop/README.md` 的接入流程与命令清单补 `pick_local_project_folder`。
6. **验证**：`cargo check`/`cargo test` → `npm --prefix web run lint`/`build` → `npm test` → `cargo run` 手工走查（正常/取消/失败/慢仓库四种路径）。

## 顺序约束（重要）

- 与进行中的 `11-12-rust-desktop-agent-single-exe` 共享 `main.rs`：本任务只做**新增命令 + 参数化**，不要顺手改 sidecar/agent 内部实现。
- 若该任务的 in-process Rust agent 先落地，`inspect_project` 的调用点需同步替换为等价 Rust 函数，但命令名/参数/返回结构保持本 PRD 定义。
- 若双方同时在场：先合并 Rust 重写，再应用本任务的两处命令改动，避免 `main.rs` 冲突。

## 验收脚本（手工）

```
pwsh> cargo run --manifest-path desktop/src-tauri/Cargo.toml
# 登录 → Board → 侧栏「接入本地项目」
# 1) 选目录后 <100ms 出现骨架；2) 数据回来变表单；3) 期间可取消
# 4) 选非 git 目录 → 错误 + 重试；5) 全流程关联成功
```

## 断言命令

```
pwsh> Select-String -Path web/src/components/layout/ProjectRail.tsx -Pattern "pick_local_project_folder"
pwsh> Select-String -Path desktop/src-tauri/permissions/desktop.toml -Pattern "pick_local_project_folder"
pwsh> npm test
```
