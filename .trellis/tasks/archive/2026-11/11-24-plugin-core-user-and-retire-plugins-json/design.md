# Design: 废弃桌面 plugins.json 并暴露登录用户 core 能力

## 1. Architecture Overview

```text
[Tauri 桌面壳 plugin_host.rs]
  ├─ 读取/维护 <scope>/plugin-state.json (仅 {id, enabled, sort}，迁移旧 plugins/plugins.json)
  ├─ 通过 --user-json / 环境变量向 host.mjs 传入当前登录用户 { userId, username, displayName, serverUrl }
  └─ 启动 Node 插件宿主 host.mjs
         │
         ▼
[Node 插件宿主 host.mjs + PluginSupervisor]
  ├─ entriesProvider 内存组装插件清单（不写 plugins/plugins.json）
  └─ createCoreCapabilities 注册:
       ├─ trellis.user.current     (权限: user:read)
       └─ trellis.projects.developers (权限: projects:read, 解析 .trellis/.developer name= 与 workspace/)
         │ JSON-RPC capability/call
         ▼
[插件 witops-core]
  ├─ 5 级负责人自动关联（显式 > ctx.store > 当前登录用户+仓库.developer > 名称匹配 > 旧config）
  ├─ 未命中返回可溯源结构化诊断 (availableDevelopers + witopsUserId/name)
  └─ 面板预览/下发弹窗支持下拉选择负责人并保存绑定至 ctx.store
```

## 2. Core Capabilities Design (`packages/server/plugins/`)

### 2.1 `trellis.user` (`packages/server/plugins/core-capabilities.js`)
- 在 `CORE_CAPABILITIES` 新增：
  ```js
  {
    name: 'trellis.user',
    version: '1.0.0',
    description: '当前登录用户信息',
    methods: {
      current: { access: 'read', permission: 'user:read', timeoutMs: 10_000 },
    },
  }
  ```
- `createCoreCapabilities({ ..., userProvider = () => null })`：
  - `trellis.user.current(params, state)`：读取 `userProvider(state)`（或 `actorContext`），规范化为只读安全 DTO：
    `{ user: user ? { userId, username, displayName, serverUrl } : null }`。
  - **安全守卫**：显式白名单字段映射，严禁透传 `password`、`sessionToken`、`cookie`、`credential` 等敏感字段。

### 2.2 `readDeveloper` 修复与 `trellis.projects.developers`
- 修复 `readDeveloper(repositoryPath)`：按行解析 `.trellis/.developer`，优先匹配 `name=<value>`（兼容纯单行非 `key=value` 文本），并做长度与单行清理（不把 `initialized_at=` 带进 `developerId`）。
- 新增 `readWorkspaceDevelopers(repositoryPath)`：
  - 检查 `<repositoryPath>/.trellis/workspace` 存在且为目录；
  - 遍历直接子目录（过滤 `.` 开头、`index.md` 及非目录），对每个子目录名做安全校验（无路径分隔符/`..`）；
  - 返回去重排序后的 `{ currentDeveloper: readDeveloper(repositoryPath), developers: [...] }`。
- `trellis.projects` 新增 `developers` 方法（`permission: 'projects:read'`）：接受 `repositoryId` / `id`（单仓库时可省略），返回 `{ repositoryId, currentDeveloper, developers }`。

### 2.3 `PluginSupervisor` 内存清单 (`packages/server/plugins/supervisor.js`)
- 构造函数新增 `entriesProvider = null`（可选函数 `() => [{ id, module, sort, enabled, config }]`）。
- `load()` 与 `reload()`：若提供 `entriesProvider`，优先从 `entriesProvider()` 读取内置及用户插件条目；未提供时沿用原有 `loadPluginConfigFile(this.configFile)`，保证服务端测试 100% 兼容。
- 桌面宿主 `packages/desktop/plugin-host/host.mjs` 传入 `entriesProvider` 与 `userProvider`，同时支持 `POST /internal/plugins/reorder` / 启停后由桌面宿主同步内存状态，不再读写 `plugins/plugins.json`。

## 3. Desktop Plugin Host State Migration (`plugin_host.rs` & `host.mjs`)

### 3.1 `<scope>/plugin-state.json` 替代 `<scope>/plugins/plugins.json`
- 路径：`<scope>/plugin-state.json`（与 `secrets.dpapi` 同级，彻底移出用户可见的 `plugins/` 目录）。
- 结构仅包含：`{ "version": 1, "plugins": [{ "id": "witops-core", "enabled": false, "sort": 20 }] }`，**不含 `module` 和用户 `config`**。
- 一次性迁移：
  - 若 `plugin-state.json` 不存在，检查旧 `<scope>/plugins/plugins.json`（及兼容历史残留）；
  - 若存在则读取其中的 `id`、`enabled`、`sort` 写入 `plugin-state.json`，并将旧文件原子重命名为 `plugins.json.migrated`（保留备份但不再生效；若失败则降级只读不中断）。
