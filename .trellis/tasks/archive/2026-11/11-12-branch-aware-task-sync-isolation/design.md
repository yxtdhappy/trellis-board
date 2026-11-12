# 同一仓库跨分支任务串写修复设计

## 1. 目标与不变量

本次修复围绕三个不变量：

1. 一个 Agent 的一个 `localRepoKey` 在服务端和本地配置中最多只有一个有效任务空间 binding。
2. 任何任务快照写入本地文件或上传服务端前，本地真实 Git 分支必须等于 binding 的 `branchName`。
3. 分支不一致时失败关闭：不自动切换分支、不写任务目录、不上传、不推进 cursor、不补发 pending。

当前生效链路是 tasks-only 任务快照同步。`agent/live-sync.js` 没有被当前 Agent runtime 导入，`/api/agent/live-*` 也已从 Team 路由移除，因此不在本次修改范围。

## 2. 职责与边界

| 层 | 职责 |
| --- | --- |
| Web 接入引导 | 展示同仓库旧、新绑定，用户确认后发起替换 |
| Tauri / sidecar | 传递确认结果，调用 Agent 关联命令，重启 sidecar 使新 binding 生效 |
| Agent ConfigStore | 原子替换本地 binding；新写入禁止同仓库多 binding |
| Agent Git guard | 读取本地真实分支，不匹配时抛 `BRANCH_MISMATCH` |
| Agent 任务快照同步 | 在上传、拉取、首次同步、补同步和 pending retry 前后执行分支门禁 |
| Team taskSpaces | `attach` 事务中撤销同一 Agent、同一 `localRepoKey` 的旧 binding |
| Team taskSnapshots | 校验上传携带的 `observedBranchName`，拒绝跨任务空间写入 |
| 维护脚本 | 对存量重复任务做只读审计、dry-run 和单独授权的清理 |

服务端仍不 clone、fetch 或读取项目 Git。服务端只能校验 Agent 主动上报的分支；真实分支的最终判断在 Agent。

## 3. 绑定替换设计

### 3.1 桌面确认

接入向导打开后并行读取 `list_local_associations`。如果存在与当前 `inspection.root` 相同的关联：

- 展示旧关联的分支和任务空间。
- 展示准备接入的当前分支。
- 明确提示“替换后本机停止同步旧分支；旧分支任务和服务端任务空间不会删除”。
- 用户点击明确按钮后才执行替换。

确认不是自动切 Git 分支。Git 当前分支在打开向导时由 `inspect_project` 读取，关联前由 `inspectRepository` 再校验一次。

### 3.2 服务端 attach 事务

修改 [task-space-service.js](../../../server/team/task-space-service.js:407) 的 `attach()`：

1. 校验项目、团队、分支、远端和新的 taskSpace。
2. 在同一 `withTransaction(db, ...)` 中查找 `agent_id` 相同、`local_repo_key` 相同且 `task_space_id` 不同的旧 binding。
3. 将旧 binding 状态更新为 `revoked`。
4. 取消旧 binding 上 `pending`、`delivered`、`running` 的命令，错误文本为“任务空间绑定已被本机新分支替换”。
5. 创建或更新新 binding 为 `approved`。
6. 为替换动作追加审计事件。
7. 返回向后兼容的新字段：

```json
{
  "replacedBindings": [
    {
      "id": "old-binding-id",
      "taskSpaceId": "old-task-space-id",
      "branchName": "codex/server-gitless-task-sync",
      "status": "revoked"
    }
  ]
}
```

旧 taskSpace、任务文件、revision、cursor 和其他设备的 binding 均保持不变。只有当前 Agent 的旧 binding 被撤销。

事务保证不会出现“新 binding 已生效但旧 binding 仍 approved”的中间状态。并发 attach 由 SQLite `BEGIN IMMEDIATE` 串行化，后一个请求基于已撤销状态幂等收敛。

### 3.3 本地配置原子收敛

修改 [project-onboarding.js](../../../agent/project-onboarding.js:441)：

```js
bindings: config.bindings.filter(
  (item) =>
    item.taskSpaceId !== binding.taskSpaceId &&
    item.localRepoKey !== binding.localRepoKey,
)
```

然后追加新 binding，由 ConfigStore 一次原子写入：

- 新写入和普通更新禁止同一 `localRepoKey` 出现多个 approved binding。
- 为兼容当前已产生的双绑定，`readConfig()` 允许读取旧配置，避免 Agent 因无法启动而失去修复入口。
- `_saveConfigUnlocked()` 和关联命令执行严格校验；任何写入都必须收敛到单 binding。

服务端 attach 成功但本地配置写入失败时：

- 不恢复旧本地 binding。
- 下次关联重试使用同一 taskSpace 和 Agent，服务端 attach 幂等。
- 重试成功后原子写入新配置并重启 sidecar。

### 3.4 运行时防双写

在修复发布前遗留下来的双绑定可能暂时仍存在。`AgentTaskSnapshotSync._setBindings()` 必须按 `localRepoKey` 分组：

- 每组只允许一个 binding 决定加入 watcher 和 queue。
- 选择标准是该 binding 的 `branchName` 等于仓库当前真实分支。
- 无匹配或多个匹配时不创建 watcher，并将相关 binding 标记为分支/绑定冲突。
- 即使配置尚未被用户重新关联，旧版本造成的双 write 也不能继续。

这一步是迁移保护，不替代后续的服务端 binding 撤销和本地配置收敛。

