# 实施计划

## 1. 前置约束

- 活跃任务：`.trellis/tasks/11-17-fix-cross-branch-pending-blocking`
- 当前分支：`main`
- PR 基线：`team-board`
- 只有用户明确批准最终规划后才能运行 `task.py start` 和修改产品代码。
- 实施过程中不执行构建；全部产品代码完成后只执行一次最终构建/完整验证。
- 不清理、不格式化、不回滚工作区现有无关改动。
- 不使用服务端 Git 或客户端全文镜像解决待归属展示。

## 2. 涉及范围

### Agent / 共享

- `packages/desktop/src-tauri/src/agent/task_sync.rs`
- `packages/desktop/src-tauri/src/agent/http.rs`
- `packages/desktop/src-tauri/src/agent/device.rs`
- `packages/desktop/src-tauri/src/agent/protocol.rs`（仅新增稳定错误/响应字段时）
- `packages/shared/task-snapshot.js`（仅当需要共享摘要/Fingerprint 纯函数时）
- 对应 Rust 单元测试和 shared Node 测试

### 服务端

- `packages/server/database.js`
- `packages/server/team/task-ownership-inbox.js`（新增）
- `packages/server/team/task-snapshot-service.js`
- `packages/server/team/gitless-board-service.js`
- `packages/server/team/http.js`
- `packages/server/test/database.test.js`
- `packages/server/test/team-task-snapshot.test.js`
- `packages/server/test/team-gitless-http.test.js`
- `packages/server/test/team-board-events.test.js`
- 如新增 service 独立测试，新增 `packages/server/test/task-ownership-inbox.test.js`

### Web

- `packages/web/src/api/board.ts`
- `packages/web/src/hooks/useBoard.ts`
- `packages/web/src/components/layout/ProjectRail.tsx`
- `packages/web/src/features/board/OwnershipInboxPanel.tsx`（新增）
- `packages/web/src/pages/board/BoardPage.tsx`
- `packages/web/src/features/board/task-view.ts`（仅新增 inbox 类型时）
- `packages/web/test/team-web.test.js`
- `packages/web/test/project-rail-association.test.js`
- `packages/desktop/test/desktop-association.test.js`（存在对应关联摘要测试时）

### 规范

- `.trellis/spec/backend/desktop-realtime-sync.md`
- `.trellis/spec/backend/task-ownership-and-conflict-idempotency.md`
- `.trellis/spec/frontend/rendering-and-state.md`

## 3. 实施顺序

### 阶段 0：基线夹具

- [ ] 记录当前 cursor JSON 兼容夹具：无 `revisionGuardVersion`、有 pending、无 pending。
- [ ] 记录跨客户端 revision 交错测试：A 上传 R+1、B 在中间提交 R+2、A 只应用到 R。
- [ ] 记录 branch=null pending 夹具和现有 `TASK_OWNERSHIP_PENDING_MISMATCH` 复现。
- [ ] 记录服务端普通任务查询中不存在待归属任务的现状。

### 阶段 1：cursor 向后兼容字段

- [ ] `Cursor` 增加 `revision_guard_version` 和 `pending_rejected`。
- [ ] 缺失字段按 0/空 Map 读取；旧 cursor 可写回新字段。
- [ ] `pendingRejected` 最多 50 项，只保存 batch/sequence/taskDir/reason/时间。
- [ ] cursor patch 比较实际变化，重复 patch 不重写文件。
- [ ] 添加序列化、反序列化和上限淘汰测试。

### 阶段 2：pending 原样重放

- [ ] 新批次在持久化前继续执行 ownership 分类。
- [ ] pending 重放跳过当前本地 branch 比较和第二次 ownership 分类。
- [ ] 只有 `observedBranchName` 和必要的 `clientSequence` 恢复可以在重放时变化。
- [ ] 明确拒绝后清 pending 并继续当前其他任务。
- [ ] 网络错误/超时/429 耗尽/未知失败保留 pending 并停止该 taskSpace。
- [ ] `TASK_OWNED_BY_BASELINE` 保持现有 baseline-owned 抑制。
- [ ] `TASK_FILE_CONFLICT` 保持现有 conflictBlocked 流程。
- [ ] 添加“旧空分支 pending + 它之后的新 main 任务”测试，断言新任务仍会上传。

### 阶段 3：revision 语义修正

- [ ] 上传成功只更新 sequence/baselines/pending。
- [ ] 上传响应 revision 只作为 `committedRevision` 返回/日志，不写 cursor revision。
- [ ] `write_server_cursor()` 只保留在完整 pull/apply 成功后。
- [ ] 添加跨客户端 revision 空洞测试，断言 cursor 不跳跃且下一次 pull 从旧 revision 开始。
- [ ] 重复 upload 应答与 SSE 事件不得触发无意义 cursor 重写。

### 阶段 4：旧 cursor 一次性修复

