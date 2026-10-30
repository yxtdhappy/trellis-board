# 风险与流动：实施报告

## 交付摘要

- SQLite schema 从 v2 顺序升级到 v3，新库直接初始化到 v3；新增 `task_dependency`、活动边唯一索引和双向查询索引。
- v1、v2 迁移前分别创建 `VACUUM INTO` 快照；迁移使用同一 `BEGIN IMMEDIATE` 事务，失败时保留原 schema 和可独立打开的备份。
- 依赖创建与解除复用稳定 `executionTaskKey`，使用活动边 BFS 检测任意长度循环；依赖行与 `dependency_created` / `dependency_resolved` 事件同事务提交。
- 解除依赖保留原行和解除时间，允许之后重新创建同一活动边；项目移除会清理任一侧属于该项目的依赖。
- Board 列表只返回阻断数量、时长摘要和 DoR/DoD 缺口数量；任务详情返回活动 `blockedBy` / `blocks`、已结束 `resolvedBlockedBy` / `resolvedBlocks`、原因、创建人、固定区间时长和缺口项。
- 实现中 WIP 默认软上限为 2，保存在 `board_state.executionWipLimit`，范围 1–9；达到或超出上限只提示，不参与阶段写入校验。
- 新增阻断状态保存视图条件和内置“被阻断”“阻断已解除”视图；缺失 `blocked` 字段的旧视图继续按 `any` 匹配。
- 首屏新增 WIP、当前阻断、阻断已解除和 DoR/DoD 缺口信号；任务详情提供依赖创建、解除、反向关系、原因和风险缺口。
- 扫描缓存协议从 9 提升到 10，使新增 flow 与执行风险字段的旧缓存失效。

## API

- `POST /api/tasks/dependencies`：通过双方 `projectId + taskPath` 定位任务并创建阻断依赖。
- `DELETE /api/tasks/dependencies`：按依赖 ID 解除活动依赖。
- `PUT /api/board/settings`：保存 `executionWipLimit`。
- `GET /api/board`：新增 `flow` 和任务轻量执行风险字段。
- `POST /api/task`：新增活动/已结束双向依赖数组和 `risk.dorMissing` / `risk.dodMissing`。

## 检查阶段修复

- `server/loader.js`：列表投影直接保留轻量证据摘要，修复 `summary.summary` 导致 DoR/DoD 计数丢失；增加 loader 回归测试。
- `server/execution-projection.js`：DoR 用 `prdMeaningful` 和 `prdAcceptanceCount` 判断真实 PRD 与验收内容，避免人工确认骨架仍被判为齐备。
- `public/app.js`：依赖创建失败后恢复焦点到可修正字段，解除失败后恢复焦点到解除按钮。
- `public/app.js`：WIP 卡片统一使用个人全局 `flow`，不再随项目、负责人或搜索过滤子集改变承载状态。
- `server/execution-projection.js`、`public/app.js`：详情增加已解除依赖历史，固定显示 `createdAt`、`resolvedAt` 和 `resolvedAt - createdAt` 时长，不把历史错误继续累计到当前时间。
- `server/execution-projection.js`：DoD 不再把归档加载器补出的 `archive-gap` 当作真实实施/检查报告，避免掩盖归档任务证据缺口。

## 最终验证

```powershell
npm test
Get-ChildItem server,public,tests -Filter *.js -Recurse | ForEach-Object { node --check $_.FullName }
git diff --check
python ./.trellis/scripts/get_context.py --mode packages
```

结果：

- `npm test`：95/95 通过。
- 全部 `server/`、`public/`、`tests/` JavaScript：`node --check` 通过。
- `git diff --check`：通过；只有既有 `task.json` CRLF 转换提示。
- `get_context.py --mode packages`：单仓，规范层 `backend`、`frontend`。
- lint、TypeCheck、Build：N/A，项目未配置这些步骤。

覆盖场景：

- v3 新库、v1 到 v3、v2 到 v3、v2/v1 备份和迁移失败回滚。
- 原因空值/超 500、缺失身份、自引用、重复活动边、二节点环、三节点环和事件写入失败回滚。
- 解除历史保留、数据库重开、重新创建活动边、解除事件失败回滚。
- 轻量列表不包含完整依赖数组；详情返回活动与已结束双向关系、原因、创建人和固定区间时长。
- WIP `normal` / `at_limit` / `over_limit`、DoR/DoD 缺口派生和 PRD 骨架回归。
- 归档 DoD 区分真实报告与 `archive-gap`，避免把缺失历史补成完成证据。
- 阻断保存视图、旧视图缺少字段兼容、项目删除和依赖清理事务回滚。

## 隔离 E2E

- 用真实 v2 库的只读快照在临时端口 `43217` 启动当前代码；迁移为 v3，生成可独立打开的 v2 备份，重启后 schema 与核心表行数一致。
- 真实 API 完成 A blocked by B、双向详情、解除、历史保留、重新创建、失败计数不变、三节点循环、WIP 软限制和旧视图验证。
- 浏览器完成详情创建/解除、已解除依赖固定时长、循环错误输入保留与焦点恢复、被阻断/已解除视图、WIP 修改、DoR/DoD、阶段按钮、计划字段、团队、归档、创建任务对话框和 860px 布局验证。
- Chrome DevTools MCP 两次连接超时，按项目规则改用 `ego-browser`；控制台无 error/warn，网络仅有预期循环 400。
- 临时服务已停止。真实 4317 服务与真实 schema v2 数据库未重启、未迁移、未修改。

详细证据见 [check-report.md](./check-report.md) 和 [e2e-report.md](./e2e-report.md)。

## 最终结论

依赖活动态、解除态、固定区间时长、WIP、DoR/DoD、旧视图兼容和归档证据边界均已由自动化、真实 API 与浏览器验收覆盖，无剩余阻塞项。
