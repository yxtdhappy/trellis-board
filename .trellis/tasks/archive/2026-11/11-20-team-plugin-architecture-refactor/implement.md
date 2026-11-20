# 实施总计划：团队版主线插件体系改造

> 本父任务为协调层任务，不直接执行 `task.py start`。所有 3 个 Open Questions 已由用户拍板收敛，编码按 Phase 1 → 2 → 3 在各子任务中串行启动并验收。

## 1. 已确认前置条件

- [x] 决策 1：生产服务器默认屏蔽全部插件（`TRELLIS_TEAM_PLUGINS_ALLOWLIST` 默认空 `[]`，显式配置才开启）。
- [x] 决策 2：6 大内置插件全部进入桌面 EXE 本机宿主并简化配置，除账号相关信息外启用即用。
- [x] 决策 3：Standalone 降级不再维护，相关文档已完成降级说明更新（暂不建归档任务）。
- [ ] 待用户确认最终 Planning 摘要并显式授权后，按顺序启动子任务 1。

## 2. 子任务执行顺序与里程碑

### Phase 1：`11-20-team-plugin-server-gating`（服务器默认屏蔽与入口收敛）
1. `packages/server/config.js` 解析 `TRELLIS_PLUGINS_DISABLED` 与 `TRELLIS_TEAM_PLUGINS_ALLOWLIST`（默认空 `[]`）。
2. `packages/server/team/http.js` 与 `context.js` 实现关闭态零子进程、匿名面板资源屏蔽及 `/api/runtime` `features.pluginsEnabled` 下发。
3. `BoardPage.tsx`（Team 下移除单机「插件」Tab）与 `AdminPage.tsx`（`!pluginsEnabled` 时隐藏管理页「插件」Tab）。
4. `plugins/witops-core` 修复多用户缓存分区与模块级状态副作用（兜底防显式放行时串数据）。
5. 验证归档后进入 Phase 2。

### Phase 2：`11-20-desktop-local-plugin-host`（桌面 EXE 本机插件宿主与双通道桥接）
1. 封装最小化本机插件宿主启动脚本（复用 `PluginSupervisor`、支持 `127.0.0.1` loopback + 随机令牌或 stdio）。
2. `packages/desktop/src-tauri/` 新增 `plugin_host.rs`：懒启动、环境门 `node.exe` 复用、按 `(serverHash, userId)` 隔离数据与 DPAPI 凭据、切号/退出停进程、`ensure_board_caller` 同源 IPC 命令、挂载当前账号 `localAssociations` 为 `trellis.projects`/`ctx.tasks`。
3. 更新 `tauri.conf.json` / `package-portable.ps1` 将本机宿主脚本与内置插件目录（不含测试文件）纳入桌面打包分发。
4. 更新 `BoardPage.tsx`、`PluginPanel.tsx` 与桌面本机插件管理 UI（仅 `isTauri === true` 渲染，纯浏览器零可见）。
5. 验证归档后进入 Phase 3。

### Phase 3：`11-20-desktop-plugins-zero-config`（6 大插件入驻适配与极简零配置）
1. 为 `packages/server/plugins/version.js` 与插件清单规范增加 `targets`（如 `['desktop']`）支持。
2. 逐个精简 `accounts-core`、`witops-core`、`jenkins-ops`、`acp-dispatch`、`scenario-copilot`、`a2a-intake` 的 `plugin.json` 配置字段，将调优参数下沉代码 `DEFAULTS`，补齐项目/路径/token/CLI 自动推导逻辑，确保空 `config` 启用即用。
3. 修复并跑通跨插件联动（`accounts-core` 统一凭据 → `witops-core` / `jenkins-ops`；`witops-core` / `a2a-intake` 写任务 → Rust `TaskSync` 上行同步）。
4. 全量单元、插件与 Windows 绿色包实机验收。

## 3. 跨阶段验证命令

```bash
yarn test
yarn test:plugins
yarn --cwd packages/web lint
yarn --cwd packages/web build
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
```

## 4. 回滚策略

- 三个子任务独立分批交付，Standalone 存量代码与测试保持不破。
- 服务器端开关纯环境变量驱动，发现异常设 `TRELLIS_PLUGINS_DISABLED=1` 重启即可秒级回滚。
- 桌面端本机插件宿主采用懒启动且与核心 `agent_service.rs` 解耦，关闭本机插件即可恢复纯同步客户端行为。
