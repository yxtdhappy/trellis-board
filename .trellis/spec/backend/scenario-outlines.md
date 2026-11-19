# Scenario 测试大纲关联与生成

适用：`plugins/scenario-copilot/` 与 `plugins/witops-workbench/` 的测试大纲解析、关联、生成和回归预检。

## 1. 范围 / 触发条件

- 新增或修改测试大纲（outline）解析、关联、生成、回归入口时必须遵守本文。
- 触发原因：大纲曾经只靠文件名/默认值猜测，导致运行了错误模块的用例；生成又可能超过宿主插件 HTTP 超时。

## 2. 签名

### scenario-copilot capability

```text
outlines.resolve      { subjects: Subject[] } -> { results: Record<key, Resolution> }
outlines.associate    { name, scope, requirementIds?, requirementCodes?, taskKeys?, route?, status?, mode? } -> { outline, outlines }
outlines.save         { name, content, title?, scope?, requirementIds?, requirementCodes?, taskKeys?, route?, source?, status?, overwrite? } -> { name, title, size, outline, outlines }
regressions.preflight { subjects: Subject[] } -> { ready, total, missing }
```

### witops-workbench HTTP

```text
GET  /api/plugins/witops-workbench/test-defaults
GET  /api/plugins/witops-workbench/tests?ids=...
POST /api/plugins/witops-workbench/tests
POST /api/plugins/witops-workbench/tests/outline       # preview -> 202 {jobId}; save + content -> 200
GET  /api/plugins/witops-workbench/tests/outline?jobId=...
POST /api/plugins/witops-workbench/outlines/associate
POST /api/plugins/witops-workbench/regressions/preflight
```

## 3. 契约

### 3.1 大纲元数据

大纲正文仍是 `outlinesDir/*.md`；关联元数据写在同目录 `outlines.manifest.json`：

```json
{
  "version": 1,
  "outlines": {
    "dm-business-category.md": {
      "title": "业务分类",
      "scope": "requirement",
      "requirementIds": ["35627"],
      "requirementCodes": ["R35627"],
      "taskKeys": [],
      "route": "/dm/model/materializedModel",
      "source": "manual",
      "status": "active",
      "createdAt": "2026-11-19T00:00:00.000Z",
      "updatedAt": "2026-11-19T00:00:00.000Z",
      "contentHash": "..."
    }
  }
}
```

- `scope`：`requirement` | `task`；默认 `requirement`。
- `status`：`active` | `draft` | `archived`；解析只选 `active`。
- 不写环境 URL；`route` 只存 pathname/hash 路由。
- `manifest` 缺失或损坏时回退为空，不阻塞列表；写入用临时文件 + `rename`。
- **不要**把元数据写进 `.md` frontmatter：`src/parser/outline-parser.ts` 会把 `---` 和未知 `key:value` 当正文节点。

### 3.2 解析优先级

大纲（第一个可用项）：

1. `input.outline`（explicit）
2. 任务/需求 binding 的 `outline`
3. `manifest.taskKeys` 命中
4. `manifest.requirementIds` / `requirementCodes` 命中
5. 任务目录 basename 与文件 stem 互相包含（filename-guess，低置信）
6. `config.defaultOutline`（仅当没有 requirementId/taskKey，或显式 `allowDefaultOutline:true`）
7. 无（`none`）

目标地址：

1. `input.targetUrl`
2. 任务 binding
3. 需求 binding
4. 任务元数据 `testUrl`
5. `config.targetUrl`

禁止使用 `listOutlines()[0]` 或“任意带 targetUrl 的 target”兜底。

### 3.3 长任务

宿主 `http/request` 默认 30s，插件侧无法延长。生成预览统一走后台 job：

- `POST /tests/outline` 无 `content`：立即返回 `202 {jobId, status:"running"}`。
- `GET /tests/outline?jobId=...`：`status` 为 `running` | `done` | `error`；完成后 `result` 含 `draft/context`。
- 带 `content` 的保存仍同步返回。
- 面板 `TrellisBridge.create({ timeout: 300000 })`，轮询间隔 1.5s，最多 300s。

## 4. 校验与错误矩阵

| 条件 | 返回 |
| --- | --- |
| `runs.start` 无大纲 | `2002` + `needOutline:true` + `candidates` |
| 大纲文件不存在 | `2002` + `needOutline:true` + `candidates` |
| 目标地址为空 | `2003` |
| 工作台 `POST /tests` 无大纲 | HTTP 400 + `code:2011` + `needOutline:true` |
| 回归预检大纲缺失 | `missing[].reasons` 含 `outline-missing` |
| 回归预检只命中推测/默认大纲 | `outline-guessed` |
| 回归预检目标地址缺失 | `url-missing` |
| 预检未通过且未显式 `allowMissing:true` | `2011` + `missing` |
| 关联不存在的大纲 | `2002` 或 HTTP 400 |

`missing[]` 至少包含 `key`、`title`、`requirementCode`、`outline`、`outlineSource`、`targetUrl`、`reasons`。

## 5. 好 / 基线 / 坏案例

- **好**：R35627 的 `dm-business-category.md` 在 manifest 中声明 `requirementIds:["35627"]`，工作台解析为 `manifest-requirement/high`。
- **基线**：没有 manifest 时，文件名 `R35627-xxx.md` 只能作为低置信候选，界面标黄并允许用户改写。
- **坏**：没有关联时静默拿 `defaultOutline` 去跑另一个模块的用例；或回归时从别的 target 借一个 `targetUrl`。

## 6. 必测断言

- `outlines.associate` 后 `outlines.resolve` 返回 `source=manifest-requirement`、`confidence=high`。
- `task.relativeDir` 关联到需求后，Trellis 任务 target 继承需求大纲。
- 无大纲 `runs.start` 返回 `needOutline`，且不创建运行记录。
- `regressions.preflight` 对无大纲需求返回 `outline-missing`，不误判为 explicit。
- `POST /tests/outline` preview 返回 202，轮询拿到 `draft`；save 带 `content` 同步落盘并更新 manifest。
- 面板 1006px 与 360px 下 dialog `scrollWidth === clientWidth`。

参考测试：`plugins/scenario-copilot/test/outline-flow.test.js`。

## 7. 错误写法与正确写法

### 错误

```js
const outlineName = text(input.outline) || text(binding.outline) || listOutlines(config)[0]?.name || ''
```

### 正确

```js
const resolution = resolveOutlineForSubject(subject, raw)
if (!resolution.outline) {
  throw ctx.error(2002, '未关联测试大纲，请先生成或选择测试大纲', { needOutline: true })
}
```

## 8. 插件重启注意

- 改 `plugin.json` 的版本、`requires`/`provides` 后必须重启**整个 server**；只 stop/start 插件不会重读 manifest，可能出现 `1008 插件握手版本与清单不一致`。
- 改 `outlinesDir` 后同样要重启，运行中的子进程不会重新读取 `plugins.json`。
