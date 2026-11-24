# Implementation Plan

先读：`.trellis/spec/desktop/tauri-commands/index.md`、`.trellis/spec/guides/{cross-layer,code-reuse,module-size}-*.md`。

1. [x] 调研并写入 `research/`：`tauri-plugin-deep-link` 在 Windows 的注册方式（安装包/便携包）、与 single-instance 的组合用法；确认 `GET /api/tasks/<key>` 对归档任务的返回行为。
2. [x] Web 纯函数 `src/lib/share-link.ts` + `test/share-link.test.js`：URL 构建/解析、编码、非法参数、origin 归一比较。
3. [x] 中转页：`packages/web/share.html` + `src/share.ts`，加入 `vite.config.ts` 的 `build.rollupOptions.input.share`；自动唤起、按钮重试、复制协议链接、参数错误文案；确认生产构建后 `packages/server/public/share.html` 由 `serveStatic` 免登录返回。
4. [x] 分享入口：`TaskDetailDialog.tsx` 与 `TaskCard` 加分享按钮（复用现有复制/剪贴板工具与 toast），桌面端与浏览器一致。
5. [x] 桌面：`share_link.rs` + 单测（非法 scheme/host、缺参、超长、非法 server、重复触发幂等）；引入 deep-link 插件并注册 `spec-board`；冷启动/single-instance/deep-link 统一派发；`pending_share`、`take_pending_share_link` + `permissions/desktop.toml` + capability + `ensure_board_caller`；`desktop_logout` 清空暂存。
6. [x] `useShareLinkOpen` 接入 `BoardPage.tsx`（先监听后读取、origin 比对、列表未命中走单任务接口、错误 toast）。
7. [x] 静态契约测试：`packages/desktop/test/desktop-ui-build.test.js` 增加命令/权限成对断言。
8. [x] 更新 spec：`tauri-commands/index.md` 新增“任务分享链接”场景；必要时更新跨层契约。
9. [x] 验证：`yarn test`；`cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`；变更文件跑 Prettier/ESLint；生产构建后浏览器直开 `/share.html?...`（http 与 https 两种部署各验一次生成的链接协议）；Windows 实机（`trellis-board-e2e`）覆盖：已运行、冷启动、未登录、server 不一致、无权限、飞书内打开。

   已完成部分见下方「验证结果」；https 部署、未登录点击、origin 不一致、无权限任务、飞书 webview 未覆盖。格式化/lint 实际用 oxfmt + oxlint（仓库没有 Prettier/ESLint 配置）。

回滚点：步骤 5 后桌面侧可独立回退；中转页、Web 入口、服务端互不依赖。

## 验证结果（2026-11-24）

- `cargo test --bin trellis-board-client share_link`：4 passed。
- `node --test packages/web/test/share-link.test.js`：5 passed；`node --test packages/desktop/test/desktop-ui-build.test.js`：10 passed。
- `yarn build --target=web` / `--target=desktop-ui` 通过；生产构建产物 `packages/server/public/share.html` 免登录返回 200。
- 格式化/lint：仓库用 oxfmt + oxlint（无 Prettier/ESLint 配置），变更文件 `oxfmt --check` 干净、`oxlint` 无新增告警。
- Windows 实机（隔离数据目录 + 本地代理记录请求）：运行中触发链接、客户端未运行时触发链接均打开目标任务；非法链接被忽略并记 warn。
- 未覆盖：https 部署、未登录点击、链接 origin 与当前 Board 不一致、无权限任务、飞书 webview 内点击、真实任务详情弹窗的视觉验收（本机没有可用登录凭据）。
- 复审整改：`main.rs` 原已 1223 行超过 1200 上限，本次把托盘菜单 `autostart_enabled` + `build_tray` 拆到 `packages/desktop/src-tauri/src/tray.rs`（`tray::build`），main.rs 回到 1162 行，符合「超限文件不得新增行」；`useShareLinkOpen` 补「读取期间又来链接就再取一次」与 `listen` 失败的 `.catch`；静态核对后 `cargo check`、`cargo test share_link`、`tsc -b`、`node --test`（15/15）、oxfmt/oxlint 全绿，托盘拆分后再实机启动一次确认协议注册与进程存活。
- Review 问题全量整改与基线同步（2026-11-24）：快进同步 `origin/main`（`ebca773`）并将自动更新逻辑合并至 `tray.rs` 与 `main.rs`；Rust 侧新增 `PendingShare::{Target, Invalid}` 使非法链接触发前端明确错误提示（不覆盖未消费合法目标），并补齐状态机与序列化单测；Web 侧 `useShareLinkOpen` 补齐 `active` 卸载守卫、`mustChangePassword` 改密门控与改密后自动续开、改用纯 query `/api/tasks?taskSpaceId=&executionTaskKey=` 避开 `%2F` 反代截断；`share.html`/`share.ts` 补控制字符校验、复制失败提示与飞书内置浏览器引导；`Kanban` 子任务行增加 `ShareTaskButton`；将弹窗底部拆至 `TaskDetailFooter.tsx`；补强 `desktop-ui-build.test.js` 契约断言并统一任务目录 LF 行尾。
