# scenario-copilot

把 `@mom-cli/scenario-copilot` 接入 Trellis Board 的客户端插件：按 Trellis 任务或需求级测试对象，用测试大纲生成并执行 Playwright 场景，支持单次运行与批量回归，结果通过「自动化测试」面板查看。面板也能把需求描述直接交给 LLM 生成结构化大纲并保存到 `outlinesDir`。

## 命名

- 插件 id 与目录名都使用 `scenario-copilot`，不带 `trellis-board-` 前缀。`plugins/` 下的插件都属于 Trellis Board，前缀只会让 API 路径和配置重复。
- 如果后续独立发布 npm 包，包名使用 `trellis-board-plugin-scenario-copilot`；manifest `id` 仍保持 `scenario-copilot`，避免破坏已有 store、路由和配置。
- 同类插件按 `<领域>-<能力>` 命名，例如 `witops-intake`、`acp-dispatch`。

## 安装

1. 准备 scenario-copilot 源码并安装依赖，确认存在：

```text
<scenarioRoot>/dist/bin/scenario-copilot.js
```

2. 在插件配置目录的 `plugins.json`（默认 `<TrellisBoard>/plugins/plugins.json`）启用：

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
| `outlinesDir` | 测试大纲目录；面板从该目录读取 `.md` / `.txt`，并在同目录维护 `outlines.manifest.json` 关联元数据 |
| `defaultOutline` | 仅在没有需求/任务上下文时作为兜底；有上下文时不再静默使用默认大纲 |
| `targetUrl` | 未在任务/需求或 binding 上配置目标地址时的兜底地址 |
| `knowledgePath` | 可选的领域知识文件；为空则不注入 |
| `orgName` / `username` / `password` | 目标环境登录信息 |
| `llmBaseUrl` / `llmApiKey` / `llmModel` | 生成场景与大纲使用的 LLM；由部署配置注入，仓库不提供默认值 |
| `outlineTimeoutMs` | 单次大纲生成的超时，默认 5 分钟（30s–15min） |
| `timeoutMs` | 单次 pipeline 超时，默认 15 分钟 |
| `maxRuns` | 内存中保留的运行记录数 |
| `maxHealingRetries` | 生成脚本时的自愈重试次数，默认 1 |

## 能力

manifest `provides` 发布 `scenario.copilot` v1.3.0：

- `defaults.get` / `bindings.get`
- `runs.list` / `runs.get` / `runs.start` / `runs.cancel`
- `regressions.start` / `regressions.get` / `regressions.cancel`
- `outlines.list` / `outlines.generate` / `outlines.save`
- `outlines.resolve` / `outlines.associate`
- `regressions.preflight`
- `runs.resume`（`action: next | only-failed | regenerate`）

`witops-workbench` 通过宿主能力桥调用这些方法，不直接依赖 HTTP 路由。

## 大纲关联与解析

大纲文件本身仍是 `OutlineParser` 能消费的 Markdown，不写 YAML frontmatter。关联信息放在同目录的 `outlines.manifest.json`：

```json
{
  "version": 1,
  "outlines": {
    "R35627-business-category.md": {
      "title": "业务分类",
      "scope": "requirement",
      "requirementIds": ["35627"],
      "requirementCodes": ["R35627"],
      "taskKeys": [],
      "route": "/dm/model/materializedModel",
      "source": "generated",
      "status": "active",
      "contentHash": "sha256..."
    }
  }
}
```

- `outlines.associate({name, scope, requirementIds, requirementCodes, taskKeys, route, mode})`：把已有大纲关联到需求/任务；`mode=merge` 合并，`replace` 覆盖关联字段。
- `outlines.resolve({subjects})`：批量解析每个测试对象的大纲与目标地址。
- 解析优先级：显式选择 > 任务 binding > 需求 binding > manifest taskKeys > manifest requirementIds/requirementCodes > 文件名推测 > 默认大纲（仅无上下文）> 无。
- 文件名推测和默认大纲都会标记为低置信；没有显式关联时不会再把 `listOutlines()[0]` 当成兜底。
- 回归下发前调用 `regressions.preflight`，缺失原因区分 `outline-missing` / `outline-guessed` / `url-missing` / `subject-invalid`；默认拒绝执行，`allowMissing: true` 才继续。