- [ ] 增加 `REVISION_GUARD_VERSION=1`。
- [ ] 有 pending 时先按阶段 2 重放；明确拒绝后继续修复，不确定失败则停止。
- [ ] 对 guard<1 且已完成首次同步的 binding 执行 full snapshot 对账。
- [ ] server-only 下载，local-only 走 ownership 后上传或发布摘要。
- [ ] 内容冲突写入 deferred 并进入现有差异确认，不使用服务端最新摘要覆盖。
- [ ] 修复后重新获取完整快照，重建 baselines/revision，最后写 guard=1。
- [ ] 修复失败保持 guard=0；成功后重启不重复 full snapshot。
- [ ] 新首次同步完成后直接写 guard=1。
- [ ] 添加“旧 cursor 已越过远端删除事件、本地任务仍存在”的恢复测试。
- [ ] 添加“修复不删除本地任务”和“冲突目录仍由 deferred 保护”测试。

### 阶段 4.5：本地关联状态投影

- [ ] `LocalAssociation` 增加 pending upload、pendingRejected 和 conflictBlocked 的计数/目录字段。
- [ ] 所有字段从 cursor 只读派生，不读取任务正文，不扩大 3 秒关联轮询成本。
- [ ] ProjectRail 区分冲突待处理、服务端拒绝待处理、待确认归属和上传重试。
- [ ] 无这些状态时仍显示原有 ready/syncing/error，不伪造状态。
- [ ] 更新桌面关联摘要和 Web 状态纯函数测试。

### 阶段 5：服务端 inbox schema 与 service

- [ ] schema 升到 v17，新增 `sync_task_ownership_inbox` 和索引。
- [ ] 实现 v16 → v17 幂等迁移，并使用现有升级前备份。
- [ ] 保留 `sync_task` / `sync_task_lease` 控制面；摘要表不参与 claim、lease、taskVersion 或任务命令。
- [ ] 新增 `createTaskOwnershipInboxService({ db, taskSpaces, taskSpaceIndex, events })`。
- [ ] 实现 `upsert/delete` 摘要变更，单次最多 200 项且整批事务提交。
- [ ] 实现按 `project_id + task_id` 聚合、稳定分页和来源分支/客户端摘要。
- [ ] 实现 `countByProject()`，供团队 status 装饰项目 DTO。
- [ ] 实现正常任务被接受后的同事务 inbox 删除 helper。
- [ ] 写入/删除成功后发布现有 `tasks.changed`，不增加 taskSpace revision。

### 阶段 6：Agent inbox 发布与 Web 查询 API

- [ ] 新增 Agent `PUT /api/agent/task-spaces/:taskSpaceId/ownership-inbox`。
- [ ] 复用 binding、真实分支、角色和 active project/taskSpace 校验。
- [ ] 客户端 ownership 分类后把仍未归属任务映射成摘要，并按本地 cursor 状态发送 upsert/delete。
- [ ] inbox 发布失败不阻断普通任务同步；404/405 只记录可选能力缺失。
- [ ] 新增 Web `GET /api/ownership-inbox`，校验 teamId/projectIds 可读范围。
- [ ] `/api/team/status` 的项目 DTO 增加 `ownershipInboxCount`；不要复用本地关联的
      `ownershipPendingCount`，两者分别表示“项目级待归属摘要”和“分支级待确认归属”。
- [ ] 测试重复 upsert 幂等、delete 幂等、200 项上限、越权、XSS 字符、超长标题和不回传正文。

### 阶段 7：Web 双层入口

- [ ] `ProjectRail` 支持项目级 `ownershipInboxCount`。
- [ ] “全部项目”只在 count>0 时显示项目徽标。
- [ ] 展开项目后，在项目行与分支行之间固定显示“待归属任务 N”按钮。
- [ ] 点击该按钮设置项目范围并展开待归属面板，不设置虚假 taskSpaceId。
- [ ] 分支级“待确认归属”继续打开现有 `TaskOwnershipDialog`，不与项目级摘要混用。

### 阶段 8：Web 主内容警示条与列表

- [ ] `useBoard` 增加 inbox 查询状态、请求序号、分页游标和项目/团队切换清理。
- [ ] 新增 `OwnershipInboxPanel`，放在 `ExecutionHeader` 后、流程指标和看板前。
- [ ] count>0 时警示条始终显示，不受 branch/search/stage/assignee 筛选影响。
- [ ] 左侧入口和警示条触达同一个展开状态。
- [ ] 全部项目按项目分组；单项目只显示当前项目。
- [ ] 显示标题、任务目录、原因、来源分支、来源客户端、最近发现时间。
- [ ] 支持“加载更多”；不使用普通任务分页游标。
- [ ] 无数据时左侧入口灰显 0，警示条隐藏。
- [ ] `tasks.changed` 到达时刷新 count；面板展开时刷新 inbox。
- [ ] 添加可访问性断言：button、`aria-expanded`、可见文字计数、非仅颜色表达。

