# 实施计划：客户端外观偏好跨 origin 持久化

## 步骤

1. **Rust 模块** `apps/desktop/src-tauri/src/appearance.rs`
   - `Appearance` 结构 + `Default` + `normalised()` + `appearance_path()` + `load()` + `save()`
   - `#[cfg(test)] mod tests`：默认值、非法值归一、往返、损坏文件回落（临时目录 + `TRELLIS_DESKTOP_HOME`）
2. **命令与注册** `apps/desktop/src-tauri/src/main.rs`
   - `mod appearance;`
   - `appearance_load` / `appearance_save`（`ensure_board_caller`）
   - 加入 `invoke_handler` 列表
3. **权限** `apps/desktop/src-tauri/permissions/desktop.toml` + 三个 capability
   - `allow-appearance-load` → `board-local-association.json` + `main.json` + `live-control.json`
   - `allow-appearance-save` → 仅 `board-local-association.json`
4. **Web 桥接** `apps/web/src/app/theme.tsx`
   - `desktopInvoke()` 探测、挂载加载（`touched` 保护）、`touched` 前提下的保存 effect
5. **客户端自带页面** `apps/web/src/desktop/main-index.tsx`、`main-control.tsx`
   - 用 `AppearanceProvider` 包裹 `LoginApp` / `ControlApp`
6. **格式化与静态检查**
   - `oxfmt` 格式化改动文件；`npm run lint --workspace @trellis-board/web`
7. **Rust 测试**
   - `cargo test`（在 `apps/desktop/src-tauri`）
8. **真实客户端验收（.tmp-verify e2e 夹具）**
   - 起 4399 服务 → 客户端 c1 登录 → 设 深色 + 特大 → 关闭 → 改 `client.json` serverUrl 为 `http://localhost:4399` → 重开 → 读 `dataset`/`appearance.json`（AC1）
   - 在 `localhost:4399` 改回 浅色 + 标准 → 改回 `127.0.0.1:4399` 重开 → 仍 light/md（AC2）
   - 清空客户端凭据后冷启动停在登录页（`tauri.localhost`），读 `dataset.theme/fontSize` 与计算字号；对比 `appearance.json` 未被覆盖（AC3）
   - 删除/损坏 `appearance.json` → 回落 system/md（AC5）
9. **清理**
   - 删除 `.tmp-verify/` 临时脚本与客户端数据目录

## 验收映射

| AC | 验证方式 |
| --- | --- |
| AC1 / AC2 | e2e 客户端跨 origin 重启，读 `document.documentElement.dataset` 与 `appearance.json` |
| AC3 | 冷启动停在登录页 + 打开控制窗口，读 `dataset`/计算字号，并比对 `appearance.json` 未变 |
| AC4 | 浏览器直开 4399 Board，确认无 invoke 报错 |
| AC5 | 手工写非法 `appearance.json` 后重启 |
| AC6 | `cargo test` |
| AC7 | 读 capability/权限文件 + 既有静态契约测试 |
| AC8 | `npm test` + `oxfmt --check` |

## 验收记录（2026-11-13，隔离 e2e）

环境：隔离端口 4461、CDP 9341/9342、`TRELLIS_DESKTOP_HOME=.tmp-appearance/clients/c*`、独立 target `C:\projects\_trellis-board-appearance-target`，未触碰另一任务的 4399 `.tmp-verify/`。

| AC | 结果 | 证据 |
| --- | --- | --- |
| AC1/AC2 | 通过 | `127.0.0.1:4461` 用界面设 `light/sm` → `appearance.json` = `{"theme":"light","fontSize":"sm"}`；杀进程改 serverUrl 为 `http://localhost:4461` 重启 → 板页 `light/sm/14px`；再设 `dark/xl` → 切回 `127.0.0.1:4461` 重启 → `dark/xl/20px`，即使该 origin 的 localStorage 仍是旧值 `light/sm` |
| AC3（登录页） | 通过 | 新 HOME（无 client.json）+ `appearance.json`=`dark/xl` → `http://tauri.localhost/` 显示 `dark/xl/20px`；把该 origin 的 localStorage 改成 `system/md` 后 reload 仍是 `dark/xl`，证明设备偏好覆盖 origin 存储 |
| AC3（控制窗口） | 静态验证 | `live-control.json` 授予 `allow-appearance-load`；`main-control.tsx` 已用 `AppearanceProvider` 包裹；`apps/desktop/ui/assets/tauri-*.js` 含 `appearance_load`。真实控制窗口需 sidecar 触发 live-control 事件，本轮未端到端触发 |
| AC4 | 通过（修正） | 首轮界面操作未落盘的原因：服务端 `apps/server/public` 在我运行期间被另一任务重建，页面加载的是旧哈希 `main-D0WuRJKN.js`（缺桥接）。reload 到当前 `main-CiU6n6jH.js` 后，界面操作立即写盘 |
| AC5 | 通过 | 写入 `{"theme":"neon","fontSize":42`（截断 JSON）后重启 → `system/md/16px`，文件未被改写 |
| AC7 | 通过 | 板页 `invoke('appearance_save')` 成功；登录页（`tauri.localhost`）同调用被拒：`尚未登录 Board` |
| AC8 | 通过 | `npm test`：436 tests / 434 pass / 0 fail / 2 skipped；`oxfmt --check` 三个 TS 文件通过；`cargo fmt --check` 仅报既有 `src/agent/detach.rs:292/307` 差异 |
| 挂载不回写 | 通过 | `appearance_load` 校正后 `appearance.json` mtime 不变（`touched` 门控生效） |

## 回滚

删除 `appearance.rs`、两个命令、两个权限项与三个 capability 条目；`theme.tsx` 移除桥接代码，`main-index.tsx` / `main-control.tsx` 去掉 `AppearanceProvider` 包裹。`appearance.json` 为新增文件，删除即可，不影响既有 `localStorage` 行为。