- `desktop_plugins_list` / `desktop_plugin_set_enabled` / `desktop_plugin_reorder` 在未启动 Node 时直接读写 `plugin-state.json`；启动 Node 时将 `--state-file`（`<scope>/plugin-state.json`）、`--runtime-dir`、`--user-plugins-dir`、`--user-info`（JSON，含 `username`/`serverUrl`/`userId`，不含密码）传给 `host.mjs`。
- 兼容迁移旧 `developerMap`：`host.mjs` 启动时若发现 `plugins.json.migrated`（或未迁的旧文件）里有 `witops-core.config.developerMap` / `assignee`，可将其一次性同步到插件 `store`（或通过启动只读迁移钩子），平滑过渡。

## 4. `witops-core` Zero-Config Assignee & Panel UI (`plugins/witops-core/`)

### 4.1 权限与能力调用
- `plugins/witops-core/plugin.json`：
  - `permissions` 增加 `"user:read"`；
  - `requires` 增加 `{ "name": "trellis.user", "version": "^1.0.0", "methods": ["current"] }`，并在 `trellis.projects` 增加 `"developers"`。
- 启动时与按需调用 `ctx.capabilities.call('trellis.user', 'current')` 与 `ctx.capabilities.call('trellis.projects', 'developers', { repositoryId })`（对不支持该能力的旧宿主捕获异常降级）。

### 4.2 5 级负责人解析与 `ctx.store` 持久化
- `ctx.store` 键 `developerBindings:<repositoryId>` 存储 `{ byUserId: { "161": "kanyifei" }, updatedAt }`。
- `resolveDraftAssignee({ draft, repositoryId, explicitAssignee, sessionState, trellisUser, projectDevs, storeBindings, config })`：
  1. `explicitAssignee`（请求传入且在仓库合法开发者中，或未拿到仓库列表时非空）；
  2. `storeBindings.byUserId[witopsUserId]`（命中且仍存在于 `projectDevs.developers`）；
  3. **当前登录用户自动关联**：当 `sessionState.userId` 存在且 `String(draft.rawDeveloper) === String(sessionState.userId)` 时：
     - 若 `projectDevs.currentDeveloper` 非空且存在于 `developers`（或 `developers` 为空），直接使用 `currentDeveloper`；
     - 否则尝试用 `trellisUser?.username`（忽略大小写）匹配 `projectDevs.developers`；
     - 命中后自动写回 `storeBindings.byUserId[witopsUserId]`；
  4. **同行/子任务名称匹配**：用 `draft.rawDeveloperName` / `draft.rawAssigneeAccount`（忽略大小写）精确匹配 `projectDevs.developers`；
  5. **兼容兜底**：`config.developerMap[witopsUserId]` → `config.assignee`。
- 若 1–5 均未命中：
  - 返回结构化结果：`{ status: 'missing-assignee', reason: 'missing-assignee', message: '...', details: { businessId, repositoryId, witopsUserId, witopsAssigneeName, currentDeveloper, availableDevelopers } }`；
  - 并在日志输出明确原因（例如：`未找到 Trellis 负责人映射（WitOps: 161 / 余浩杰，目标仓库未初始化 .trellis/.developer 或无匹配 workspace）`）。

### 4.3 新增面板路由与交互 (`plugins/witops-core/index.js` & `panel/app.js`)
- `GET /developers?repositoryId=...`：返回 `{ repositoryId, currentDeveloper, developers, bindings, witopsUser: { userId, account } }`。
- `PUT /developer-bindings`：校验 `repositoryId`、`witopsUserId`、`assignee`（必须在合法开发者列表内），写入 `ctx.store`。
- `POST /dispatch/preview` 与 `POST /dispatch`：支持可选 `assignee`（及 `rememberBinding: boolean`）与 `childAssignees`；预览返回 `resolvedAssignee`、`assigneeSource`、`developerOptions`（含 `currentDeveloper` 与 `developers`）；弹窗中增加「Trellis 负责人」下拉框，允许修改并默认勾选记住本次映射，遇 `missing-assignee` 时高亮提示并引导直接选择后重试。

## 5. Security, Compatibility & Rollback

- **安全**：`trellis.user.current` 严格只返回身份元数据（不含密码/token）；`.trellis/workspace/` 目录枚举使用 `fs.readdirSync(..., { withFileTypes: true })` 并校验证件名无路径穿越。
- **兼容性**：服务端插件单测继续沿用 `configFile`；桌面端 `desktop-ui-build.test.js` 和 `plugin-host.test.js` 同步适配 `plugin-state.json` 与 `entriesProvider`。
- **回滚**：如发现问题，回退本任务提交即可；老用户迁移前重命名的 `plugins.json.migrated` 仍保留在原目录。