### 阶段 9：规范回写

- [ ] backend `desktop-realtime-sync` 写入 pending 原样重放、已应用 revision 和 guard 修复契约。
- [ ] backend `task-ownership-and-conflict-idempotency` 写入项目级摘要 inbox 与正常任务清理关系。
- [ ] frontend `rendering-and-state` 写入双层入口、不可隐藏警示条、状态刷新和空状态。
- [ ] 不新增与现有 taskSpace/ownership 冲突的平行语义。

## 4. 风险文件

- `packages/desktop/src-tauri/src/agent/task_sync.rs`
  - pending、revision、cursor、pull、ownership 多状态交叉，风险最高。
- `packages/desktop/src-tauri/src/agent/device.rs`
  - LocalAssociation 字段必须是向后兼容的只读投影，不能触发额外全文扫描。
- `packages/server/database.js`
  - schema v17 迁移和旧库备份。
- `packages/server/team/task-snapshot-service.js`
  - 正常任务接受与 inbox 删除必须在同一事务。
- `packages/server/team/gitless-board-service.js`
  - status ETag 和项目计数。
- `packages/web/src/hooks/useBoard.ts`
  - 避免 inbox 请求与普通任务分页游标互相覆盖。
- `packages/web/src/components/layout/ProjectRail.tsx`
  - 项目级入口不得伪造 taskSpace，也不得破坏现有分支关联状态。

## 5. 最终验证

全部产品代码完成后只执行一次最终验证。

聚焦 Node 测试：

```powershell
node --test packages/server/test/database.test.js packages/server/test/team-task-snapshot.test.js packages/server/test/team-gitless-http.test.js packages/server/test/team-board-events.test.js packages/web/test/team-web.test.js packages/web/test/project-rail-association.test.js
```

Rust：

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml task_sync
```

完整测试：

```powershell
yarn test
```

完成后只构建一次 Web：

```powershell
yarn build
```

## 6. 真实 E2E

- [ ] 在同一项目创建 `branch=null` 任务，不手动刷新，项目左侧和主内容区在现有 Board 刷新 SLA
      内出现同一待归属任务。
- [ ] 选择任意具体分支和执行搜索后，主内容区待归属警示条及项目级数量仍存在。
- [ ] 点击左侧入口和警示条进入同一列表；来源分支、来源客户端、原因和最近时间正确。
- [ ] 在客户端完成 `task.py set-branch` 并同步后，inbox 摘要消失，任务只出现在目标分支看板。
- [ ] 制造旧 branch=null pending，随后创建另一个 main 任务；两者互不阻塞，后者可见。
- [ ] 两个客户端交错写入 revision，原客户端不跳 revision，最终可见另一客户端的删除/更新。
- [ ] 退出并重开桌面客户端，guard 修复只在首次运行执行，第二次启动不重复 full snapshot。
- [ ] 服务端重启后 inbox 摘要、项目计数和 SSE 对齐正常。
- [ ] 清理测试任务后项目计数归零、警示条消失，普通分支看板无重复任务。

验收门槛：

- 待归属任务在本地文件出现后，无需用户手动刷新，Board 项目视图在 10 秒内可见。
- 一个明确拒绝的 pending 不再阻塞同 taskSpace 后续任务。
- 任何上传应答都不会让 cursor revision 越过尚未应用的远端变更。
- 正常任务同步、归档同步、任务详情正文和附件读取路径不增加 inbox 正文副本。

## 7. 回滚点

1. Web 先隐藏新入口；服务和 Agent 可继续工作，普通任务链路不受影响。
2. 停止 Agent 发布 inbox 摘要；保留 v17 表和服务端只读数据。
3. 回滚 Agent pending/revision 修改前，先确认没有未完成 pending；不得通过清空整个 cursor 解决。
4. 服务端 schema 回滚保留 v17 表，不删除表数据。
5. guard 修复误判时恢复对应本地任务或进入现有冲突确认，不强制全量删除 cursor。

## 8. 本轮执行记录（2026-11-18）

- 已完成 Desktop pending 原样重放、明确拒绝隔离、已应用 revision、revision guard、关联状态投影和
  Agent ownership inbox 发布。
- 已完成服务端 schema v17、事务化 inbox、Agent/Web API、项目计数和正常任务同事务清理。
- 已完成 Web 项目级双层入口、独立分页、筛选不可隐藏警示条，以及本地 pending/rejected/conflict 状态。
- 聚焦 Node 测试 67/67 通过；完整 `yarn test` 为 637 通过、1 跳过、0 失败；`yarn build` 通过；
  本任务文件 `oxfmt --check` 和 `git diff --check` 通过。
- 当前机器没有可用 `cargo`/`rustup`，Rust 编译与单元测试尚未执行。
- 尚未重启最新服务，因此真实接口和 UI E2E 尚未执行；不得用旧进程结果冒充本版本验证。
