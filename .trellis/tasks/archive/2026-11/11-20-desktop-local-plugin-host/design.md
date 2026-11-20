# 技术设计：桌面 EXE 本机插件宿主与 Tauri 双通道桥接

## 1. 整体架构与数据流

```text
Remote Team WebView (origin == board_url)
  ├─ isTauri === false (普通浏览器)
  │    └─ 不请求本机 IPC、不显示本机插件入口与面板
  └─ isTauri === true (trellis-board-client.exe)
       ├─ 管理页/抽屉「本机插件」 -> invoke('desktop_plugins_list' / 'set_enabled' / 'logs')
       └─ PluginPanel (host === 'desktop')
            ├─ 加载面板资源 -> invoke('desktop_plugin_asset') -> sandbox iframe
            └─ trellis:request -> invoke('desktop_plugin_request')
                                    └─ Rust ensure_board_caller()
                                         └─ DesktopPluginHost (按 serverHash + userId 隔离)
                                              ├─ 127.0.0.1 + 随机 token -> Node 本机宿主 (PluginSupervisor)
                                              └─ 注入当前账号 approved localAssociations + DPAPI secrets
```

## 2. Node 侧最小本机插件宿主封装（`packages/desktop/plugin-host/` 或 `packages/server/plugins/desktop-host.js`）

- **复用不重复造轮子**：直接复用 `packages/server/plugins/supervisor.js`、`store.js`、`task-service.js`、`protocol.js`，仅装配最小启动引导：
  - 接收命令行/环境变量注入的隔离 `dataDir`、`pluginsDir`（用户目录覆盖 + 内置插件目录只读回落）、`hostVersion`、以及内部通信随机 bearer token；
  - 默认只绑定 `127.0.0.1:0`（或 stdio 通道），每个请求校验 Rust 侧注入的内部 token，外部进程无法未授权访问；
  - 暴露内部控制端点供 Rust 调用：`/internal/plugins`、`/internal/plugins/:id/start|stop|logs`、`/internal/plugins/order`、`/internal/panels`、`/internal/repositories`（实时刷新当前 `localAssociations`）、以及转发插件路由与匿名静态资源；
  - 若启用 `http.rootPaths`（如 `a2a-intake`），仅监听 `127.0.0.1` 本地回环端口并继续校验插件自身 token，绝不绑定 `0.0.0.0`。

## 3. Rust Tauri 宿主管理与安全边界（`packages/desktop/src-tauri/`）

1. **新增模块 `src/plugin_host.rs`**：
   - **隔离路径规则**：
     ```text
     %LOCALAPPDATA%\TrellisBoard\data\desktop-plugins\<sha256_prefix(serverUrl)>\
       └─ <userId>\
            ├─ plugins.json           (只存 enabled/sort 与用户覆盖)
            ├─ plugins.secrets.dpapi  (由 agent/credential.rs DPAPI 加密保管，Entropy 绑定 serverHash+userId)
            ├─ board.sqlite           (仅插件 KV store / run / audit)
            └─ logs\<pluginId>.log
     ```
   - **懒启动判定**：登录成功后只读取 `<userScope>/plugins.json`，若无 `enabled: true` 条目（且用户未在 UI 点击开启），**不 spawn Node 进程**；首次开启任一插件时才通过 `agent/env` 探测到的 `node.exe` 启动本机宿主。当全部插件停用后可延迟/主动退出 Node 宿主释放内存。
   - **会话强绑定**：在 `main.rs` 的 `clear_desktop_session`、退出托盘、重新登录切换账号时，同步停止本机宿主子进程树并清理内部通信端口/token。
   - **关联仓库同步**：每当 `localAssociations` 变更或登录完成时，Rust 将 `approved` 的 `LocalAssociation`（`repositoryId = projectId`、`name`、`path = repo_path`、`branch = branch_name`、`taskSpaceId`）同步推送给本机插件宿主。

