# 设计：待归属任务支持从看板直接指定分支归属

## 1. 边界

| 层 | 职责 |
| --- | --- |
| server `task-ownership-inbox.js` | 在 inbox 条目上记录负责人信息；list 返回负责人与来源任务空间 |
| desktop `ownership_inbox.rs` | 上报时携带 `assigneeDevId`（来自 task.json 的 assignee/creator） |
| web `OwnershipInboxPanel.tsx` | 负责人门禁、分支选择、调用 `set_task_ownership`、刷新列表 |
| desktop `sync_api.rs` | 不改协议；复用现有 `set_task_ownership` 做本地归属写入与上传 |

**不新增 Tauri 命令**。现有 `set_task_ownership` 已经满足：

- 任务目录必须存在于当前 binding 的 `local_groups`（`retain_owned_groups` 会按本机 developer 过滤他人任务，天然满足「仅负责人可操作」）；
- 目标分支必须属于项目有效任务空间；
- 写回 `task.py set-branch`、清理 pending rejection、同步 inbox，并在分支等于当前 binding 时立即上传。

## 2. 数据契约

### 2.1 数据库

`sync_task_ownership_inbox` 增加两列（v18 migration，允许 NULL 以兼容旧行）：

```sql
ALTER TABLE sync_task_ownership_inbox ADD COLUMN assignee_user_id TEXT;
ALTER TABLE sync_task_ownership_inbox ADD COLUMN assignee_dev_id TEXT;
```

### 2.2 Agent 上报（PUT `/api/agent/task-spaces/:id/ownership-inbox`）

`upserts[]` 新增可选字段：

```json
{
  "taskId": "task-a",
  "taskDir": ".trellis/tasks/task-a",
  "title": "任务标题",
  "reason": "TASK_OWNERSHIP_REQUIRED",
  "fingerprint": "<sha256>",
  "assigneeDevId": "yuhaojie"
}
```

- 客户端从 `task.json.assignee`（缺失时回退 `creator`）取值；取不到则省略。
- 服务端校验格式（非空、长度 ≤ 120、无控制字符），通过项目成员表解析 `assignee_user_id`；解析不到时保留 `assignee_dev_id`、`assignee_user_id=NULL`。
- 旧客户端不传该字段时行为不变。

### 2.3 看板列表（GET `/api/ownership-inbox`）

每条 item 增加：

```json
{
  "taskSpaceId": "<source_task_space_id>",
  "assigneeUserId": "user-uuid | null",
  "assigneeDevId": "yuhaojie | null"
}
```

`packages/web/src/lib/ownership-inbox.js` 的 `normalizeItem` 同步增加这三个可选字段。

## 3. 前端流程

1. 从 props 取当前用户：`runtime.user.id`；从项目 taskSpaces 取可选分支。
2. 每个 inbox item 渲染「归属」按钮：
   - `item.assigneeUserId !== runtime.user.id` → 禁用，提示「仅任务负责人可操作」；
   - `assigneeUserId` 为空（旧数据）→ 禁用，提示「负责人未知，等待重新同步」；
   - 当前项目没有与该 item 对应的本地关联 / `invoke` 不可用 → 禁用并提示。
3. 点击后展开分支选择（默认 `item.sourceBranches[0]`，候选为该项目 taskSpaces），确认时调用：

```js
invoke('set_task_ownership', {
  taskSpaceId: item.taskSpaceId,
  decisions: [{ taskDir: item.taskDir, action: 'use-branch', branchName }],
})
```

4. 成功后触发 `refreshProjectState` / inbox 重新拉取，并 toast「任务归属已更新」。
5. 失败时展示可读错误，保持该条可再次操作：
   - `任务归属决定包含无效的任务目录` → 「本机没有该任务副本，请在负责人本机操作」；
   - `只能把任务归属到当前项目可见的有效分支` → 分支失效；
   - 只读/离线/分支不匹配按现有同步错误文案展示。

## 4. 权限

- **UI 门禁**：`assigneeUserId === 当前登录用户 id`。
- **本地权威校验**：`set_task_ownership` 的 `local_groups` 过滤要求任务属于本机 developer；即使 UI 被绕过，非负责人也无法写入。
- 不做服务端写入鉴权（文件写入发生在客户端），但 `assignee_user_id` 由服务端从项目成员映射解析，不能由客户端伪造。

## 5. 并发与幂等

- 同一 item 提交中禁用按钮；成功后以服务端列表刷新为准。
- `set_task_ownership` 本身串行（task space lock），重复提交只会得到相同结果或明确错误。

## 6. 兼容性

- 旧客户端：inbox 行 `assignee_user_id=NULL`，UI 禁用操作，不回归现有行为。
- 旧服务端：新客户端上报多一个字段会被忽略；前端拿不到 `assigneeUserId` 时禁用。
- 无数据库破坏性变更，只加可空列。

## 7. 验证

- 服务端：`packages/server/test/task-ownership-inbox.test.js` 覆盖 upsert 携带/缺失 `assigneeDevId`、list 返回负责人解析结果、未知 dev id。
- 前端：`packages/web/test/ownership-inbox.test.js` 覆盖 normalizeItem 新字段；组件测试覆盖负责人/非负责人/未知负责人三种按钮状态与调用参数。
- Rust：`ownership_inbox.rs` 相关测试覆盖 upsert payload 带 `assigneeDevId`；`set_task_ownership` 对非本机任务返回 INVALID 的既有测试保持通过。
- 手动：负责人本机复现本次场景，归属 `main` 后确认上传成功、inbox 行消失、任务出现在 main 看板。

## 8. 回滚

- 前端/客户端回退后，服务端多出的可空列不影响旧代码；inbox 行行为恢复为只读展示。
- 若解析负责人导致性能问题，可在 list 的 SQL 中改为 LEFT JOIN，避免逐行查询。
