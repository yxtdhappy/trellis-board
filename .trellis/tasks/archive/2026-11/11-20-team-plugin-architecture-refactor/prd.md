# PRD: 团队版主线插件体系改造（服务器默认屏蔽、6 大插件入驻 EXE 与极简配置）

## Goal

围绕当前唯一持续演进的产品主线——**中心 Team Server（多用户、Gitless）+ 桌面 EXE（Tauri WebView2 内嵌远程 Team 网页 + 进程内 Rust Agent）**——完成插件体系重构：

1. **生产 Team 服务器默认屏蔽全部插件**：服务开箱默认不装载、不启动任何插件子进程，对普通浏览器和服务器部署保持零额外暴露面与资源消耗；仅在运维显式配置开关/白名单时才放行。
2. **6 大内置插件全部迁入桌面 EXE 并实现极简零配置**：将 `witops-core`、`scenario-copilot`、`jenkins-ops`、`accounts-core`、`acp-dispatch`、`a2a-intake` 统一收编到桌面客户端本机插件宿主（同时兼容用户目录私有插件如 `witops-workbench`）；大幅精简 `plugin.json` 字段，除账号/凭据信息外**启用即用**。
3. **Standalone 降级为历史遗留模式**：停止维护 standalone 专属特性与双轨插件同步，所有新演进统一围绕 Team 服务端 + EXE 桌面端主线（文档同步降级，暂不建源码归档/删除任务）。

**父任务职责边界**：本父任务只维护总需求集、子任务地图、已拍板决策与跨子任务验收口径，不直接实现代码。

## Key Decisions（已拍板收敛）

1. **生产服务器默认屏蔽**：`TRELLIS_TEAM_PLUGINS_ALLOWLIST` 未配置时默认为空 `[]`（即生产 Team Server 默认禁用全部插件）；支持 `TRELLIS_PLUGINS_DISABLED=1` 强行关闭，以及显式配置白名单按需开启。
2. **6 大内置插件入驻桌面 EXE**：`witops-core`、`scenario-copilot`、`jenkins-ops`、`accounts-core`、`acp-dispatch`、`a2a-intake` 全部进入桌面 EXE 本机插件宿主；同一 EXE 内不同用户登录不同账号时，按 `(serverUrl, userId)` 严格隔离配置、store、日志与 DPAPI 凭据。
3. **极简零配置原则**：`plugin.json` 不再堆砌技术调优字段与环境绝对路径；调优参数下沉到代码默认值，仓库/分支/数据目录/本机回调地址由 EXE 宿主从当前账号的 `localAssociations` 自动推导，除账号凭据（及 LLM Key）外启用即可使用。
4. **Standalone 降级冻结**：不再为 standalone 模式新增功能或维护双套插件UI；仅保留存量兼容与不破坏既有测试，相关规范与说明文档已同步标注降级。

## Confirmed Facts（仓库实证）

- `packages/server/plugins/runtime.js:106` 支持 `TRELLIS_PLUGINS_DISABLED=1`（仅 standalone），但 `packages/server/config.js:107-138` 与 `packages/server/team/http.js:456-470,514-521` 未接入。
- `packages/server/team/http/common.js:42` 硬编码 `TEAM_PLUGIN_ALLOWLIST = ['witops-core']`，导致 Team 默认必装载插件。
- `packages/server/team/http.js:149-155` 放行匿名 `/api/plugins/:id/app/panel*`；`packages/server/team/http/context.js:24-59` 的 `runtimePayload()` 未返回 `features.pluginsEnabled`。
- `packages/web/src/pages/board/BoardPage.tsx:58-63` 顶栏 `NAV` 写死 `{ id: 'plugins', label: '插件' }`，Team 模式下所有登录用户均看到单机版 `<PluginsView />`；`packages/web/src/pages/admin/AdminPage.tsx:59-64` 始终显示管理页 `plugins` Tab。
- `plugins/witops-core/index.js:159-183,390-411,846-888` 的 `readCache`、`storyIndexCache`、`groupStoryCache` 在 Team 模式下未按 `actor.userId` 分区；`plugins/witops-core/team-auth.js:23-29` 保留模块级可变 `state`。
- `packages/desktop/README.md` 与 `packages/desktop/src-tauri/capabilities/board-local-association.json` 证实 EXE 运行环境门已确保用户本机安装 Node.js ≥ 18.17、Python ≥ 3.9 与 Trellis CLI，且远程网页可通过受 `ensure_board_caller` 同源校验的 Tauri IPC 调用本机能力与 `localAssociations`；Rust `TaskSync` 自动监听 `.trellis/tasks/**` 并通过 CAS 同步至 Team Server。
- 现有 6 大内置插件 `plugin.json`（如 `witops-core`、`scenario-copilot`、`jenkins-ops`、`acp-dispatch`、`a2a-intake`、`accounts-core`）均包含大量默认参数、本地绝对路径或必填环境 secret，不满足「除账号外启用即用」。

