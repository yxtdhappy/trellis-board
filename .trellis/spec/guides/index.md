# 项目思考指南

本目录只记录 Trellis Board 当前代码里真实存在的跨层契约和复用边界。它不是通用最佳实践合集；如果代码行为变化，应同步修改对应指南。

## 何时阅读

| 场景 | 必读 |
| --- | --- |
| 修改 13 个流程阶段、阶段推导或人工阶段 | [跨层契约](./cross-layer-thinking-guide.md) |
| 修改 `/api/*` 请求或响应、列表与详情字段 | [跨层契约](./cross-layer-thinking-guide.md) |
| 修改 Team taskSpace、tasks-only 快照、Agent 命令或 Board SSE | [跨层契约](./cross-layer-thinking-guide.md) |
| 修改路径规范化、`taskKey`、白名单仓库或写操作 | [跨层契约](./cross-layer-thinking-guide.md) |
| 新增常量、解析函数、校验函数或前端工具模块 | [代码复用指南](./code-reuse-thinking-guide.md) |
| 同时修改 `server/`、`public/`、`tests/` | 两份指南都读 |

## 快速触发条件

出现以下任一情况，先搜索全部消费者，再改代码：

- 改 `prd`、`research`、`design`、`implementPlan`、`context`、`review`、`implement`、`check`、`e2e`、`spec`、`commit`、`archive`、`journal` 任一阶段 ID 或顺序。
- 改 `taskKey`、`projectId`、`relativeDir`、`repoPath` 的含义或格式。
- 改 `/api/board`、`/api/task`、`/api/tasks/stage` 的字段或错误结构。
- 改 SQLite schema、旧 JSON 迁移、扫描缓存结构或 `SCAN_SCHEMA_VERSION`。
- 在 `public/` 新增一个纯函数模块，同时准备让 `server/` 复用。

## 验证基线

```powershell
npm test
rg -n "STAGE_ORDER|STAGE_IDS|STAGE_LANES|SCAN_SCHEMA_VERSION|taskKey" server public tests
rg -n "DatabaseSync|withTransaction|getRepositories|readScanCache|runTaskPython" server tests
```

项目没有 lint、类型检查或构建步骤；Node 内置测试是当前唯一的自动验证入口。
