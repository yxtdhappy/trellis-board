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

## 测试

从仓库根目录运行 `yarn test:plugins`（等价于 `node --test plugins/*/test/*.test.js`）。
根 `yarn test` 默认只跑 `packages/*/test` 与 `packages/*/test`，不包含这里的插件测试；
插件通过 `../../packages/server/plugins/sdk.js` 引用宿主 SDK。
