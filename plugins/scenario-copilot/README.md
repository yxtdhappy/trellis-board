# scenario-copilot

把 `@mom-cli/scenario-copilot` 接入 Trellis Board 的客户端插件：按 Trellis 任务或需求级测试对象，用测试大纲生成并执行 Playwright 场景，支持单次运行与批量回归，结果通过「自动化测试」面板查看。

## 命名

- 插件 id 与目录名都使用 `scenario-copilot`，不带 `trellis-board-` 前缀。`plugins/` 下的插件都属于 Trellis Board，前缀只会让 API 路径和配置重复。
- 如果后续独立发布 npm 包，包名使用 `trellis-board-plugin-scenario-copilot`；manifest `id` 仍保持 `scenario-copilot`，避免破坏已有 store、路由和配置。
- 同类插件按 `<领域>-<能力>` 命名，例如 `witops-intake`、`acp-dispatch`。

## 安装

1. 准备 scenario-copilot 源码并安装依赖，确认存在：

```text
<scenarioRoot>/dist/bin/scenario-copilot.js
```

2. 在 `data/plugins.json` 启用：

```json
{
  "id": "scenario-copilot",
  "module": "./plugins/scenario-copilot/index.js",
  "enabled": true,
  "config": {
    "scenarioRoot": "<path-to-scenario-copilot-package>",
    "workspaceDir": "",
    "outlinesDir": "<path-to-outlines>",
    "defaultOutline": "",
    "targetUrl": "",
    "knowledgePath": "<path-to-knowledge.md>",
    "username": "",
    "password": "",
    "llmBaseUrl": "",
    "llmApiKey": "",
    "llmModel": ""
  }
}
```

`scenarioRoot` 必须显式配置；`workspaceDir` 留空时使用插件目录下的 `workspace/`，该目录已被 `.gitignore` 忽略。`outlinesDir` 与 `knowledgePath` 也由配置注入，仓库不内置任何外部项目的大纲或知识库。

## 配置

| 字段 | 说明 |
| --- | --- |
| `scenarioRoot` | scenario-copilot 包目录，必须包含 `dist/bin/scenario-copilot.js` |
| `workspaceDir` | spec、snapshot、Playwright storageState 的输出目录 |
| `outlinesDir` | 测试大纲目录；面板从该目录读取 `.md` / `.txt` |
| `defaultOutline` | 未指定大纲时的默认大纲文件名 |
| `targetUrl` | 未在任务/需求或 binding 上配置目标地址时的兜底地址 |
| `knowledgePath` | 可选的领域知识文件；为空则不注入 |
| `orgName` / `username` / `password` | 目标环境登录信息 |
| `llmBaseUrl` / `llmApiKey` / `llmModel` | 生成场景使用的 LLM；由部署配置注入，仓库不提供默认值 |
| `timeoutMs` | 单次 pipeline 超时，默认 15 分钟 |
| `maxRuns` | 内存中保留的运行记录数 |
| `maxHealingRetries` | 生成脚本时的自愈重试次数，默认 1 |

## 能力

manifest `provides` 发布 `scenario.copilot` v1.0.0：

- `defaults.get` / `bindings.get`
- `runs.list` / `runs.get` / `runs.start` / `runs.cancel`
- `regressions.start` / `regressions.get` / `regressions.cancel`

`witops-workbench` 通过宿主能力桥调用这些方法，不直接依赖 HTTP 路由。

## 使用

在客户端「自动化测试」面板，或由 `witops-workbench` 下发：

1. 选择 Trellis 任务（支持归档任务）或需求级测试对象。
2. 第一次填写目标页面地址；地址会写入该 subject 的 binding，下次自动带出。
3. 选择 `outlinesDir` 中的测试大纲后下发，生成版本化 spec，例如：

```text
<witops>-<trellis>-<timestamp>-v1.spec.ts
```

4. 需求级 subject 使用 `requirement:<requirementId>`，Trellis 任务使用 `trellis:<taskKey>`；回归任务按 subject 串行执行，单个失败不会中断后续对象。
5. 打开运行记录查看阶段日志、生成的 spec 和最终结果；可继续下发命令或取消运行。

## 权限

- `tasks:read`：读取 Trellis 任务与元数据
- `store`：保存任务地址、测试版本等 binding
- `events:emit` / `events:publish`：向面板推送运行状态
- `http:route`：面板通过 `/api/plugins/scenario-copilot/*` 调用插件
- `panels`：声明「自动化测试」面板
- `capabilities:provide`：发布 `scenario.copilot` 能力
