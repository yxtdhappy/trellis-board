# 本地任务 deferred 状态与补同步设计

## 1. 边界

本次保持现有同步事实源不变：

- 服务端继续只保存 tasks-only 快照并维护 revision、CAS 和索引。
- 客户端 `live-cursors.json` 继续保存每个 taskSpace 的 `deferred` 任务目录。
- 不新增服务端接口，不改变任务文件格式，不改变 `safe` 首次同步行为。

新增能力只负责把客户端已有 deferred 状态暴露给桌面 UI，并在用户确认后复用现有上传链路。

## 2. 数据契约

`desktop/sidecar/desktop-device.js` 的 `readLocalAssociations()` 同时读取配置和可选的 live cursor：

```json
{
  "taskSpaceId": "...",
  "liveSyncStatus": "ready",
  "deferredCount": 3,
  "deferredTaskDirs": [
    ".trellis/tasks/task-a",
    ".trellis/tasks/task-b"
  ]
}
```

- `deferredTaskDirs` 只取当前 binding 对应 taskSpace 的 `Object.keys(deferred)`。
- 两个字段为可选；文件缺失、JSON 损坏或 taskSpace 不存在时返回空数组/0，避免关联列表整体不可用。
- Tauri `LocalAssociation` 使用 serde default 保持旧 sidecar 兼容。
- 前端类型守卫忽略未知字段，并把非数组值归一化为空数组。

## 3. 补同步链路

新增桌面端命令：

```text
board invoke: sync_deferred_tasks(taskSpaceId)
  -> Tauri ensure_board_caller
  -> sidecar: live-sync-deferred --task-space <id>
  -> AgentTaskSnapshotSync.syncDeferredTasks(taskSpaceId)
  -> 现有 _uploadDirectories() / _uploadPersistedBatch() / CAS / 限流
  -> _pull()
  -> 返回 syncedCount、remainingCount、conflict
```

实现要求：

- 先从当前 cursor 取 deferred 目录快照，空集合直接返回成功。
- 使用现有按 taskSpace 串行队列，禁止并发补传同一 taskSpace。
- 每个目录仍通过 `_filesForDirectory()` 计算 `baseSha256`，不得临时读取服务端最新摘要绕过冲突。
- 上传成功后由现有 `clearDeferredForFiles()` 清理状态，再通过 `_pull()` 对齐新 revision。
- 遇到 `TASK_FILE_CONFLICT` 时返回冲突结果，保留现有 `task_file_conflict` 控制事件，不继续覆盖后续任务。

## 4. Tauri 与权限

- `desktop/src-tauri/src/sidecar.rs` 新增 `sync_deferred_tasks()` 包装 sidecar JSON 命令。
- `desktop/src-tauri/src/main.rs` 新增 `sync_deferred_tasks` command，使用 `ensure_board_caller`，只允许本地 Board WebView 调用。
- `desktop/src-tauri/permissions/desktop.toml` 新增对应 permission。
- `desktop/src-tauri/capabilities/board-local-association.json` 增加 permission。
- 参数只接受现有任务空间 ID 校验规则，不接受本地路径、文件列表、Git 命令或额外命令参数。

## 5. 前端行为

### 状态

- `ProjectAssociationView` 增加待处理分支：approved、非只读、`deferredCount>0` 时显示“已关联 · N 个本地任务未同步”。
- 父项目聚合优先选择 deferred 关联，顺序在 `syncing` 之后、`pending` 之前；关联失效和 `error` 仍优先。
- 分支行显示警示色圆点和可访问的 `title`，任务目录 basename 用于辅助说明。

### 操作

- 只在分支行显示补同步按钮；按钮文案或 `aria-label` 包含数量和分支名。
- 点击后使用确认对话框说明“将把 N 个本地任务上传到该分支”，用户取消时不调用 Tauri。
- 请求期间禁用该分支的重复入口；成功后用 Sonner 提示并立即重新读取 associations。
- 冲突结果提示“存在冲突，请处理确认窗口”，不显示成功；失败显示脱敏错误。
- 为避免状态轮询误触发，上传只由点击事件调用。

### 多分支语义

- 保留 `taskSpaceId + taskKey` 身份和现有分支筛选。
- 当前范围包含多个 taskSpace 时，Overview 或看板标题增加“按分支独立统计”的说明；不改变总数和卡片分组。

## 6. 兼容与回滚

- 新 DTO 字段全部可选，旧 sidecar、旧 Tauri 和普通浏览器继续工作。
- 新命令只增加桌面能力，不影响 Web 浏览器路径。
- 回滚时可移除补同步命令和 UI 入口，`live-cursors.json` 中的 deferred 数据无需迁移。
- 不修改数据库 schema，不需要服务端回滚。

## 7. 风险

- 用户确认补传会主动把本地任务写到服务端，必须继续依赖 CAS，禁止使用“后到覆盖先到”。
- 多个任务连续上传可能触及服务端限流；必须复用现有 `_runUploadWithSlot()` 和重试逻辑。
- deferred 目录可能在读取列表后发生本地变化；命令执行时必须以任务空间串行队列内的最新 cursor 和本地文件为准。
- `live-cursors.json` 是本地运行状态文件，不应把绝对路径或凭证暴露给 Web 端；只返回规范化 task 目录。