## 生成大纲

`outlines.generate` 走 CLI 的 `outline` 命令（`<scenarioRoot>/dist/bin/scenario-copilot.js outline --json`），把页面粘贴的需求描述 / 测试要点转成 `OutlineParser` 能消费的 Markdown：`# 标题`、`## 前置条件`、`## 用例 N：名称`、编号步骤。CLI 侧提示词会要求不写登录步骤与 URL，返回后会做结构校验并把问题放进 `warnings`。

- 路由：`POST /outlines/generate`（`{title, requirementText, notes, requirementId, targetRoute, caseCount}`）、`POST /outlines/save`（`{content, name, overwrite, scope, requirementIds, requirementCodes, taskKeys, route, source, status}`）、`POST /outlines/associate`、`POST /outlines/resolve`、`POST /regressions/preflight`、`GET /outlines`
- 面板入口：测试大纲行右侧「生成大纲」，生成后可预览、命名并保存，保存后自动选中；已有大纲可点「关联当前选择」写明需求/任务关联
- 依赖：CLI 已构建出 `dist/bin/scenario-copilot.js`，且 `llmBaseUrl` / `llmApiKey` / `llmModel` 可用；CLI 缺失时面板隐藏该按钮（`defaults.canGenerateOutline`）

## 分阶段与续跑

CLI 的 `pipeline` 支持断点与阶段控制，插件把这些能力开放到面板：

| 机制 | CLI 参数 | 面板入口 |
| --- | --- | --- |
| 只跑前几个阶段 | `--stop-after recon\|generate\|verify\|execute` | 表单「执行阶段」下拉 |
| 复用上次脚本 | `--resume` | 「继续下一阶段」「仅重跑失败用例」自动带上 |
| 只重跑失败用例 | `--only-failed` + `--resume` | 运行详情的「仅重跑失败用例」 |
| 强制重新生成 | `--regenerate` | 运行详情的「重新生成」 |
| 状态隔离 | `--state-key <subject>::<outline>` | 自动生成，避免同一大纲被多任务互相覆盖 |

- 状态文件在 `<workspaceDir>/runs/<key>.json`，记录阶段、脚本/快照哈希、覆盖率与 `lastExecution.failedTests`
- 主动停在中间阶段的运行状态是 `paused`（不是 failed），详情里显示「停在 <阶段>」，可直接继续下一阶段
- 续跑复用的前提是大纲、UI 契约版本与页面快照哈希都没变；任一变化会自动重新生成
- 每次运行结束时 CLI 打印一条 `[scenario-copilot] result: {...}`，插件据此回填 `stage/paused/nextStage/resumed/failedTests/statePath/scriptPath/coveragePassed`

## 使用

在客户端「自动化测试」面板，或由 `witops-workbench` 下发：

1. 选择 Trellis 任务（支持归档任务）或需求级测试对象。
2. 需要新大纲时点「生成大纲」，粘贴需求后生成并保存到 `outlinesDir`。
3. 第一次填写目标页面地址；地址会写入该 subject 的 binding，下次自动带出。
4. 选择 `outlinesDir` 中的测试大纲后下发，生成版本化 spec，例如：

```text
<witops>-<trellis>-<timestamp>-v1.spec.ts
```

5. 需求级 subject 使用 `requirement:<requirementId>`，Trellis 任务使用 `trellis:<taskKey>`；回归任务按 subject 串行执行，单个失败不会中断后续对象。
6. 打开运行记录查看阶段日志、生成的 spec 和最终结果；可继续下发命令或取消运行。

## 权限

- `tasks:read`：读取 Trellis 任务与元数据
- `store`：保存任务地址、测试版本等 binding
- `events:emit` / `events:publish`：向面板推送运行状态
- `http:route`：面板通过 `/api/plugins/scenario-copilot/*` 调用插件
- `panels`：声明「自动化测试」面板
- `capabilities:provide`：发布 `scenario.copilot` 能力
