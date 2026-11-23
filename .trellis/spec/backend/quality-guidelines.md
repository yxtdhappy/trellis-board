# 后端质量规范

## 团队模式密码策略

- 管理员建号、管理员重置密码、用户自助改密共用 `packages/server/team/auth.js` 的 `validatePassword()`：最少 6 个字符、最多 1024 个 UTF-8 字节，不做大小写/数字/符号复杂度校验。
- 这是明确的产品决策，6 位下限不能按缺陷回退为 12 位；旧账号的 scrypt 哈希继续有效，策略变化不影响登录。
- 管理员直接填写初始密码，不生成、不返回临时密码；`must_change_password` 仅保留字段兼容，新流程写 `0`。

## 多团队与设备授权

- `user_session.active_team_id` 是废弃兼容列，不参与授权；运行时团队集合每次从 active 团队的 `team_member` 实时读取。
- 项目访问必须校验 active 团队；非系统管理员还要求团队成员关系，并按项目角色或团队管理员角色判定能力。系统管理员不要求 `team_member`，但不能访问已停用团队。
- 团队管理员查询项目、用户、Agent 或审计时，单一管理团队可省略 `teamId` 并自动落位；多管理团队缺省必须返回 400，显式 `all` 才聚合该管理员实际可管理的团队。
- `/api/admin/users?teamId=` 只收窄返回的用户列表，不得裁剪系统管理员编辑所需的完整 `user.teams`，否则账号保存会静默删除其他团队关系。
- 任务查询的 ETag、缓存键和游标绑定必须包含请求团队作用域和当前可读项目集合哈希；团队成员移除后旧游标必须失效。
- 桌面设备凭证绑定用户与设备，不能绑定单一活动团队。项目绑定、事件游标和事件流按项目/事件团队分别校验；按团队撤销只影响该团队绑定。
- Agent 顶层 `teamId` 仅为兼容字段。设备注册返回的 `teams` 和 Agent 绑定/订阅校验均应支持系统管理员的全部 active 团队；普通用户仍要求实时团队成员关系。

## 运行基线

- Node `>=24`，SQLite 使用内置 `node:sqlite`；当前开发机验证版本为 Node `24.21.0`。
- CI 运行 `yarn test` 前必须先在仓库根目录执行 `yarn install --immutable`，真实 Trellis CLI 测试依赖根目录固定版本依赖。
- 自动测试：`yarn test`（只跑 `packages/test-support/*.test.js`，不含 `plugins/` 下的插件测试）。
- 插件测试：`yarn test:plugins`（`plugins/*/test/*.test.js`）；需要宿主与插件一起验证时用 `yarn test:all`。
- 启动：`node packages/server/index.js` 或 `yarn start`。
- 项目没有 lint、类型检查或构建步骤，不能把不存在的检查写成通过项。

## 测试框架

所有测试使用 Node 内置测试：

```js
import test from "node:test";
import assert from "node:assert/strict";
```

测试文件为 `packages/test-support/*.test.js`。涉及文件系统的测试通常在 `os.tmpdir()` 创建真实 Trellis 夹具，并在 `finally` 中 `fs.rmSync(root, { recursive: true, force: true })` 清理。

## 现有覆盖

| 模块 | 测试重点 |
| --- | --- |
| [packages/server/loader.js](../../../packages/server/loader.js) | 嵌套归档、阶段证据、缓存复用、workspace 变化、Git、元数据、E2E 语义、父子继承、冲突和循环 |
| [packages/server/database.js](../../../packages/server/database.js) | schema、旧 JSON 迁移幂等、损坏输入和版本拒绝 |
| [packages/server/team/process.js](../../../packages/server/team/process.js) | 子进程输出截断与秘密脱敏、超时后等待进程树退出 |
| [packages/server/repositories.js](../../../packages/server/repositories.js) | SQLite 规范化、ID、重复路径、未初始化目录、批量事务回滚、只移除配置 |
| [packages/server/metadata.js](../../../packages/server/metadata.js) | 人工阶段合法 ID 与 SQLite upsert |
| [packages/server/persistence.js](../../../packages/server/persistence.js) | 缓存 schema 失效、看板状态保留 `null` 和多字段更新 |
| [packages/server/actions.js](../../../packages/server/actions.js) | 无效输入在调用 `task.py` 前失败 |
| [packages/server/watcher.js](../../../packages/server/watcher.js) | 路径过滤、真实文件事件、超时和关闭 |
| [packages/server/execution-store.js](../../../packages/server/execution-store.js) | 计划字段校验、标签原子替换、保存视图、依赖创建/解除、循环和事务回滚、扫描事件 |
| [packages/server/execution-projection.js](../../../packages/server/execution-projection.js) | 截止/停滞/阻断注意力、身份冲突隐藏、DoR/DoD、WIP 和 Board 批量投影 |
| [packages/server/task-location.js](../../../packages/server/task-location.js) | 白名单、任务根、真实路径和身份冲突定位 |
| 前端纯模块 | Markdown 安全、slug、归档排序、组合筛选 |

