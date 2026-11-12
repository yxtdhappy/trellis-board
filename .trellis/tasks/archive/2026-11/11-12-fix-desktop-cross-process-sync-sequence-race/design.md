# 桌面跨进程同步序号一致性设计

## 1. 目标与边界

目标是让常驻 Agent 和控制 Sidecar 即使同时操作同一任务空间，也只能基于最新持久化游标预占批次，并让已经残留错误序号的客户端在升级后自动恢复。

保持现有进程边界：

- 常驻 Agent 继续负责 watcher、事件拉取和后台同步。
- 控制 Sidecar 继续以独立一次性进程执行首次同步与冲突处理。
- `live-cursors.json` 的 v3 数据结构和任务快照 API 保持不变。

服务端继续保持 `clientSequence` 在单个 Agent/taskSpace 内严格递增，只增加冲突提示字段，不降低校验强度。

## 2. 客户端游标并发模型

### 2.1 跨进程锁

`ConfigStore` 增加可复用的文件锁执行器，并暴露 `withLiveCursorLock()`：

- 锁文件使用 Agent 根目录下的独立路径，避免与 `agent.lock`、`.config.lock` 混用。
- 复用现有排他创建、超时和陈旧锁回收逻辑。
- 锁只覆盖游标文件的读取、内存变更和原子写入，不在持锁期间执行网络请求。

### 2.2 禁用永久内存缓存

`AgentTaskSnapshotSync._readCursorState()` 每次从磁盘读取完整状态。文件通过原子 rename 更新，因此读取只能看到旧版本或新版本，不会看到半写文件。

同一实例内部仍使用串行队列，避免自己的并发调用互相覆盖。跨进程一致性由 `withLiveCursorLock()` 保证。

### 2.3 统一游标变更入口

新增内部 `_mutateCursorState(taskSpaceId, mutator)`：

1. 进入当前实例的串行队列。
2. 获取跨进程 `liveCursors` 锁。
3. 从磁盘重新读取状态。
4. 调用 mutator 生成新状态和返回值。
5. 原子写入文件并释放锁。

`_writeCursor()`、批次预占和自动恢复都通过该入口，禁止绕过锁直接写 `live-cursors.json`。

## 3. 批次预占与上传

### 3.1 原子预占

`_uploadPersistedBatch()` 不再使用调用方先前读取的 `cursor.sequence`，而是在 `_mutateCursorState()` 内完成：

- 如果当前任务空间已有 pending，返回该 pending，不创建第二个批次。
- 如果没有 pending，生成 `batchId`、`clientSequence = currentSequence + 1`，先持久化 pending，再释放锁。

两个进程同时上传时：

1. A 预占序号 N+1 并写入 pending。
2. B 看到同一 pending，只能重放相同批次。
3. pending 成功后重新读取游标，下一批预占 N+2。

重放使用原 `batchId + clientSequence + files`，服务端返回原 revision，不产生重复写入。

### 3.2 历史错误游标恢复

服务端在序号校验失败时继续返回 `409 CONFLICT`，新增只读 details：

```json
{
  "previousSequence": 1,
  "requiredClientSequence": 2
}
```

客户端识别 `CONFLICT + requiredClientSequence` 后：

1. 在游标锁内更新 pending 的 `clientSequence`。
2. 保留原 `batchId` 和文件内容；该批次此前未写入服务端，不会触发“同批次不同内容”冲突。
3. 立即重试一次。
4. 成功后再推进本地游标并清除 pending。

只自动修正一次。若服务端再次返回更新的序号或非法 details，则把原始错误交给现有同步失败处理，避免无限重试。

### 3.3 冲突处理

`overwrite-server` 路径绕过普通批次上传，需要在发送冲突解决请求前读取最新游标，并对同一 `CONFLICT + requiredClientSequence` 情况执行一次相同的序号修正。成功或返回 `TASK_FILE_CONFLICT` 后仍按现有逻辑更新游标和基线。

## 4. 数据结构与兼容性

- `live-cursors.json` 继续使用 `version: 3`。
- 新增锁文件是瞬时运行文件，不进入配置、游标 schema 或服务端协议。
- 服务端错误 code 保持 `CONFLICT`，避免破坏旧客户端；旧客户端只会继续显示原错误文案。
- 新客户端兼容无 `requiredClientSequence` 的旧服务端；无法自动恢复时仍走原有错误展示。
- 网络响应丢失后，服务端先按 `batchId` 重放，再检查序号，因此原批次重试不被自动修正逻辑破坏。

## 5. 失败与回滚

- 游标锁超时返回现有 `LOCKED` 语义，不执行任何上传。
- 自动恢复只修改当前 Agent/taskSpace 的 pending 序号；不修改 `revision`、`baselines`、`deferred` 或其他任务空间。
- 修正后上传仍受 CAS 校验。若服务端内容已变化，返回正常 `TASK_FILE_CONFLICT`，由用户选择版本。
- 回滚只需还原代码；锁文件删除或残留不改变业务数据。陈旧锁由现有超时规则回收。

## 6. 主要取舍

- 选择短锁包围游标变更，而不是在网络请求期间锁住任务空间。吞吐更好，但另一个进程可能先重放同一 pending；这由 batchId 幂等保证安全。
- 保留独立控制 Sidecar，不引入本地 IPC 服务，改动面更小。
- 服务端返回必要序号提示，而不是让客户端猜测或跳过任意增量。

## 7. 验证策略

- 双实例并发预占测试：断言新建批次的序号为 1、2，不出现两个不同的序号 1。
- 双实例可见性测试：A 写序号 1 后，B 下一次读取必须为 1。
- 历史错误 pending 测试：首次返回 requiredClientSequence=2，第二次接受序号 2，最终 pending 清空。
- 网络失败重放测试：再次断言批次三元组完全不变。
- 服务端测试：非递增批次被拒绝，revision 和批次表不新增，details 返回 previous/required sequence。
- 最终执行仓库已有的完整测试和一次编译验证。
