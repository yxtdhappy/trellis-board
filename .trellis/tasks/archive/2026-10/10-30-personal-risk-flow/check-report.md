# 风险与流动：检查报告

## 结论

实现与任务契约一致。检查与根代理复验收口共修复 6 个边界问题；全量自动测试、语法检查、隔离迁移、真实 HTTP API 和浏览器验收均通过，无剩余阻塞项。

## Findings (fixed)

- 文件：`server/loader.js`、`tests/loader.test.js`
- 问题：`toTaskListItem()` 对已经是摘要对象的 `task.summary` 再次读取 `.summary`，导致 Board 列表丢失 `designMeaningful`、PRD 验收计数和 Implement 摘要。详情风险正确、首屏风险计数可能偏差。
- 修复：列表投影保留原摘要对象，继续移除产物正文；新增列表摘要回归测试。

- 文件：`server/execution-projection.js`、`tests/execution-projection.test.js`
- 问题：DoR 只检查 PRD 阶段是否完成。人工确认 PRD 后，默认骨架仍会被误判为已满足；Requirements 有内容但 Acceptance Criteria 为空时也未提示。
- 修复：优先使用 `prdMeaningful` 和 `prdAcceptanceCount` 派生 DoR，并覆盖人工确认骨架、缺少验收项两种回归。

- 文件：`public/app.js`
- 问题：依赖提交期间禁用按钮会使焦点落到页面根节点；失败后虽保留输入，但键盘用户无法直接继续修正。
- 修复：循环、重复或身份冲突错误后焦点回到阻断方选择框，其余错误回到原因输入；解除失败后焦点回到解除按钮。浏览器复验循环错误后焦点位于 `blockerTaskKey`。

- 文件：`public/app.js`
- 问题：WIP 卡片从当前项目/负责人/搜索过滤后的子集重算，而任务详情和 Board `flow.wipState` 使用个人全局 WIP。筛选后可能出现卡片正常、详情超限的矛盾。
- 修复：WIP 数字与状态统一读取 Board `flow`，阻断和风险队列仍保持当前筛选语义。浏览器在只命中 1 个非实现任务时仍确认全局 `2 / 1`、超限提醒。

- 文件：`server/execution-projection.js`、`server/execution-store.js`、`public/app.js`
- 问题：解除后的依赖没有直接返回或渲染固定区间时长。
- 修复：详情新增 `resolvedBlockedBy` / `resolvedBlocks`，按 `resolvedAt - createdAt` 返回固定 `durationMs`；UI 以折叠历史区显示双方、原因、创建/解除时间和时长。浏览器连续两次请求确认时长不再增长。

- 文件：`server/execution-projection.js`、`tests/execution-projection.test.js`
- 问题：归档扫描会把缺失阶段补成 `archive-gap` 完成态，DoD 若只看阶段布尔值会掩盖实施/检查报告缺失。
- 修复：DoD 只接受真实报告或非 `archive-gap` 的实施/检查证据，并增加归档缺失与归档证据齐全两组断言。

浏览器补充验收：已解除依赖固定时长在连续详情请求间保持不变；历史区展开后可见，860px 下 `845 <= 860` 无页面级横向溢出。

## 规范同步

已同步：

- `backend/architecture-and-runtime.md`
- `backend/scanning-and-persistence.md`
- `backend/http-and-filesystem.md`
- `backend/quality-guidelines.md`
- `frontend/rendering-and-state.md`
- `frontend/quality-guidelines.md`
- `guides/cross-layer-thinking-guide.md`
- `README.md`

重点记录了 schema v3、活动边循环规则、列表/详情投影边界、WIP 软限制、旧视图缺省 `any`、`SCAN_SCHEMA_VERSION=10` 和 WIP 全局承载语义。

## Verification

- Lint：N/A，项目没有 lint 脚本。
- TypeCheck：N/A，项目没有 TypeScript 或类型检查步骤。
- Build：N/A，项目没有构建步骤。
- Tests：通过，`npm test` 为 95/95。
- Syntax：通过，`server/`、`public/`、`tests/` 全部 JS 执行 `node --check` 无错误。
- Diff：通过，`git diff --check` 无空白错误；任务 `task.json` 仅报告既有 CRLF 转换警告。
- Context：通过，`python ./.trellis/scripts/get_context.py --mode packages` 返回单仓两个规范层 `backend`、`frontend`。

## Migration drill

- 使用真实 v2 库的只读 `VACUUM INTO` 快照，未修改真实 `data/board.sqlite`。
- v2 快照：schema `2`，无 `task_dependency`。
- 当前代码打开后：schema `3`，`task_dependency` 存在。
- 自动生成 `board.sqlite.v2-backup`：schema `2`，无 `task_dependency`，可独立打开。
- 迁移后重启仍为 schema `3`。
- 迁移前、迁移后、v2 备份的 `repositories`、`task_execution`、`task_tag`、`saved_view`、`task_event`、`board_state` 行数完全一致。

## Isolation

- 临时服务使用 `127.0.0.1:43217`，现已停止。
- 真实 `127.0.0.1:4317` 服务 PID `42200` 未被重启或停止。
- 真实 `data/board.sqlite` 仍为 schema `2`，未被迁移。
- 临时任务仓库和数据库位于 `.audit/personal-risk-flow-20261030/`。
