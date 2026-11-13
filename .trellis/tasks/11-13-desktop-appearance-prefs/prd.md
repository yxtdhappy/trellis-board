# 客户端外观偏好跨 origin 持久化

## Goal

桌面客户端把主题/字号偏好写入客户端数据目录，通过 Tauri IPC 在所有 Board origin 之间共用，修复换地址或重开客户端后设置丢失。

## Background

- 现状：外观偏好只存在 `localStorage`（键 `trellis-theme` / `trellis-font-size`），`apps/web/public/theme-init.js` 首屏读取，`apps/web/src/app/theme.tsx` 的 `AppearanceProvider` 在状态变化时回写。
- 已核实：同一 origin 内持久化完全正常（真实界面点「深色」「特大」→ 杀进程重启 → 仍是 20px）。
- 丢失机制：`localStorage` 按 origin 隔离，而桌面客户端允许连接不同地址（`desktop_login` 的 `force_new` 分支即承认换地址）。真实 WebView2 存储里同时存在 `http://192.168.65.27:4317`（theme=light、font=lg）与 `http://127.0.0.1:4317`（仅 theme）两份记录，换地址即等于换一份偏好。
- 产品语义：对话框文案为「外观设置保存在本机」，因此偏好应属于**设备**，而不是某个 origin。

## Requirements

- R1 客户端内修改主题或字号后，偏好写入客户端数据目录 `appearance.json`（`config::data_dir()`，可用 `TRELLIS_DESKTOP_HOME` 覆盖），内容为 `{ "theme": ..., "fontSize": ... }`。
- R2 桌面客户端内**所有页面**都以设备偏好为准校正外观：远程 Board 页面（任意 origin、任意端口、任意主机名）与客户端自带页面（`apps/desktop/ui/index.html` 登录页、`control.html` 实时同步控制窗口）。校正后同步回当前 origin 的 `localStorage`。
- R3 浏览器（无 `window.__TAURI__`）行为不变：仍只用 `localStorage`，不发起任何 Tauri 调用，不产生错误。
- R4 文件缺失、损坏或值非法时回落到 `system` + `md`，不得抛错阻断页面渲染。
- R5 写偏好只允许「当前已登录的 Board origin」调用（capability 白名单 + `ensure_board_caller`）；客户端自带页面（登录页、实时同步控制窗口）只获得读取权限，且挂载时的自动写入不得覆盖设备偏好。
- R6 不改变现有 `localStorage` 键名与 `dataset.theme` / `dataset.fontSize` 契约，旧数据继续作为首屏快速路径。

## Acceptance Criteria

- [ ] AC1：客户端在 `http://127.0.0.1:4399` 设为 深色 + 特大 → 关闭客户端 → 把 `client.json` 的 `serverUrl` 改为另一个 origin（如 `http://localhost:4399`）重开 → 页面 `document.documentElement` 为 `dataset.theme=dark`、`dataset.fontSize=xl`、根字号 20px，`appearance.json` 内容一致。
- [ ] AC2：反向验证：在第二个 origin 改回 浅色 + 标准 → 回到第一个 origin（其 `localStorage` 仍是 dark/xl）→ 仍显示 light/md，证明设备偏好优先于 origin 旧值。
- [ ] AC3：客户端自带页面跟随设备偏好：设备偏好为 深色 + 特大时，冷启动停在登录页（`tauri.localhost`）与打开实时同步控制窗口，均为 `dataset.theme=dark`、`dataset.fontSize=xl`、根字号 20px；登录页不写设备偏好（`appearance.json` 内容不被挂载覆盖）。
- [ ] AC4：浏览器直接打开 Board（无 `__TAURI__`）：localStorage 偏好照常生效，控制台无 invoke 报错。
- [ ] AC5：`appearance.json` 写入 `{"theme":"neon","fontSize":"huge"}` → 加载回落到 `system`/`md`，UI 正常。
- [ ] AC6：Rust 单测覆盖 非法值归一、读写往返、文件损坏回落；`cargo test` 通过。
- [ ] AC7：`permissions/desktop.toml` 新增的权限归属正确：`allow-appearance-load` 授予 `board-local-association` + `main` + `live-control`，`allow-appearance-save` 只授予 `board-local-association`；现有静态契约测试通过。
- [ ] AC8：`npm test`（仓库既有用例）与 `oxfmt --check` 通过。

## Non-Goals

- 不做服务端用户偏好 API（跨设备/跨浏览器同步）。
- 不做浏览器内跨 origin 共享。
- 不在客户端自带页面上提供修改外观的入口（登录页/控制窗口只读取并应用设备偏好）。

## Known Trade-offs

- 新 origin 首次加载会先按 `theme-init.js`（该 origin 的 `localStorage`，可能为空）渲染一帧，再被 `appearance_load` 校正；校正后 `localStorage` 同步写入，后续加载无闪烁。若实测闪烁明显，再补 init-script 注入。

## Notes

- 现有外观功能来源：`f58750a feat(web): add appearance preferences for theme and root font size`，设计文档 `.trellis/tasks/archive/2026-11/11-13-appearance-settings/design.md`。
