# 后端质量规范

## 团队模式密码策略

- 管理员建号、管理员重置密码、用户自助改密共用 `server/team/auth.js` 的 `validatePassword()`：最少 6 个字符、最多 1024 个 UTF-8 字节，不做大小写/数字/符号复杂度校验。
- 这是明确的产品决策，6 位下限不能按缺陷回退为 12 位；旧账号的 scrypt 哈希继续有效，策略变化不影响登录。
- 管理员直接填写初始密码，不生成、不返回临时密码；`must_change_password` 仅保留字段兼容，新流程写 `0`。

## 运行基线

- Node `>=24`，SQLite 使用内置 `node:sqlite`；当前开发机验证版本为 Node `24.21.0`。
- 自动测试：`npm test`。
- 启动：`node server/index.js` 或 `npm start`。
- 项目没有 lint、类型检查或构建步骤，不能把不存在的检查写成通过项。

## 测试框架

所有测试使用 Node 内置测试：

```js
import test from "node:test";
import assert from "node:assert/strict";
```

测试文件为 `tests/*.test.js`。涉及文件系统的测试通常在 `os.tmpdir()` 创建真实 Trellis 夹具，并在 `finally` 中 `fs.rmSync(root, { recursive: true, force: true })` 清理。

## 现有覆盖

| 模块 | 测试重点 |
| --- | --- |
| [server/loader.js](../../../server/loader.js) | 嵌套归档、阶段证据、缓存复用、workspace 变化、Git、元数据、E2E 语义、父子继承、冲突和循环 |
| [server/database.js](../../../server/database.js) | schema、旧 JSON 迁移幂等、损坏输入和版本拒绝 |
| [server/repositories.js](../../../server/repositories.js) | SQLite 规范化、ID、重复路径、未初始化目录、批量事务回滚、只移除配置 |
| [server/metadata.js](../../../server/metadata.js) | 人工阶段合法 ID 与 SQLite upsert |
| [server/persistence.js](../../../server/persistence.js) | 缓存 schema 失效、看板状态保留 `null` 和多字段更新 |
| [server/actions.js](../../../server/actions.js) | 无效输入在调用 `task.py` 前失败 |
| [server/watcher.js](../../../server/watcher.js) | 路径过滤、真实文件事件、超时和关闭 |
| [server/execution-store.js](../../../server/execution-store.js) | 计划字段校验、标签原子替换、保存视图、依赖创建/解除、循环和事务回滚、扫描事件 |
| [server/execution-projection.js](../../../server/execution-projection.js) | 截止/停滞/阻断注意力、身份冲突隐藏、DoR/DoD、WIP 和 Board 批量投影 |
| [server/task-location.js](../../../server/task-location.js) | 白名单、任务根、真实路径和身份冲突定位 |
| 前端纯模块 | Markdown 安全、slug、归档排序、组合筛选 |

`server/index.js` 的 HTTP 路由没有独立自动测试套件。修改 API、静态资源、刷新队列或 Worker 协议时，除 `npm test` 外还要启动真实服务并用实际 HTTP 请求和页面操作验证。

## 测试设计

- 先覆盖无效输入，再覆盖成功路径。
- 对外部副作用做顺序断言，例如无效任务必须在调用 Trellis 前失败。
- 批量操作测试必须证明失败时没有部分写入。
- 文件监听测试使用 Promise 和有限超时，结束时调用 `runtime.close()`。
- 缓存测试同时验证首次解析、命中复用和只刷新变化任务，不能只断言数组长度。
- E2E 文本判断至少覆盖计划、否定、完成和表格结论。
- 依赖测试至少覆盖缺失、自引用、重复、空/超长原因、二/三节点循环、事件失败回滚、解除历史、重开和重新创建。
- 迁移测试至少覆盖新库 v3、v1 -> v3、v2 -> v3、源版本备份、失败回滚和大于 v3 拒绝。

## 代码风格

- 两空格缩进、双引号、分号、ESM。
- 小函数优先；共享行为放已有所有者模块。
- 错误信息使用面向用户的中文短句，保留可定位的具体字段。
- 只在本次改动造成时清理未使用导入和变量。
- 同步 I/O 必须放在可解释的位置；长扫描不能回到 HTTP 主线程。

## 审查清单

- [ ] 输入校验发生在任何文件写入或子进程调用之前。
- [ ] 仓库和任务路径仍受白名单及任务根限制。
- [ ] Board 状态只经 SQLite facade 写入，多行变更使用事务。
- [ ] 目标仓库 `task.json` 写入仍为临时文件加 rename。
- [ ] 新扫描证据已进入缓存签名，相关缓存能失效。
- [ ] 阶段或父子关系变化同步了所有消费者。
- [ ] 不兼容 board 输出已更新 `SCAN_SCHEMA_VERSION`。
- [ ] 列表摘要保留证据计数和 Design 有效性，但不泄漏完整依赖数组、事件或产物正文。
- [ ] 依赖图只用活动边做环检测；已解除行保留，项目移除清理任一侧依赖。
- [ ] WIP、DoR、DoD 只影响显示和筛选，不改变阶段写入校验。
- [ ] 计划字段、标签或人工阶段失败时没有部分写入，事件与投影处于同一事务。
- [ ] 首次追踪和身份冲突变化不会补造扫描阶段事件。
- [ ] 新增分支有 Node 测试；HTTP/UI 改动有真实请求和浏览器验收。
