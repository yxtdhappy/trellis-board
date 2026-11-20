# PRD: 六大内置插件入驻 EXE 适配与 `plugin.json` 极简零配置改造

- 所属父任务：`11-20-team-plugin-architecture-refactor`
- 前置依赖：`11-20-desktop-local-plugin-host`（Phase 2 完成后启动）
- 阶段：Phase 3（主线收官 · P1）

## Goal

围绕「6 大内置插件全部入驻桌面 EXE、**除账号/凭据信息外启用就能使用**」目标，对 `accounts-core`、`witops-core`、`jenkins-ops`、`acp-dispatch`、`scenario-copilot`、`a2a-intake` 进行彻底的零配置瘦身与自适应适配：

1. **大幅精简 `plugin.json`**：移除插件清单中堆砌的几十项内部调优参数、协议前缀、本机绝对路径与强制 `env:` 密钥阻塞项，下沉到代码内合理的 `DEFAULTS`（仍兼容显式高级覆盖）。
2. **上下文全自动推导**：插件所需的工作区路径（`cwd` / `workspaceDir` / `repositoryId`）、本地分支、缓存与输出路径、回调 URL、本地 Bearer Token 全部从桌面宿主与当前登录账号的 `localAssociations` 自动获取或自动初始化。
3. **除账号信息外启用即用**：6 大内置插件以空 `config: {}` 在桌面 EXE 中开启即可直接进入 `running` 状态；无密码/凭据需求的插件（`acp-dispatch`、`a2a-intake`）完全零配置立即可用；依赖外部系统/模型的插件（`witops-core`、`jenkins-ops`、`scenario-copilot`）仅需填写目标系统地址+账号（或统一从 `accounts-core` 绑定）及 LLM Key 即可运行。

## Confirmed Facts（仓库实证：当前 `plugin.json` 冗余现状）

- `plugins/accounts-core/plugin.json:52-59`：在 `config` 中配置 `systemPresets`。
- `plugins/witops-core/plugin.json:150-192`：含约 30 个字段，包括 `gatewayPrefix`/`taskServicePrefix`/`adminServicePrefix`/`webRoot`/`platform`/`path`、`types`/`type`/`status`/`pageSize`/`categoryScanSize`/`maxItems`/`maxPerSync`/`cacheTtlMs`/`requestIntervalMs`/`retries`/`timeoutMs`/`keepRaw`、`repositoryId`/`userId`/`assignedToUserId`/`assignee`/`developerMap`、`credentials`（含 `secret:witops-core/password`）与 `poll`；且 `witops-core/index.js:934-943` 保留了 `index.html` 与 `team.html` 两套面板。
- `plugins/jenkins-ops/plugin.json:85-98`：含 `jobFilter`/`views`/`verifyTls`/`crumb`/`timeoutMs`/`retries`/`maxLogLines`/`repositoryId`/`credentialSource`/`accountSystemId` 等 12 个配置字段。
- `plugins/acp-dispatch/plugin.json:41-61`：含 `agent`/`command`/`args`/`cwd`/`permission`/`runTimeoutMs`/`maxConcurrent`/`retryFailed`/`rerunSucceeded`/`dispatchUnbound`/`idleTimeoutMs`/`sessionIdleMs`/`maxSessions` 13 个参数。
- `plugins/scenario-copilot/plugin.json:101-123`：含 `scenarioRoot`/`workspaceDir`/`outputRoot`/`outlinesDir`/`knowledgePath`/`targetUrl`/`orgName`/`username`/`password`/`llmApiKey`/`llmBaseUrl`/`llmModel`/`effort`/`effortField`/`reconSnapshots`/`defaultOutline`/`timeoutMs`/`maxRuns`/`maxHealingRetries`/`maxTokens`/`outlineTimeoutMs` 21 个字段，强依赖手工填写本机绝对路径。
- `plugins/a2a-intake/plugin.json:37-46`：声明 `"token": "env:A2A_TOKEN"` 与 `publicBaseUrl`/`repositoryId`/`defaultAssignee`/`defaultPriority`/`protocolVersion`/`defaultAgent`，缺少环境变量 `A2A_TOKEN` 时宿主直接标记 `missing-secret` 无法启动。

## Requirements

### R1 Manifest 极简化与目标声明规范
- 更新 `packages/server/plugins/version.js` 与插件清单规范：支持可选 `targets`（如 `["desktop"]` 或 `["desktop", "standalone"]`）；确保 `config: {}` 合法且为推荐默认写法。
- 删除 6 大内置插件 `plugin.json` 中的技术调优参数、协议默认前缀与本地路径占位符；所有内部默认值保留在各自 `index.js` 的 `DEFAULTS` 中，仍允许高级用户或单元测试在覆盖配置时透传。

### R2 逐插件「启用即用」与自动推导改造

