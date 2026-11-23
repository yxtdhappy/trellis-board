# 执行计划：客户端插件可见性

## 前置

- 任务文档在 main：`.trellis/tasks/11-23-client-plugin-role/`
- 代码落点：
  - `.worktree/trellis-board-dev`（web / desktop / scripts）
  - `.worktree/trellis-board-team`（server 门禁）
- 4403（`client/trellis-board-web`）不改。

## Step 1 服务端固定关闭（team worktree）

1. `packages/server/team/http/common.js`：`teamPluginsEnabled()` 恒 `false`，保留函数签名与注释。
2. 验证：
   ```bash
   curl -s http://127.0.0.1:4402/api/runtime | grep -o '"pluginsEnabled":[a-z]*'
   # false
   ```
3. 提交：`feat(team): always disable server-side plugins`

## Step 2 role 解析（dev worktree）

1. 新增 `packages/web/src/lib/role.ts` 与单测 `packages/web/test/role.test.ts`（或现有测试目录）。
2. `BoardPage.tsx`：
   - `const role = resolveRuntimeRole(...)`；
   - `isClient = role === 'client'`；
   - 插件入口：`isClient ? [DESKTOP_PLUGIN_NAV] : []`；
   - 客户端不调用 `fetchPanels()`。
3. `yarn build` 验证类型。

## Step 3 传输层（dev worktree）

1. 新增 `packages/web/src/api/plugin-transport.ts`：
   - `createIpcTransport()` 复用现有 `invoke` 调用；
   - `createHttpTransport()` 映射 `/local-plugin/internal/*`。
2. `desktop-plugins.ts` 改为 `getPluginTransport()`，保留导出签名。
3. `DesktopPluginsView.tsx` 不再直接 import `invoke`。

## Step 4 宿主接口（dev worktree）

1. `packages/desktop/plugin-host/host.mjs`：
   - `POST /internal/plugins/<id>/enabled` `{enabled}`：写 `plugins.json` 的 `enabled`，再 start/stop；
   - `POST /internal/plugins/<id>/request` `{method, path, body}`：复用现有 forward 逻辑。
2. 保持 `/internal/*` bearer 校验不变。

## Step 5 4401 启动（dev worktree / .worktree 脚本）

1. 新增 `.worktree/scripts/plugin-host.sh`：生成 token/secret，启动 4517。
2. `.worktree/scripts/dev.sh`：
   - 读取 `data/plugin-host-dev/env.json`；
   - 注入 `VITE_TRELLIS_ROLE=client`、`VITE_LOCAL_PLUGIN_TOKEN`。
3. `vite.config.ts` 增加 `/local-plugin` 代理。

## Step 6 desktop 注入（dev worktree）

1. `packages/desktop/src-tauri/src/main.rs` 的 `WebviewWindowBuilder` 加 `initialization_script`。
2. `cargo check`（Linux）。

## Step 7 验证（2026-11-23 本机）

1. `yarn build`：通过（`tsc -b` + vite build）。
2. 4401（`scripts/dev.sh restart`）、4402（`scripts/team.sh restart`）、4517（`scripts/plugin-host.sh restart`）已重启。
3. 浏览器 `http://127.0.0.1:4401/`：
   - 左侧“本机插件”存在（`isClient` 生效，与 `features.pluginsEnabled=false` 无关）；
   - 6 个内置插件列出；
   - `witops-core` 启用后 running，面板 iframe 加载成功；
   - 停用→“已停止”→再启用→“运行中”，开关往返通过。
4. 客户端不再请求服务端插件面板（`/api/panels` 不触发）。
5. `curl 4402/api/runtime` → `features.pluginsEnabled:false`。
6. 服务端测试：`.worktree/trellis-board-team` 根目录 `node --test "packages/server/test/*.test.js"` → 513 pass / 0 fail；`team-plugin-gating.test.js` 已改为“白名单也不能启用”。
7. 未验证：Windows GUI 打包。本机 `cargo check` 因缺少 `pkg-config` / `libdbus-1-dev` 失败；`initialization_script` 已在本地 tauri 2 源码确认存在。

## 提交拆分

1. `feat(team): always disable server-side plugins`（team worktree）
2. `feat(web): resolve client role from startup parameters`（dev worktree）
3. `feat(web): add local plugin HTTP transport`（dev worktree）
4. `feat(desktop): inject client role into board webview`（dev worktree）
5. `chore(dev): run local plugin host on 4517`（.worktree，不提交到仓库）
