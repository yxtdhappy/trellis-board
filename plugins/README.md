# 插件命名与目录约定

- 插件目录名必须等于 `plugin.json` 的 `id`，例如 `plugins/scenario-copilot/` ↔ `"id": "scenario-copilot"`。
- `id` 使用小写 kebab-case，2–32 个字符，建议 `<领域>-<能力>`：`acp-dispatch`、`witops-intake`、`scenario-copilot`。
- 不在 `id` 里重复宿主名：`plugins/` 下的插件都属于 Trellis Board，`trellis-board-plugin-` 前缀会让 `/api/plugins/<id>/*`、store key 和配置键变长。
- 需要独立发布时，npm 包名可以用 `trellis-board-plugin-<id>`，manifest `id` 仍保持短名，避免破坏已有配置与路由。
- 面板 id 默认与插件 id 相同；一个插件有多个面板时使用 `<id>-<surface>`。

- 插件入口按 `./plugins/<id>/<sub>` 解析：先找 `<TrellisBoard>/plugins/<id>/<sub>`（用户目录，
  默认 `%LOCALAPPDATA%\TrellisBoard\plugins`），不存在再回落安装目录的 `plugins/<id>/<sub>`。
  用户目录可以只放 `index.js` + `plugin.json` 覆盖安装目录，也可以在 `plugins.json` 登记全新插件。
- 命名之外，插件仓库内不提交任何真实环境信息：本地绝对路径、账号、目标 URL、外部项目大纲/知识库都通过 `config` 注入。

## 面板排序

- `plugins.json` 的插件条目可以写 `"sort": 10`（数字，可省略）。数字小的插件排在前面，同时决定
  `/api/plugins` 的卡片顺序与 `/api/panels` 的面板顺序，优先于 `plugin.json` 里的 `panels[].order`；
  没写的插件保持文件顺序排在后面。
- 插件页直接拖动卡片排序（卡片左上角的 ⠿ 是把手，聚焦后也能用 ↑ ↓）。服务端收到
  `POST /api/plugins/order`（`{"ids": [...]}`）后把 `plugins.json` 的 `plugins` 数组按新顺序重排，
  并依次写入 `sort = 10/20/30…`，插件不重启，看板左侧导航立即重排。

## 跨插件凭据

- 宿主 secret 按插件隔离（`<pluginId>/<key>`），需要共用同一套账号密码时走 capability 而不是共享 secret。
- `plugins/accounts-core` 是统一账号源，提供 `accounts.credentials`（`accounts.list`、`systems.list`、`credential.resolve`）。
  消费方声明 `"permissions": ["capabilities:call"]` 与 `requires: [{ "name": "accounts.credentials" }]`，
  并用 `credentialSource`（`auto`/`accounts`/`local`）+ `accountSystemId` 控制优先级，解析失败时回退本地配置。
- 面板复用 `accounts-core/panel/widget/credentials-widget.js`，只调自己的 `GET /credentials`；密码不进任何 HTTP 响应。
  详见 `plugins/accounts-core/README.md`。

## 面板 UI

- 按钮、输入、表格、字段、标签、对话框、提示条、可搜索下拉框由宿主 `/plugin-ui/v1/` 提供，
  **不要**在插件里复制一份，也不要把通用组件放进 `panel/widget/`（那是给跨插件复用的小组件用的）。
- 颜色只用 `--tb-*` 设计令牌；宿主会把当前主题的计算值下发到面板，换主题/配色无需改插件。
- 引法与 API 见 `.trellis/spec/backend/plugin-runtime.md` 7.2，可视展柜是 `/plugin-ui/v1/demo.html`。

## 测试

从仓库根目录运行 `npm run test:plugins`（等价于 `node --test plugins/*/test/*.test.js`）。
根 `npm test` 默认只跑 `apps/*/test` 与 `packages/*/test`，不包含这里的插件测试；
插件通过 `../../apps/server/plugins/sdk.js` 引用宿主 SDK。