2. **Tauri IPC 与 Capability 收紧**：
   - 所有命令（`desktop_plugins_list`、`desktop_plugin_set_enabled`、`desktop_plugin_reorder`、`desktop_plugin_logs`、`desktop_plugin_panels`、`desktop_plugin_request`、`desktop_plugin_asset`）首行执行 `ensure_board_caller(&app, &window)`。
   - 权限声明仅加入 `capabilities/board-local-association.json` 与 `permissions/desktop.toml`，本地登录页 `capabilities/main.json` 无权调用。

## 4. 绿色包打包方案（`packages/desktop/`）

- `tauri.conf.json` 通过 `bundle.resources`（或绿色包构建步骤 `package-portable.ps1`）将最小宿主脚本与 6 大内置插件目录（过滤 `**/test/**`、`*.test.js` 等测试与无关文件）打包随 `trellis-board-client.exe` 同级（或资源目录）分发，并在 `package-portable.ps1` 中将其全部纳入 `SHA256SUMS.txt`。
- 注意同步检查 `update.rs` 自更新替换逻辑：若绿色包除单 `trellis-board-client.exe` 外新增 `plugins/` 资源子目录，必须确认更新解压与覆盖策略覆盖该资源目录（或通过嵌入式资源解压到 `%LOCALAPPDATA%\TrellisBoard\bundled-plugins\<version>\`，从而**继续保持绿色包内只有单一 `trellis-board-client.exe` 的分发形态**！）。
  - **推荐做法（在 Design 明确落点）**：把最小宿主 bundle 与 6 大插件静态资产在构建期打包成资源（`tauri::include_dir` 或压缩包嵌入 EXE / `resources`），首次按客户端 `version` 释放到 `%LOCALAPPDATA%\TrellisBoard\runtime\plugins\<version>\`，从而**既不破坏现有单一 EXE 自动更新替换机制，又保证内置插件版本随客户端同步升级**。

## 5. Web 前端双通道渲染（`packages/web/`）

1. **`packages/web/src/pages/board/BoardPage.tsx`**：
   - 当 `isTauri === true` 时：
     - 在顶栏/更多导航显示「本机插件」管理入口（复用/扩展 `<PluginsView />` 支持桌面数据源 `desktopInvoke`）；
     - 同时拉取远程 `/api/panels`（若 `pluginsEnabled`）与 `desktopInvoke('desktop_plugin_panels')`，为本机面板标记 `host: 'desktop'` 并合并进 `navItems`。
   - 当 `isTauri === false`（纯浏览器）：不调用 Tauri 命令、不显示本机插件入口。
2. **`packages/web/src/features/plugins/PluginPanel.tsx`**：
   - 保持 `sandbox="allow-scripts allow-forms"` 不变；
   - 若 `panel.host === 'desktop'`：
     - 通过 `desktopInvoke('desktop_plugin_asset', { pluginId, entry })` 获取静态 HTML 并注入 `srcDoc`（将 `/plugin-ui/v1/*` 与面板内资源按约定的安全协议替换或挂载）；
     - `trellis:request` 消息走 `desktopInvoke('desktop_plugin_request', { pluginId, method, path, body })` 并将结果通过 `postMessage({ type: 'trellis:response', ... })` 返回给 `bridge.js`。

## 6. 风险与缓解

- **sandbox iframe 加载本机面板子资源（JS/CSS）与 `/plugin-ui/v1/*`**：当用 `srcDoc` 或远程 origin 混合加载时，`srcDoc` iframe 内相对路径 `/plugin-ui/v1/*` 可能指向 `about:srcdoc` 失败 → 解决方案：`/plugin-ui/v1/*` 与本机面板 JS/CSS 在 Rust/Web 桥侧显式重写为当前登录 `boardOrigin + '/plugin-ui/v1/...'` 或直接由桥注入静态文本/Blob URL（需配合 CSP），并在测试中实测确认所有内置面板样式与脚本加载成功。
- **自动更新兼容**：采用「内置插件打包资源按客户端版本号释放到 `%LOCALAPPDATA%\TrellisBoard\runtime\plugins\<version>\`」可零改造兼容现有单 EXE 自动更新覆盖流程。
