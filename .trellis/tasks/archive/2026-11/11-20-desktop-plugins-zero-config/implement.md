# 实施计划：六大内置插件入驻 EXE 适配与 `plugin.json` 极简零配置改造

## 前置门禁
- `11-20-desktop-local-plugin-host` 已完成验收并归档。

## 有序实施清单

### Step 1：Manifest 目标字段与 SDK 路径/用户上下文扩展
1. 在 `packages/server/plugins/version.js` 增加 `targets` 声明校验。
2. 在 `packages/server/plugins/supervisor.js`、`sdk.js` 透传 `ctx.paths.dataDir` 与当前用户基础信息，并将 `branch`/`developerId` 纳入 `trellis.projects`。

### Step 2：精简 6 大插件 `plugin.json` 与各自零配置改造
1. **`accounts-core`**：精简 `plugin.json`，内置默认 `systemPresets`，验证面板增删改与凭据解析。
2. **`acp-dispatch`**：精简 `plugin.json`，实现本机 Agent 自动探测与从关联项目读取 `cwd`，验证零配置派发。
3. **`a2a-intake`**：精简 `plugin.json`（`allowMissingSecrets: true`），实现首次启动自动生成/读取本机 token 及默认项目/负责人推导。
4. **`jenkins-ops`**：精简 `plugin.json`，确保纯面板配置 `baseUrl` + 凭据或绑定 `accounts-core` 即刻可用。
5. **`witops-core`**：精简 `plugin.json`，统一单套桌面面板并从当前关联项目推导 `repositoryId`/分支，串联 `accounts-core` 与本地 `.trellis/tasks` 写入同步闭环。
6. **`scenario-copilot`**：精简 `plugin.json`，将输出目录与 `storageState` 默认落入 `ctx.paths.dataDir`，关联项目目录自动作为 `workspaceDir`，面板完善 LLM 与目标账号最小化表单。

### Step 3：测试集重构与全面验证
1. 更新 `packages/server/test/plugin-manifest-conventions.test.js` 与 `plugins/*/test/*.test.js`。
2. 新增端到端测试：空 `config: {}` 装载全部 6 个插件全部进入 `running`；验证 `accounts-core` → `witops-core` / `jenkins-ops` 联动与 `a2a-intake` / `acp-dispatch` 零配置流程。
3. 同步更新 `plugins/README.md` 与 6 个插件的 `README.md`。
4. 运行全量验证：

```bash
yarn test
yarn test:plugins
yarn --cwd packages/web lint
yarn --cwd packages/web build
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
```

并完成 Windows EXE 绿色包最终整体验收（6 个插件启用即用 + 任务创建自动同步到 Team Server）。

## 风险与回滚点
- 插件内 `DEFAULTS` 保留全部原高级配置键的运行时兼容读取；即使局部遇到特殊环境需要覆写（如自定义网关前缀或超时），仍可在用户配置覆盖中生效，无需改回臃肿模板。
