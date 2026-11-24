# Implementation Plan: 废弃桌面 plugins.json 并暴露登录用户 core 能力

## Execution Checklist

### Phase 1: Core Capabilities (`trellis.user` & `trellis.projects.developers`)
- [x] **1.1** `packages/server/plugins/core-capabilities.js`：
  - 修复 `readDeveloper(repositoryPath)` 正确解析 `.trellis/.developer` 中的 `name=` 行；
  - 新增 `readWorkspaceDevelopers(repositoryPath)`；
  - 新增 `trellis.user`（`current` 方法，权限 `user:read`）与 `trellis.projects.developers`（权限 `projects:read`）；
  - `createCoreCapabilities` 接收 `userProvider`。
- [x] **1.2** `packages/server/plugins/supervisor.js` & `runtime.js`：
  - `PluginSupervisor` 与 `createPluginRuntime` 支持 `entriesProvider` 与 `userProvider`（桌面宿主使用内存清单，Team/测试兼容 `configFile` 与 `actorContext`）。
- [x] **1.3** 单元测试：`packages/server/test/plugin-core-capabilities.test.js` 补充 `trellis.user.current`（含权限校验与脱敏）、`readDeveloper`（多行 `.trellis/.developer`）及 `trellis.projects.developers` 用例。

### Phase 2: Retire Desktop `plugins/plugins.json`
- [x] **2.1** `packages/desktop/src-tauri/src/plugin_host.rs`：
  - 用 `<scope>/plugin-state.json`（只存 `id`、`enabled`、`sort`）替代 `<scope>/plugins/plugins.json`；
  - 实现旧 `plugins/plugins.json` 一次性迁移到 `plugin-state.json` 并重命名为 `plugins.json.migrated`；
  - 启动 `host.mjs` 时传入 `--state-file`、`--runtime-dir`、`--user-plugins-dir`、`--user-json`（当前登录用户）。
- [x] **2.2** `packages/desktop/plugin-host/host.mjs`：
  - 支持 `--state-file`、`--runtime-dir`、`--user-plugins-dir`、`--user-json`；
  - 内存生成 `entriesProvider`，不再写入 `plugins/plugins.json`；
  - `reorder` 直接回写 `stateFile`；通过 `userProvider` 向 `createPluginRuntime` 暴露当前登录用户；
  - 启动时如存在旧 `plugins.json.migrated` 中的 `witops-core.config.developerMap`，一次性迁入插件 `store`（不覆盖已有绑定）。
- [x] **2.3** 更新 `packages/desktop/test/plugin-host.test.js` 与 `packages/desktop/test/plugins-zero-config.test.js` 覆盖无 `plugins.json` 落盘与 `trellis.user` 注入。

### Phase 3: `witops-core` Zero-Config Assignee & Panel UI
- [x] **3.1** `plugins/witops-core/plugin.json`：声明 `user:read` 权限与 `trellis.user`、`trellis.projects.developers` 依赖。
- [x] **3.2** `plugins/witops-core/mapper.js` & `dispatch.js`：
  - 补充 `rawDeveloperName` 字段；
  - 实现 5 级负责人自动关联（显式 > `ctx.store` 映射 > 当前登录用户+`currentDeveloper`/`trellis.user` 自动关联并记忆 > 名称匹配 > 旧 config / `legacyDeveloperConfig` 兼容）；
  - 未命中时返回结构化诊断结果（附带 `availableDevelopers` 与清晰中文原因）。
- [x] **3.3** `plugins/witops-core/index.js` & `plugins/witops-core/panel/index.html` & `app.js`：
  - 新增 `GET /developers` 与 `PUT /developer-bindings` 路由，扩展 `POST /dispatch/preview`、`POST /dispatch` 与 `witops.dispatch` 能力支持 `assignee` 与 `rememberBinding`；
  - 面板下发弹层展示推导负责人及可选开发者下拉框，支持修改并记住绑定，遇到 `missing-assignee` 给出可操作引导。
- [x] **3.4** `plugins/witops-core/test/index.test.js` 补充零配置自动关联当前登录用户 + `.trellis/.developer`、无匹配结构化诊断、面板下拉绑定持久化用例。

### Phase 4: Docs, Spec & Verification
- [x] **4.1** 更新 `.trellis/spec/desktop/tauri-commands/index.md`（桌面本机插件宿主契约：`plugin-state.json` 取代 `plugins/plugins.json`、`trellis.user` 注入）与 `packages/desktop/README.md`。
- [x] **4.2** 执行 `oxfmt --check`、LF 检查与测试套件，确认全部通过后进入 Phase 3.4 提交评审。
