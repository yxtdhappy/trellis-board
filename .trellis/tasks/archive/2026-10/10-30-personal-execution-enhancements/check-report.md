# 个人版执行增强：最终集成质量检查

## 结论

最终集成质量门通过。

三个子任务均已独立实现、检查、提交和归档；父任务在
`codex/personal-execution-enhancements` 上执行了全范围集成检查。检查过程中发现并修复了
“撤销人工阶段后详情仍读取旧 `boardCache`”的跨层缺陷。

## 检查范围

- 父任务 `prd.md`、`design.md`、`implement.md`。
- 三个已归档子任务及其实现、检查和 E2E 报告。
- SQLite v3、扫描缓存、稳定执行身份、执行投影、HTTP 路由和原生前端。
- `.trellis/spec/backend`、`.trellis/spec/frontend` 和跨层指南。

## 规范核对

| 规范 | 结果 | 证据 |
| --- | --- | --- |
| 输入、路径和身份校验先于持久化 | 通过 | `execution-store`、`task-location` 测试 |
| 多行写入使用事务并整体回滚 | 通过 | 计划、依赖、撤销、项目删除回滚测试 |
| 列表不泄漏详情、事件和产物正文 | 通过 | 投影测试与隔离 `/api/board` 断言 |
| 归档后稳定身份仍关联扩展数据 | 通过 | 隔离归档 API E2E 与重启读回 |
| schema v1/v2 -> v3 和失败回滚 | 通过 | `database.test.js` |
| WIP、DoR/DoD 只提示不阻塞 | 通过 | 达上限后继续写阶段，转为超限提醒 |
| 前端动态文本转义、键盘和对话框 | 通过 | 既有自动化测试与 ego-browser E2E |
| 响应式、空/错误状态和字体回退 | 通过 | 860px、820px、空结果、表单错误、阻断字体资源 |

## 质量门

| 检查 | 结果 |
| --- | --- |
| `npm test` | 113/113 通过 |
| `server`、`public`、`tests` 全部 `node --check` | 通过 |
| `git diff --check` | 通过；仅提示 Trellis `task.json` 的 CRLF 归一化 |
| lint | 项目不存在 lint 脚本，未虚报 |
| type-check | 项目没有 TypeScript，未虚报 |
| build | 项目没有构建步骤，未虚报 |

## 集成发现与修复

### 撤销人工阶段后读到旧快照

- 现象：`POST /api/tasks/undo` 已完成 SQLite 投影恢复并追加补偿事件，但响应中的任务详情
  仍从旧 `boardCache` 合并 `manualStage=implement`。
- 根因：撤销路由更新数据库后没有刷新 Board 组合快照；详情合并会保留列表快照中的旧人工阶段。
- 修复：撤销事务成功后同步刷新 Board，并设置 `suppressStageObservation`，避免撤销动作被误记为扫描阶段变化。
- 回归：隔离 HTTP E2E 验证首次人工阶段撤销后 `manualStage=null`，事件仍保留原确认和补偿记录。
- 规范：已回写 `.trellis/spec/backend/scanning-and-persistence.md`。

## 跨层检查

- `task.json` 仍是任务、状态、负责人和父子关系事实来源。
- 计划字段、标签、视图、依赖和事件只写 Board SQLite；隔离测试确认目标 `task.json` 未变化。
- 同一任务从活动目录移动到归档目录后，`executionTaskKey` 保持不变。
- 活动依赖图拒绝缺失、自引用、重复和三节点循环，失败前后依赖与事件计数一致。
- 撤销只追加 `operation_undone`，不删除或改写原始事件。
- `missing`、`partial`、`tracked` 均由事件证据推导；旧归档任务不生成猜测数字。
- 删除项目会清理该项目的人工阶段、执行扩展数据和任一侧依赖。

## 剩余说明

- 项目没有独立 HTTP 集成测试框架。撤销缓存刷新回归使用隔离应用副本、真实 HTTP、真实 SQLite
  和真实浏览器覆盖，不把单元测试冒充 HTTP 验证。
- 负向 API 测试会在隔离服务 stderr 留下预期的 400 校验异常栈；浏览器控制台为 0 异常。
- 未修改或重启真实 4317 服务，未写入真实 `data/board.sqlite`。