## Task Map & Requirements

| 阶段 | 子任务目录 | 包 | 核心范围 | 依赖前置 |
| --- | --- | --- | --- | --- |
| Phase 1 | `11-20-team-plugin-server-gating` | `server` / `web` | Team 服务端默认屏蔽插件（allowlist 默认空 + `TRELLIS_PLUGINS_DISABLED`）、`/api/runtime` `features.pluginsEnabled` 联动前端顶栏与管理页收敛、修复显式放行时 `witops-core` 跨用户缓存串扰 | 无阻塞，可首个启动 |
| Phase 2 | `11-20-desktop-local-plugin-host` | `desktop` / `web` | EXE 懒启动本机插件宿主（复用环境门 `node.exe`）、按 `(serverHash, userId)` 隔离数据与 DPAPI 凭据、切号停旧进程、`localAssociations` 桥接 `trellis.projects`/`ctx.tasks`、`a2a-intake` 仅绑定 loopback、`BoardPage`/`PluginPanel` 仅 `isTauri` 显示本机入口与双通道转发、绿色包打包分发 | 依赖 Phase 1 完成 |
| Phase 3 | `11-20-desktop-plugins-zero-config` | `server` / `plugins` | 6 大内置插件 `plugin.json` 极简化（移除冗余调优和路径字段）、基于 `localAssociations`/`accounts-core`/随机 token 的零配置启用即用改造、manifest `targets` 声明与空配置启动验收 | 依赖 Phase 2 完成 |

## Dependencies / Ordering

1. 严格串行推进：`11-20-team-plugin-server-gating`（Phase 1）→ `11-20-desktop-local-plugin-host`（Phase 2）→ `11-20-desktop-plugins-zero-config`（Phase 3）。
2. 每个子任务完成并验证通过后再启动下一子任务；父任务不执行 `task.py start`。

## Out of Scope

- 不建 Standalone 源码归档/清理任务，不破坏既有 `standalone` 存量代码与单元测试。
- 不在 Team Server 数据库中落地第三方个人账号密码（继续遵守既有安全边界）。
- 不向绿色包额外捆绑第二个 Node.js 运行时（继续复用运行环境门探测/安装的本机 `node.exe`）。

## Cross-Child Acceptance Criteria

1. **服务器默认全屏蔽**：Team Server 零额外环境变量启动后，无插件子进程、`GET /api/runtime` 返回 `features.pluginsEnabled === false`、`GET /api/panels` 为空、`/api/plugins/*`（含 `/app/panel*` 匿名静态资源）不可访问；浏览器与管理员页面均无插件入口（除非运维显式开启白名单）。
2. **纯浏览器与桌面 EXE 隔离**：纯浏览器访问远程 Team Board 时完全看不到任何 EXE 本机插件面板与管理入口；在 EXE 中登录后仅在 `isTauri === true` 时显示本机插件入口与已启用插件面板。
3. **EXE 多账号与多服务器隔离**：同一台电脑用 EXE 登录账号 A、启用并配置插件后退出，换账号 B（或换服务器 URL）登录时，账号 A 插件进程立即停止，账号 B 看不到账号 A 的配置、store、日志、本地运行结果与 DPAPI 凭据。
4. **6 大插件极简零配置启用即用**：仅配置 `enabled: true`（`config: {}`）时，`accounts-core`、`witops-core`、`jenkins-ops`、`acp-dispatch`、`scenario-copilot`、`a2a-intake` 在桌面宿主中均可直接进入 `running` 状态，无 `missing-secret` 阻塞；除账号/凭据/LLM Key 外无需手工填写项目 ID、仓库路径、本地目录或轮询调优参数即可工作；插件在本地创建/修改任务后由 Rust `TaskSync` 自动同步到 Team Server。
5. **质量门全绿**：`yarn test`、`yarn test:plugins`、`yarn --cwd packages/web lint`、`yarn --cwd packages/web build`、`cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` 通过，Windows 绿色包完成实机验收。
