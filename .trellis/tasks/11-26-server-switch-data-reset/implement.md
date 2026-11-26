# 实施计划：切换服务器地址时备份并清理客户端数据

> 前置：`prd.md` 与 `design.md` 已获用户确认后才执行 `task.py start`。
> 全程不执行构建，最后一步统一编译一次（全局规则）。

## 步骤

### S1 Rust：新增 `client_reset` 模块（纯逻辑）

1. 新建 `packages/desktop/src-tauri/src/client_reset.rs`：
   - `RESET_ITEMS`、`BACKUP_PREFIX`、`KEEP_BACKUPS`；
   - `server_switched`、`backup_root`、`backup_dir_name`；
   - `backup_and_clear`（复制 → 删除 → prune）、`restore`、`prune_backups`；
   - 内部 `copy_tree`、`remove_with_retry`、`copy_back` 辅助函数。
2. `main.rs` 增加 `mod client_reset;`。
3. 新建 `client_reset/tests.rs`（`#[cfg(test)] #[path = "client_reset/tests.rs"] mod tests;`），覆盖 `design.md §9` 列出的用例。

验收：模块可被 `main.rs` 引用；测试用例齐全（本机不跑 cargo，CI 结果为准）。

### S2 Rust：命令与登录流程

1. `main.rs` 新增 `LoginPreflight` 结构体与 `desktop_login_preflight` 命令（`ensure_local_caller`）。
2. `desktop_login` 增加 `switch_server: Option<bool>` 参数：
   - 计算 `normalized` / `previous` / `switched`；
   - `switched && switch_server != Some(true)` → 返回需确认错误；
   - 切换分支：`plugin_host::stop` → `client_reset::backup_and_clear`；
   - 登录失败 → `client_reset::restore` + 错误文案带备份路径；
   - 登录成功 → `config::save` 用切换前的 runtime 标记；`prune_backups`。
3. `generate_handler!` 注册 `desktop_login_preflight`。
4. `main/tests.rs` 补充 `server_switched` 归一化用例（若逻辑放在 `client_reset`，则测试放 `client_reset/tests.rs`，避免重复）。

验收：`desktop_login` 非切换路径逻辑与原实现等价（runtime 标记来源除外，已确认等价）。

### S3 权限与 capability

1. `permissions/desktop.toml` 增加 `allow-desktop-login-preflight`。
2. `capabilities/main.json` 增加 `allow-desktop-login-preflight`。
3. `board-local-association.json` 保持不变。

验收：静态契约测试通过；远程 Board capability 中没有该命令。

### S4 前端登录页

1. `packages/web/src/desktop/main-index.tsx`：用 `ConfirmDialogProvider` 包裹 `LoginApp`。
2. `packages/web/src/desktop/LoginApp.tsx`：
   - `submitLogin` 先调 `desktop_login_preflight`；
   - `requiresReset` 时 `useConfirm()` 弹窗（文案见 `design.md §5`）；
   - 取消 → 复位 `submitting`、不发登录请求；确认 → `desktop_login` 带 `switchServer: true`；
   - preflight 参数与登录参数使用同一个 trim 后的地址。
3. 同步更新登录页底部说明文案中与「切换服务器」相关的提示（如有必要，最小改动）。

验收：`yarn test --scope=lint` 通过（`tsc -b --noEmit` + oxlint + oxfmt）。

### S5 静态契约测试

1. 新建 `packages/desktop/test/client-reset-contract.test.js`（node:test）：
   - `main.json` 含 `allow-desktop-login-preflight`，`board-local-association.json` 不含；
   - `permissions/desktop.toml` 声明；
   - `main.rs` 注册命令且 `desktop_login` 接收 `switch_server`；
   - `LoginApp.tsx` 调用了 `desktop_login_preflight`，且 `desktop_login` 调用点存在 `switchServer` 分支。

验收：`node --test packages/desktop/test/client-reset-contract.test.js` 通过。

### S6 验证与交付

1. `yarn test --scope=desktop`
2. `yarn test --scope=lint`
3. 全部开发完成后执行一次 `node scripts/build.mjs --target=desktop-ui`
4. Rust：`cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` 交由 CI；本地不得声称通过。
5. 更新 `.trellis/spec/desktop/tauri-commands/index.md`：新增「切换服务器地址前备份并清理本地数据」场景（契约、错误矩阵、测试要求）。
6. 手工 E2E（需要 Windows 桌面构建，若本地无构建产物则写明未验证）。

## 复核关卡

| 关卡 | 内容 |
| --- | --- |
| G1（S1/S2 后） | 读 diff 确认：只删 `RESET_ITEMS`；失败路径一定 restore；runtime 标记保留 |
| G2（S3/S4 后） | 确认本地页 capability 与远程 Board capability 分离；取消路径零副作用 |
| G3（S6 前） | 全量验证结果 + spec 更新 + 未验证项（Rust 本机）显式列出 |

## 回滚点

- S1–S2 可独立回滚（不影响前端）。
- S3–S5 一起回滚（capability 与前端调用必须同进同退）。
- 数据侧：`data-backup-*` 保留，手工可恢复。
