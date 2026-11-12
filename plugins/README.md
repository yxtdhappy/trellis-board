# 插件命名与目录约定

- 插件目录名必须等于 `plugin.json` 的 `id`，例如 `plugins/scenario-copilot/` ↔ `"id": "scenario-copilot"`。
- `id` 使用小写 kebab-case，2–32 个字符，建议 `<领域>-<能力>`：`acp-dispatch`、`witops-intake`、`scenario-copilot`。
- 不在 `id` 里重复宿主名：`plugins/` 下的插件都属于 Trellis Board，`trellis-board-plugin-` 前缀会让 `/api/plugins/<id>/*`、store key 和配置键变长。
- 需要独立发布时，npm 包名可以用 `trellis-board-plugin-<id>`，manifest `id` 仍保持短名，避免破坏已有配置与路由。
- 面板 id 默认与插件 id 相同；一个插件有多个面板时使用 `<id>-<surface>`。

命名之外，插件仓库内不提交任何真实环境信息：本地绝对路径、账号、目标 URL、外部项目大纲/知识库都通过 `config` 注入。

## 测试

从仓库根目录运行 `npm run test:plugins`（等价于 `node --test plugins/*/test/*.test.js`）。
根 `npm test` 默认只跑 `apps/*/test` 与 `packages/*/test`，不包含这里的插件测试；
插件通过 `../../apps/server/plugins/sdk.js` 引用宿主 SDK。
