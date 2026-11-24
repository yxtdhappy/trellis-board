# 废弃桌面 plugins.json 并暴露登录用户 core 能力

## Goal

1. 将当前登录用户信息（`userId`、`username`、`displayName`、`serverUrl` 等）作为宿主 plugins core 能力（`trellis.user`）统一暴露给所有插件，同时提供 `trellis.projects.developers` 能力并修复 `readDeveloper` 解析 `.trellis/.developer` `name=` 的问题；
2. 废弃桌面端 `%LOCALAPPDATA%\TrellisBoard\data\desktop-plugins\<hash>\<user>\plugins\plugins.json` 用户配置文件，改由宿主内部极简 `<scope>/plugin-state.json`（仅保存 `{ id, enabled, sort }`，零用户 `config`）管理启用开关与排序，并对旧 `plugins.json` 做一次性静默迁移；
3. 改造 `witops-core` 的负责人解析、结构化诊断与面板下发交互，自动关联「当前登录 Trellis 用户 + WitOps 登录账号 + 目标仓库 `.trellis/.developer`」，通过 `ctx.store` 持久化映射，彻底解决 `任务缺少负责人，跳过下发` 与用户手工编辑 JSON 配置的痛点。

## Confirmed Codebase Facts

- **宿主 core capability 模型**（[core-capabilities.js:14-45](../../../packages/server/plugins/core-capabilities.js#L14-L45)）：
  - 已注册 `trellis.capabilities`、`trellis.projects`、`trellis.repositories`，通过 `requires` + permission 校验与 `capability/call` 统一暴露给插件。
  - [core-capabilities.js:99-108](../../../packages/server/plugins/core-capabilities.js#L99-L108) 的 `readDeveloper(repositoryPath)` 当前直接读取 `.trellis/.developer` 整段文件文本（包含 `name=...\ninitialized_at=...`），未按 `name=` 精确提取开发者名。
- **桌面插件宿主现状**（[plugin_host.rs:157-260](../../../packages/desktop/src-tauri/src/plugin_host.rs#L157-L260)、[plugin_host.rs:385-450](../../../packages/desktop/src-tauri/src/plugin_host.rs#L385-L450)、[plugin_host.rs:628-720](../../../packages/desktop/src-tauri/src/plugin_host.rs#L628-L720)、[host.mjs:191-260](../../../packages/desktop/plugin-host/host.mjs#L191-L260)）：
  - 桌面端在 `<scope>/plugins/plugins.json` 持久化内置插件的 `enabled`、`sort`、`module` 与 `config`，每次启动和启停都会读写该文件；
  - Rust 侧在登录与 `current_scope()` 中已掌握当前用户的 `server_url` 与账号标识；
  - `PluginSupervisor`（[supervisor.js:66-120](../../../packages/server/plugins/supervisor.js#L66-L120)）当前仅从 `configFile` 加载插件清单。
- **`witops-core` 登录、负责人解析与面板现状**（[auth.js:85-88](../../../plugins/witops-core/auth.js#L85-L88)、[mapper.js:107-119](../../../plugins/witops-core/mapper.js#L107-L119)、[dispatch.js:557-674](../../../plugins/witops-core/dispatch.js#L557-L674)、[panel/app.js:602-743](../../../plugins/witops-core/panel/app.js#L602-L743)）：
  - 登录成功后 `session` 已持有 `userId` 与 `account`，但未关联到目标仓库 `.trellis/.developer` 或当前登录的 Trellis 用户；
  - `resolveAssignee` 仅查 `config.developerMap` 和 `config.assignee`，零配置时直接命中 `任务缺少负责人，跳过下发`；
  - 面板下发预览/创建弹窗只读展示 `draft.assignee`，缺少选择/修改目标仓库开发者并记住映射的入口。

## Requirements

- **REQ-1 Core Capability `trellis.user` 与 `trellis.projects.developers`**：
  - `packages/server/plugins/core-capabilities.js` 新增 `trellis.user`（`current` 方法，权限 `user:read`），返回当前登录用户信息 `{ userId, username, displayName, serverUrl }`（桌面端由 `plugin_host.rs` → `host.mjs` 传入，Team 服务端兼容 `actorContext`，不包含任何密码、token 或 Cookie）。
  - `trellis.projects` 新增 `developers` 方法（权限 `projects:read`），返回目标仓库的 `{ repositoryId, currentDeveloper, developers }`（解析 `.trellis/.developer` 的 `name=` 并安全扫描 `.trellis/workspace/` 合法目录）；同步修复 `readDeveloper()` 仅提取 `name=` 值。
- **REQ-2 废弃桌面端 `plugins/plugins.json`**：
  - `packages/desktop/src-tauri/src/plugin_host.rs` 与 `packages/desktop/plugin-host/host.mjs` 改用 `<scope>/plugin-state.json`（仅 `{ version: 1, plugins: [{ id, enabled, sort }] }`），不再创建或写入 `<scope>/plugins/plugins.json`。
  - 老用户升级时，首次启动若存在旧 `<scope>/plugins/plugins.json` 且尚未生成 `plugin-state.json`，自动迁移 `enabled`/`sort`（并将旧 `plugins.json` 重命名为 `plugins.json.migrated`，如其中存在 `developerMap` 也可保留迁移读取通道）；
  - `PluginSupervisor` 新增可选内存清单提供器 `entriesProvider`（保留 `configFile` 兼容供服务端及既有测试使用），桌面宿主不再把 `plugins.json` 落盘。
- **REQ-3 `witops-core` 零配置负责人自动关联与可溯源诊断**：
  - `witops-core` 在 `plugin.json` 声明 `user:read` 权限与 `trellis.user`、`trellis.projects` 依赖；
  - 升级负责人 5 级解析链：
    1. 下发请求显式传入 `assignee`（最高优先级）；
    2. `ctx.store` 已记住的映射（`witopsUserId -> trellisDev`）；
    3. 当前登录 WitOps 用户（`session.userId` 命中任务负责人）自动匹配目标仓库 `.trellis/.developer`（若无则尝试 `trellis.user.username` 匹配 `.trellis/workspace/`），匹配后自动记入 `ctx.store`；
    4. 按 WitOps 负责人姓名/账号匹配目标仓库 `.trellis/workspace/` 列表；
    5. 旧 `config.developerMap` / `config.assignee` 只读兜底兼容；
  - 仍未命中时，返回结构化诊断信息（`missing-assignee`，附带 `witopsUserId`、`witopsAssignee`、`repositoryId`、`currentDeveloper`、`availableDevelopers` 与清晰中文提示），不再仅靠日志静默跳过。
- **REQ-4 `witops-core` 面板下发负责人选择**：
  - 新增 `GET /developers?repositoryId=...` 与 `PUT /developer-bindings` 路由；
  - 面板 `plugins/witops-core/panel/app.js` 在下发预览/确认弹层直接展示推导出的 Trellis 负责人，支持下拉选择目标仓库 `.trellis/workspace/` 中的合法开发者，并可选「记住映射」写入 `ctx.store`。

## Out of Scope

- 不删除随安装包分发的插件代码清单 `plugins/<id>/plugin.json`（Manifest）。
- 不破坏 `packages/server/plugins/` 既有基于 `configFile` 的宿主级插件测试契约。
- 不在本任务内强制改造 `witops-core` 之外其他内置插件的面板逻辑（其它插件可通过 `trellis.user.current` 按需读取登录用户）。

## Acceptance Criteria

- [ ] **AC-1**：`trellis.user.current` 在声明 `user:read` 权限后返回当前登录用户信息（不含凭据）；未声明权限时拒绝调用（`PERMISSION_DENIED`）；`trellis.projects.developers` 与 `readDeveloper` 正确解析 `.trellis/.developer` 的 `name=` 并安全枚举 `.trellis/workspace/` 目录。
- [ ] **AC-2**：桌面插件宿主使用 `<scope>/plugin-state.json` + 内存 `entriesProvider`，不再生成或写入 `<scope>/plugins/plugins.json`；旧 `plugins.json` 在无 `plugin-state.json` 时自动迁移 `enabled`/`sort` 并改名为 `plugins.json.migrated`。
- [ ] **AC-3**：`witops-core` 在零手工配置场景下，基于当前登录 WitOps 用户、`trellis.user` 与目标仓库 `.trellis/.developer` 自动解析负责人并下发任务；未命中时返回包含 `availableDevelopers` 与清晰中文原因的结构化结果，不再只留静默跳过日志。
- [ ] **AC-4**：`witops-core` 面板支持在预览/下发弹窗查看并改选负责人，并通过 `PUT /developer-bindings` 持久化到 `ctx.store`，后续同研发任务自动复用。
- [ ] **AC-5**：服务端宿主测试、插件测试（`yarn test --scope=all`）全部通过，改动文件通过 `oxfmt --check` 与 LF 行尾检查，且同步更新 `.trellis/spec/` 文档。
