# 检查报告

## 结论

本任务代码、规范和行为测试已完成审查。检查中修复了 SSE 连接监听清理、鉴权失败开放风险、
前端重复对齐和跨团队切换后通知重复提示问题。针对性测试、Web lint、TypeScript 和格式检查通过；
全量测试仍有与环境或既有插件测试相关的失败，未计入本任务回归。

## Findings (fixed)

- `server/board-events.js` 连接释放时残留 `error` 监听：同时移除 `close`/`error`，并对 `end()`
  异常做兜底销毁。
- SSE 鉴权回调返回值只有字面 `false` 被视为拒绝，`undefined` 会误放行：改为仅显式 `true` 授权，
  失败默认关闭；新增拒绝测试。
- `web/src/hooks/useBoard.ts` 在 `tasks.changed` 防抖排队期间收到 focus/visibility 会立即执行后
  再重复执行：focus、visibility 和 SSE 变更统一走合并队列。
- 切换团队时清空通知去重集合，切回后会重复提示同一责任人通知：去重集合跨团队筛选保留。
- 单机事件测试只使用 FakeResponse：新增真实 HTTP SSE 通知后读取新 REST 快照的测试。
- 新模块未进入后端架构规范：补充 `server/board-events.js` 的模块职责。
- 实施清单和报告未反映真实测试结果：勾选已完成前置项，并记录全量测试中的环境失败。
- 真实浏览器发现共享请求层把合法 ETag `304 Not Modified` 当作错误：已让 `requestJson()` 保留 304
  给现有 `api()` / `queryTeamTasks()` 分支处理，并重新构建、刷新页面验证无错误提示。

## Findings (not fixed)

- `server/index.js` 没有可注入临时数据库和仓库的独立 HTTP 测试入口；本轮以真实 HTTP 的
  SSE→REST 测试和后续浏览器验收覆盖单机扫描触发链，未为该测试能力重构主运行时。
- 全量 `npm test` 中 `tests/markdown.test.js` 因本机未安装 `highlight.js` 失败；该失败与本改动
  文件无关。
- `tests/witops-plugins.test.js` 单独运行仍 7 项失败，属于既有插件测试环境问题，本改动未触碰相关文件。
- 全量并发运行时实时同步 P95=4228ms 超阈值；`tests/team-realtime-sync.test.js` 单独复跑 7/7
  通过，P95=1499ms、max=1770ms。
- 未执行 Web build、未重启现有服务、未完成真实浏览器 E2E；按主流程在最终代码稳定后统一执行。

## Verification

- `node --test tests/board-events.test.js tests/team-board-events.test.js tests/team-events.test.js`：
  18 通过、0 失败。
- `node --test tests/team-realtime-sync.test.js`：7 通过、0 失败，P95=1499ms。
- `npm --prefix web run lint`：通过，仅有仓库既有 warning。
- `npm --prefix web exec tsc -- -p web/tsconfig.app.json`：通过。
- `npx oxfmt --check`：相关 5 个代码文件通过。
- 4 个服务端文件 `node --check`：通过。
- `git diff --check`：通过。
- `task.py validate`：`implement.jsonl` 6 项、`check.jsonl` 5 项，通过。
- `npm test`：379 通过、9 失败、5 跳过；失败项和隔离复跑结果见上。

## 最终验收

- `npm --prefix web run build` 通过。
- 团队模式浏览器确认空闲无 750ms `live-revision` 轮询，SSE 事件后执行一次 REST 对齐。
- 单机模式浏览器确认空闲无 750ms `board/status` 轮询，修改任务文件后自动重载新数据。
- 临时团队服务停止并重启后，EventSource 自动重连并重新执行 REST 对齐。
- 责任人覆盖通知的接口返回和前端事件 ID 去重由团队实时测试与代码审查覆盖；本轮无项目浏览器夹具，
  未单独触发 Toast 截图验收。
