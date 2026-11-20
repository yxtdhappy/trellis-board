# 技术设计：六大内置插件入驻 EXE 适配与 `plugin.json` 极简零配置改造

## 1. 极简分层模型：Manifest 只留身份与能力，配置只存 UI 偏好与账号凭据

```text
Layer 1: 代码内置 DEFAULTS（protocol prefixes / timeouts / retries / cacheTtl / limits）
   ↓ 覆盖（仅高级用户手动修改时）
Layer 2: 运行时自动推导（repositoryId / cwd / workspaceDir / branches / outputDir / storageState / loopback publicBaseUrl / 自动生成 localToken）
   ↓ 覆盖（用户个人操作）
Layer 3: 用户交互持久化（accounts-core 统一凭据 + 插件内 store/secrets 保存的账号/baseUrl/LLM Key）
```

通过这一分层，`plugin.json` 彻底从“全量参数说明书”回归为纯粹的**插件元数据与权限清单**：
- `id`、`name`、`description`、`version`、`apiVersion`、`targets`、`engines`、`permissions`、`provides`、`requires`、`panels`、`http`、`allowMissingSecrets: true`、`config: {}`。

## 2. 宿主与 SDK 最小配合（`packages/server/plugins/`）

1. **`ctx.paths` / 数据目录隔离**：
   - `initialize` 参数允许宿主传入 `pluginDataDir`（即 `<userScope>/data/<pluginId>`），通过 SDK `ctx.paths.dataDir` 暴露给需要落盘临时输出/浏览器态的插件（如 `scenario-copilot` 的 `storageState` / `outputRoot`），禁止插件硬编码 `/tmp/` 或源码树相对路径。
2. **`trellis.projects` 完整上下文**：
   - 在桌面宿主的 `trellis.projects` 实现中，除返回 `{ repositoryId, name, path }` 外，附加当前关联分支 `branch` 与当前登录用户标识 `developerId`，供 `witops-core`、`acp-dispatch`、`scenario-copilot`、`a2a-intake` 零配置直接使用。
3. **`targets` 声明与校验（`packages/server/plugins/version.js`）**：
   - 校验可选 `targets` 数组元素仅允许 `'desktop' | 'server' | 'standalone'`；未填时兼容旧行为。

## 3. 六大插件逐个改造设计

### 3.1 `accounts-core`
- **`plugin.json`**：`config: {}`；内置 `systemPresets = [{ id: 'witops', name: 'WitOps 平台' }, { id: 'jenkins', name: 'Jenkins' }, { id: 'scenario', name: '场景测试目标系统' }]`。
- **面板与存储**：面板直接管理账号/密码并支持绑定各系统 `baseUrl`，桌面宿主底层使用 DPAPI 加密 store/secrets，保证同一台机器不同登录账号物理隔离。

### 3.2 `witops-core`
- **`plugin.json`**：`config: {}`（`allowMissingSecrets: true`）；保留 `requires: ["accounts.credentials", "trellis.projects"]`。
- **代码侧适配**：
  - 将原先 30 个网关前缀/分页/限流/轮询字段保留在 `index.js` `DEFAULTS`；
  - `repositoryId` 默认取自面板当前选中项目上下文（`trellis:init.context.repositoryId`）或关联列表首项，不再要求手填 `config.repositoryId`；
  - 统一面板：精简合并 `index.html` 与 `team.html` 重复交互逻辑（桌面宿主本身能读写关联的本地 `.trellis/tasks`，既支持团队项目空间查询分组，又能直接下发本地任务由 `TaskSync` 自动上行）；
  - 凭据优先从 `accounts-core` 解析（`witops` 系统），失败或未绑定时直接在面板表单登录并加密保存至本机账号隔离区。

### 3.3 `jenkins-ops`
- **`plugin.json`**：`config: {}`（`allowMissingSecrets: true`）；`views`/`jobFilter`/`verifyTls`/`crumb`/`timeoutMs`/`retries`/`maxLogLines` 全部内置 `DEFAULTS`。
- **面板适配**：面板「设置」支持直接填写/修改 `baseUrl` 及选用 `accounts-core` 账号或独立保存凭据；无需事先编辑任何 JSON 文件。

### 3.4 `acp-dispatch`
- **`plugin.json`**：`config: {}`；全部 13 个参数（`permission`、`runTimeoutMs`、`maxConcurrent`、`idleTimeoutMs`、`maxSessions` 等）保留在 `index.js` `DEFAULTS`。
- **零配置自动探测**：
  - `onStart` / 状态查询时扫描本机 `PATH` 中的常见 Coding Agent 可执行文件（`opencode`、`codex`、`claude` 等），默认选中首个可用项并允许在面板切换；
  - 执行任务时直接从 `trellis.projects` 读取对应关联仓库的真实 `path` 作为 `cwd`，彻底去掉对 `config.cwd` 的依赖。

### 3.5 `scenario-copilot`
- **`plugin.json`**：`config: {}`；20+ 个本地目录与超时/重试/Token 上限收归 `index.js` `DEFAULTS`。
- **自动路径解析**：
  - `workspaceDir` 默认取当前选中关联项目的 `path`；
  - `outlinesDir` 默认落在 `<workspaceDir>/.trellis/scenario-outlines`（或用户显式设置目录）；
  - `outputRoot` 与 `storageState` 默认落在 `ctx.paths.dataDir` 下，避免不同项目或不同登录账号相互覆盖 `/tmp/mdp-storage.json`。
  - 账号/LLM 配置：在面板直接配置 `targetUrl` + 账号（或关联 `accounts-core`）+ LLM `apiKey`/`baseUrl`/`model`，存入当前账号隔离 `ctx.secrets` / `ctx.store`。

### 3.6 `a2a-intake`
- **`plugin.json`**：添加 `"allowMissingSecrets": true`，`config: {}`（彻底去掉会阻塞启动的 `"token": "env:A2A_TOKEN"`）。
- **零配置启动**：
  - `onStart` 时优先读取 `ctx.secrets.get('a2a-intake/token')` 或 `env:A2A_TOKEN`；若均为空，自动调用 `crypto.randomBytes(24).toString('base64url')` 生成并存入本机隔离 `ctx.secrets.set('a2a-intake/token', ...)`；
  - `publicBaseUrl` 由宿主注入当前桌面本地监听根地址；`repositoryId` 自动取当前选中关联项目（或要求请求体显式传），`defaultAssignee` 默认取当前登录账号的 `developerId`；
  - 提供/补充本地查看与复制连接配置（URL + Token 按钮）能力，方便本机其他工具或脚本接入。

## 4. 风险与兼容保障

- **原有单测与 `manifest.test.js` 兼容**：部分既有测试可能断言 `plugin.json` 中存在特定 `config` 键名或默认拒绝缺 token 启动（如 `a2a-intake` 缺 token 测例）→ 更新相应测试契约，明确区分「旧行为兼容断言」与「新版零配置断言」；插件代码内部继续合并 `...DEFAULTS, ...config`，因此显式在覆盖文件中传入自定义调优字段依然有效。
