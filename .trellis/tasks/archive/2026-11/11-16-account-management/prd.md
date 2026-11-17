# 账号管理插件（内网 AD 统一账号）

## 背景与动机

- 公司内网系统（witops、jenkins 等）统一由内网 AD 认证，账号密码相同，用户希望集中维护，避免每个系统/每个插件各录一遍。
- 现状凭据分散：
  - `plugins/jenkins-ops/index.js:19` 用 secret `jenkins-ops/password`，用户名在 `plugins.json` 的 `config.username`；
  - `plugins/witops-core/` 用 token 等配置；
  - 各插件配置里还有 baseUrl、账号等重复项。

## 已确认事实（代码/规范证据）

- **secret 按插件隔离**：`apps/server/plugins/supervisor.js:1560 requirePluginSecretKey` 强制 key 以 `<pluginId>/` 开头，「插件只能访问自己的 secret」。因此「一个插件替其他插件取密码」不能直接读 secret，必须走 capability。
- **存储**：插件不碰 SQLite，只能 `ctx.store`（宿主按 `<pluginId>:<key>` 隔离）；凭据写 `ctx.secrets`（宿主加密落盘，见 `apps/server/plugins/secrets.js`）。
- **插件清单约定**（`.trellis/spec/backend/plugin-runtime.md` §2/§2.1）：目录名 = `id`，kebab-case `<领域>-<能力>`；`name` 为中文展示名且不能等于 id；`description` 必填；`permissions` 需显式声明。
- **面板**：`plugin.json.panels` + `permissions: ["panels","http:route"]`；插件静态资源在 `panel/`，宿主转发 `/api/plugins/<id>/panel`。
- **可参考实现**：`plugins/jenkins-ops/`（capability provide + panel + secrets 读写 + config）、`apps/server/test/plugin-*.test.js` 测试写法、`packages/test-support/plugin-runtime.js` harness。
- **开发环境**：`.worktree/trellis-board-dev`（分支 `codex/trellis-board-dev`，端口 4401，数据 `.worktree/trellis-board-dev-data`；当前已停止，需要时 `./dev.sh start`）。

## 已定决策

1. **定位**：账号簿 + 凭据 capability。面板集中维护；其他插件通过 `accounts.credentials` capability 复用。
2. **数据模型**：账号为中心，系统引账号。`accounts[{id,username,note}]` + `systems[{id,name,baseUrl,accountId,enabled}]`，密码存 `accounts-core/account/<id>/password`。
3. **凭据验证**：账号插件不做验证，由各调用方按自己的系统语义验证。
4. **接入方**：`jenkins-ops` 与 `witops-core` 接入；两者保留本地账号配置作为独立运行的回退（`credentialSource: auto|local|account`，默认 auto=统一账号优先）。
5. **UI 统一**：账号/登录界面只实现一份——accounts-core 面板负责编辑，另提供 `credentials-widget.js` 供 jenkins/witops 面板复用；缺失时静默降级为本地表单。
6. **命名**：目录与 id 为 `accounts-core`，展示名「统一账号」，capability `accounts.credentials` v1.0.0。

## 暂定非目标

- 不做 SSO / 网页自动登录 / 代填表单
- 不改动现有插件（除非定位选择「凭据 capability」需要消费方接入）

## 验收草案（待定稿）

- 插件能在 dev（4401）启动并 `status=running`，`/api/plugins` 可见
- 面板可增删改查内网系统账号记录
- 凭据落 `ctx.secrets`，不写入 `plugins.json` 明文、不打日志
- 新增插件测试（manifest + store/secrets 行为 + HTTP 路由），`npm run test:plugins` 通过