## 4. 分支门禁设计

### 4.1 复用现有 Git 能力

在 [git-sync.js](../../../agent/git-sync.js:471) 中新增单一导出的轻量函数：

```js
assertRepositoryBranch({ repoPath, branchName, hooksDir })
```

实现复用现有：

- `validateRepositoryRoot()`
- `validateBranch()`
- `runGit('current-branch')`
- `AGENT_ERROR_CODE.BRANCH_MISMATCH`

返回 `{ root, branchName }`，不执行 fetch/merge，不修改工作区。

### 4.2 任务快照门禁点

在 [task-snapshot-sync.js](../../../agent/task-snapshot-sync.js:216) 增加 `_assertBindingBranch(binding)`，并覆盖：

- `_pull(binding)` 开始处。
- `_uploadDirectories(binding, ...)` 开始处。
- `_uploadBatch()` 实际发出网络请求前再次校验，避免长批次中途切分支。
- 每个服务端目录应用到本地前再次校验，避免下载期间切分支后写入错误目录。
- `syncDeferredTasks()` 通过 `_uploadDirectories()` 自动继承门禁。
- pending batch 只能经上述入口重试。

不会在每次读取普通文件时启动 Git 子进程；门禁按同步操作和实际写边界执行。

分支不匹配时：

- 抛 `BRANCH_MISMATCH`。
- 将 binding 的 `liveSyncStatus` 置为 `error`。
- 将 `lastErrorCode` 置为 `BRANCH_MISMATCH`。
- `lastError` 写为“本地当前分支为 X，绑定分支为 Y，已暂停同步”。
- 发出现有 `task_sync_error` 控制事件。

切回绑定分支后的下一次 pull/upload/heartbeat 会重新校验；成功后清除分支错误并把状态恢复为 `ready`。恢复时先拉取服务端增量，不直接重放旧 pending。

### 4.3 上传上报分支

所有任务快照写入请求携带：

```json
{
  "observedBranchName": "main",
  "batchId": "...",
  "clientSequence": 12,
  "files": []
}
```

修改 [task-snapshot-service.js](../../../server/team/task-snapshot-service.js:604)：

- HTTP 层强制 `observedBranchName` 必填并符合 Git 分支规则；服务层对上报值再次校验。
- 必须等于 `space.branch_name`。
- 必须等于 `binding.branch_name`。
- 不一致返回 `400 BRANCH_TASK_SPACE_MISMATCH`。

冲突处理中的 `overwrite-server` 同样必须携带并校验 `observedBranchName`，不能绕过普通上传门禁。

旧客户端不发送该字段时写入被拒绝。heartbeat 协议号不升级，因为请求形状之外的 Agent 生命周期协议未变化；部署后旧客户端无法继续写任务，必须升级，这是刻意选择的失败关闭行为。

## 5. UI 状态

复用现有本地关联状态，不新增第二套状态库。

- `BRANCH_MISMATCH` 映射为“分支不一致，已暂停同步”。
- 项目栏显示实际分支和绑定分支的错误文本，恢复前不显示“同步正常”。
- 用户可通过重新打开接入向导查看旧、新分支并替换 binding。
- 分支不一致不会自动隐藏任务空间或删除任务卡，避免用 UI 掩盖数据问题。

## 6. 存量重复任务清理

新增只运行在本机的维护脚本 `scripts/task-space-duplicate-cleanup.js`，默认 dry-run：

```text
node scripts/task-space-duplicate-cleanup.js \
  --database <board.sqlite> \
  --project <projectId> \
  --remove-task-space <oldTaskSpaceId> \
  --keep-task-space <keepTaskSpaceId>
```

审计规则：

- 只比较指定项目内的两个 taskSpace。
- 重复条件是 `task.json.id` 和 `relative_dir` 同时相同。
- 输出重复任务、文件数量、内容摘要是否一致、最后 revision 和来源。
- 任一目标缺少稳定 task ID 时拒绝自动清理。

执行规则：

- `--apply` 必须显式传入。
- 执行前使用 `VACUUM INTO` 写数据库备份。
- 同一事务内为待删除文件写 `deleted=1` 墓碑、写 `sync_file_audit`、递增旧 taskSpace revision，并重建索引。
- 不删除其他 taskSpace、不删除归档任务、不动 Git 工作区。
- 当前服务运行中默认拒绝 `--apply`；要求先停止服务或使用维护模式，避免与 Agent 并发写入。

## 7. 兼容性与风险

- `replacedBindings` 为附加响应字段，不破坏旧客户端解析。
- 服务端强制 `observedBranchName` 会使未升级 Agent 无法写入任务快照；这是防止继续污染的必要行为。
- 现有双绑定配置允许读取但禁止再次写出；运行时 watcher 只保留真实分支匹配项。
- attach 和 ConfigStore 更新不是分布式事务。服务端先提交、本地后提交，失败时依靠幂等重试，不恢复旧 binding。
- 清理脚本是破坏性操作，默认 dry-run，实际执行必须单独授权并先备份。

## 8. 回滚

- 代码回滚可恢复旧行为，但不回滚已撤销的 binding 或已清理的 tombstone。
- 数据库备份是存量清理的唯一自动回滚点。
- 客户端配置写入使用临时文件加 rename；失败不会产生半个 JSON。
- 服务端 attach 事务失败会回滚新 binding、旧 binding 状态和命令取消。
