# 实施计划（accounts-core 统一账号）

分支：`codex/trellis-board-dev`（worktree `.worktree/trellis-board-dev`，端口 4401，数据 `.worktree/trellis-board-dev-data`）

## 0. 前置

- [ ] 读 `.trellis/spec/backend/plugin-runtime.md`、`.trellis/spec/backend/plugin-testing.md`
- [ ] 确认 dev worktree 依赖在：`cd .worktree/trellis-board-dev && [ -d node_modules ] || TRELLIS_BOARD_SKIP_PREPARE=1 npm install`
- [ ] 验证前启动服务：`cd .worktree && ./dev.sh start`

## 1. accounts-core 骨架（store + secrets + capability）

文件：

```text
plugins/accounts-core/plugin.json
plugins/accounts-core/index.js
plugins/accounts-core/test/manifest.test.js
plugins/accounts-core/test/index.test.js
plugins/accounts-core/README.md
```

要点：

- `createPlugin({ name, version, apiVersion, permissions, async onStart(ctx) })`，与 `plugins/jenkins-ops/index.js:150` 同构。
- 数据读写封装：
  - `readAccounts()/writeAccounts()`、`readSystems()/writeSystems()` 基于 `ctx.store.get/set('accounts'|'systems')`；
  - 密码：`ctx.secrets.set('accounts-core/account/'+id+'/password', pwd)`、`.get`、`.delete`；`list` 时只返回 `hasPassword`。
- capability 注册：`ctx.capabilities.register('accounts.credentials', { 'accounts.list': ..., 'systems.list': ..., 'credential.resolve': ... })`。
  - `credential.resolve`：校验 system 存在且 `enabled !== false`、`accountId` 存在且有密码；否则抛 `PluginError(1004, '系统未绑定可用凭据')`。
- HTTP 路由（`onStart` 里 `ctx.http.route`）：

```text
GET  /status
GET  /accounts
POST /accounts
DELETE /accounts
POST /accounts/password
DELETE /accounts/password
GET  /systems
POST /systems
DELETE /systems
```

- 校验：id 用 kebab-case；username 必填；`accountId` 必须存在；删除被引用账号返回 409 语义（`{ status: 409, body: { error, systems: [...] } }`）。
- 日志只写 systemId/accountId，不写密码。

测试（L3，`createHarness` + `startHttpServer`）：

- manifest：id/name/description/apiVersion/permissions/provides 方法齐全，`name !== id`。
- index：建账号 → 写密码 → 建系统绑定 → `GET /systems` 含绑定；重复 id 更新；删被引用账号 409；删系统后账号可删；重启 harness 后数据仍在（store + secrets 落盘）。

## 2. accounts-core 面板

文件：`plugins/accounts-core/panel/{index.html,app.js,app.css}`

- 参考 `plugins/jenkins-ops/panel/app.js`：DOM API 构建（禁用 innerHTML）、postMessage 桥（`trellis:init` / `trellis:request` / `trellis:response`）、主题变量。
- 两个页签：账号（列表 + 新建/编辑 + 设密码 + 删除）、系统（列表 + 新建/编辑 + 绑定账号下拉 + 启用开关）。
- 缺密码时在列表上给红点/文案「未设置密码」。

## 3. 共享 widget

文件：`plugins/accounts-core/panel/widget/credentials-widget.{js,css}`

- 暴露 `window.TrellisCredentialsWidget.mount({ root, request, systemId, openAccountsHint })`。
- 渲染内容：系统名、生效账号、来源（统一账号/本地）、缺密码提示、维护入口提示。
- 无依赖、无框架，可被任意面板 `<script src="/api/plugins/accounts-core/panel/widget/credentials-widget.js">` 引入。

## 4. jenkins-ops 接入

文件：`plugins/jenkins-ops/plugin.json`、`plugins/jenkins-ops/index.js`、`plugins/jenkins-ops/panel/app.js`、`plugins/jenkins-ops/test/index.test.js`

- manifest：`permissions` 加 `capabilities:call`；`requires: [{ name: 'accounts.credentials', version: '^1.0.0' }]`；
  `config` 加 `credentialSource: "auto"`、`accountSystemId: "jenkins"`。
- `resolveCredentials(ctx, config)`：

```text
source=local            -> 本地（config.username/password、secret jenkins-ops/password）
source=account/auto     -> capability credential.resolve({ system: accountSystemId })
  成功：username/password 来自 accounts，source='accounts'
  失败：auto 回退本地；account 模式保留错误并标记 unavailable
```

- 新增代理路由 `GET /credentials`：返回 `{ source, systemId, username, hasPassword, error? }`（面板 widget 用，不返回密码）。
- `/status` 带上 `credentialSource`、`accountSystem`。
- 面板：密码输入换成 widget 挂载点；保留「本地覆盖」折叠区写 secret。
- 测试：三组用例（capability 成功 / capability 缺失回退 / `source=local` 不调用 capability）。

## 5. witops-core 接入

文件：`plugins/witops-core/plugin.json`、`plugins/witops-core/auth.js`、`plugins/witops-core/panel/app.js`、`plugins/witops-core/test/index.test.js`

- manifest：`requires` 加 `accounts.credentials`；`config` 加 `credentialSource: "auto"`、`accountSystemId: "witops"`。
- `auth.js` 的 `login()`：无本地 password 时先 capability 解析，成功则用其 account/password 登录并记录 `source='accounts'`；失败回退现有面板输入/token 流程。
- 面板：登录表单的账号/密码区替换为 widget（token 应急模式保留）。
- 测试：解析成功走统一账号、解析失败走本地、`token` 模式不受影响。

## 6. dev 环境验证

```bash
cd /opt/app/work/github/trellis-board/.worktree/trellis-board-dev
npm run test:plugins            # 全绿
cd .. && ./dev.sh start
curl -s -X POST http://127.0.0.1:4401/api/plugins/reload -H 'content-type: application/json' -d '{}'
curl -s http://127.0.0.1:4401/api/plugins | node -e "..."   # accounts-core = running
curl -s http://127.0.0.1:4401/api/panels                     # 出现「统一账号」
```

手工/脚本回归：

1. 通过 `/api/plugins/accounts-core/*` 建账号 + 系统绑定 → 重启 dev → 数据仍在。
2. `POST /api/plugins/accounts-core/accounts/password` 写密码后，jenkins-ops `/credentials` 显示 `source=accounts`。
3. `POST /api/plugins/accounts-core/stop` → jenkins-ops `/credentials` 变 `source=local`，仍可触发构建（本地密码）。
4. 面板渲染：打开「统一账号」面板与 Jenkins 面板确认 widget 出现、深浅色正常。

## 7. 收尾

- [ ] `plugins/README.md` 增加 accounts-core 条目（5 行内）
- [ ] `.trellis/spec/backend/plugin-runtime.md` 补 capability 复用凭据的约定（任务完成后按 update-spec 流程）
- [ ] dev 的 `plugins/witops-core/` 是 gitignore 副本：合并回 main 前
      `rsync -a plugins/witops-core/ /opt/app/work/github/trellis-board/plugins/witops-core/`
- [ ] `npm test` 与 `npm run test:plugins` 全绿；`git status` 无 secrets/数据文件

## 风险检查

- 密码只在 `ctx.secrets` 与 capability 返回值中出现，禁止进 `plugins.json`、日志、测试快照。
- capability 未注册时消费方必须走回退，不能抛未捕获错误导致插件崩溃。
- 面板 `<script>` 跨插件加载失败必须静默降级。