`packages/server/index.js` 的 HTTP 路由没有独立自动测试套件。修改 API、静态资源、刷新队列或 Worker 协议时，除 `yarn test` 外还要启动真实服务并用实际 HTTP 请求和页面操作验证。

## 测试设计

- 先覆盖无效输入，再覆盖成功路径。
- 对外部副作用做顺序断言，例如无效任务必须在调用 Trellis 前失败。
- 批量操作测试必须证明失败时没有部分写入。
- 文件监听测试使用 Promise 和有限超时，结束时调用 `runtime.close()`。
- 缓存测试同时验证首次解析、命中复用和只刷新变化任务，不能只断言数组长度。
- E2E 文本判断至少覆盖计划、否定、完成和表格结论。
- 依赖测试至少覆盖缺失、自引用、重复、空/超长原因、二/三节点循环、事件失败回滚、解除历史、重开和重新创建。
- 迁移测试至少覆盖新库 v15、v10 补监听列、v11 补 retired/基线/证据结构、v13 归档隔离、
  v14 -> v15 归档快照元数据、v6-v14 顺序升级、源版本备份、旧表保留、失败回滚和大于 v15 拒绝。
- Team 项目接入测试至少覆盖规范化远端去重、同远端不同分支隔离、owner/invite、
  `access_required` 不泄漏任务内容，以及并发 attach 收敛到同一项目。
- tasks-only 测试至少覆盖路径白名单、LF 摘要、完整任务目录、文件级 CAS、整批回滚、
  `batchId` 幂等、删除墓碑、活动到归档移动和 `clientSequence` 单调。
- Agent 测试至少覆盖唯一 active slot、新设备撤销旧 SSE/命令、在线命令租约、索引完成门禁、
  客户端目标路径 dirty 保护、pending batch 重放和摘要级 watcher 自触发抑制。
- Team 静态边界必须断言运行时不 import Git manager/live overlay，不访问 `data/projects/**`，
  旧 Git/live 路由返回 404，扫描 Worker 不读取 workspace、scripts、spec、config 或 workflow。
- Team 任务索引的性能测试必须覆盖可信 warm 基线下的目录级增量：单任务变化只扫描一个目录，
  未变化索引行和 `updated_at` 不改，增量 Board 与同快照 full 重建的任务、关系、成员和风险投影一致；
  同时覆盖扫描期间新 revision 的 superseded 收敛、事务内复核失败回滚和同 revision 人工阶段重投影。
- 归档本地快照测试必须覆盖普通二进制附件、内容寻址哈希、16 MiB/512 MiB 限额、staging 原子发布、
  candidate 导入不退役 active、索引失败保留旧 fileId 下载、索引成功原子激活、database 发布失败
  保留旧快照和 Board、服务重启读取、数据库备份引用以及 TaskSpace 删除后的清理。
- 错误诊断测试至少覆盖 TeamError 结构化字段、非 TeamError 的 stack/cause、递归对象与循环引用、
  Authorization/Cookie/JWT/复合 token 键脱敏、绝对路径脱敏、`last_error` 的 `code: message`
  格式以及 1000 字符上限；结构化详情还必须验证总长度预算，并断言
  `AUTHORIZATION_REQUIRED`、`TOKEN_EXPIRED` 等错误 code 不被误脱敏。

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