| 插件 | `plugin.json` 精简后保留 | 自动推导 / 零配置能力 | 用户需填的账号/凭据项 |
| --- | --- | --- | --- |
| **`accounts-core`** | 移除 `config.systemPresets`（`config: {}`） | 系统预设（`witops`/`jenkins`/`scenario`）内置代码默认；支持自定义新增系统；桌面端使用每账号 DPAPI/加密 secrets 保存 | 个人内网账号与密码 |
| **`witops-core`** | `config: {}`（或仅留可空 `baseUrl` 展示位）；统一单套面板 | `repositoryId`/分支自动取自宿主当前项目及 `localAssociations`；`accountSystemId='witops'`、`credentialSource='auto'` 默认内置；合并 `index.html` 与 `team.html` 为一套桌面面板；创建任务写 `.trellis/tasks` 后由 Rust `TaskSync` 自动上行 | WitOps 账号密码（或直接复用 `accounts-core` 中绑定的 WitOps 账号） |
| **`jenkins-ops`** | `config: {}` | `accountSystemId='jenkins'`、`credentialSource='auto'`、TLS/crumb/重试/日志行上限内置 `DEFAULTS` | Jenkins `baseUrl` + 账号密码/API Token（或绑定 `accounts-core`） |
| **`acp-dispatch`** | `config: {}` | `cwd` 自动从任务关联的本地仓库 `repoPath` 获取；启动时自动探测本机可用 CLI agent（如 `opencode`/`codex`/`claude` 等）并在面板下拉选择；权限/超时全部合理默认 | **完全零配置，启用即用** |
| **`scenario-copilot`** | `config: {}` | `workspaceDir` 自动取自当前关联项目目录；`outlinesDir`/`outputRoot`/`storageState` 自动落入 `<项目>/.trellis/` 或当前账号插件目录（`ctx.dataDir` / store）；执行超时与重试参数全部内置 | 测试目标 URL + 登录账号密码（支持关联 `accounts-core`）+ LLM API Key / BaseURL / Model |
| **`a2a-intake`** | 设 `allowMissingSecrets: true`，`config: {}` | 首次启动若无 token 则自动生成高熵随机 token 并存入插件隔离 secrets（面板/状态可复制与重置）；`publicBaseUrl`（桌面 loopback 地址）、`repositoryId`（当前选中或唯一关联项目）、`defaultAssignee`（当前登录用户 `developerId`）全部自动推导 | **完全零配置，启用即用** |

### R3 SDK 与宿主小幅能力配合
- 若当前 SDK 尚缺插件专属工作目录路径（如供 `scenario-copilot` 放生成的脚本/输出/浏览器 `storageState`）或当前登录用户身份字段，在本阶段通过 SDK（如 `ctx.paths?.dataDir` 或 `ctx.host?.currentUser`）以标准契约提供，禁止插件私自拼接内部路径。
- 统一在桌面宿主下跑通跨插件联动：`accounts-core` 统一管理凭据 → `witops-core` / `jenkins-ops` / `scenario-copilot` 免重复输密自动获取。

### R4 清单约定测试与 README 同步
- 同步更新 `packages/server/test/plugin-manifest-conventions.test.js`、`plugins/*/test/manifest.test.js`、`plugins/*/test/*.test.js` 及各插件 `README.md`、`plugins/README.md`，使全部测试反映「极简零配置」新契约。

## Acceptance Criteria

1. 检查 6 大内置插件 `plugin.json`：`accounts-core`、`witops-core`、`jenkins-ops`、`acp-dispatch`、`scenario-copilot`、`a2a-intake` 均已去除冗余调优与路径字段，空 `config: {}` 时全部通过 manifest 校验。
2. 在空白桌面插件配置下逐个启用上述 6 个插件，全部直接进入 `running` 状态，零 `missing-secret`、零必填路径缺失启动失败。
3. 端到端功能验收：
   - `acp-dispatch` 无需配置 `cwd`/超参即可发现关联仓库任务并调起本机 Agent；
   - `a2a-intake` 无需手工配 `A2A_TOKEN` 即可自动签发本地 token 并接收本地请求创建任务；
   - `accounts-core` 录入 `witops` / `jenkins` 账号后，`witops-core` 与 `jenkins-ops` 面板自动生效，无需在插件中重复配置系统预设或重复填密码；
   - `scenario-copilot` 选择当前项目后无需手工配置本机目录即可预览大纲或执行。
4. `yarn test`、`yarn test:plugins`、`yarn --cwd packages/web lint`、`yarn --cwd packages/web build`、`cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` 全部通过。

## Out of Scope

- 不把 6 大插件重新放回中心 Team Server 运行。
- 不修改 `witops-workbench` 等未入库私有插件强制结构（保持向后兼容解析，私有插件可选择跟随精简）。
