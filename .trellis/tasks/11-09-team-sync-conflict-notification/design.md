# 实时同步冲突覆盖提示设计

## 1. 边界

本任务只调整桌面 Agent 在“服务端覆盖本地文件”后的冲突元数据和本地控制窗口展示，不修改：

- 服务端实时同步 API、数据库 schema 或 revision 分配；
- 冲突解决策略，仍以服务端内容覆盖本地；
- watcher 抑制、原子写、备份顺序和一键复原协议。

## 2. 数据流

```text
GET live-files
  -> _backupConflicts 逐个比较本地/远端摘要
  -> 生成冲突文件元数据并写入 manifest
  -> _applyRemoteFiles 写入远端内容
  -> remote_overwrite 控制事件
  -> live-control 窗口展示
  -> 现有 live_control_restore 恢复整个备份
```

## 3. 冲突元数据

`_backupConflicts` 仍在原始 SHA-256 不同时判定冲突，保持现有数据安全语义。只增加描述字段：

```json
{
  "path": ".trellis/tasks/task-a/task.json",
  "taskKey": "projectId::.trellis/tasks/task-a",
  "revision": 38,
  "localSha256": "...",
  "remoteSha256": "...",
  "existedLocally": true,
  "changeType": "content"
}
```

- `taskKey` 优先使用服务端文件已有的 `taskKey`，缺失时由路径推导。
- `revision` 使用文件自身的实时 revision，而不是本次拉取的全局 revision。
- `changeType` 只取 `content` 或 `line-endings`。
- `manifest.taskKeys` 改为从真实冲突文件 `manifestFiles` 计算。

### 换行差异分类

仅在以下条件同时满足时标记 `line-endings`：

1. 操作为 `upsert`；
2. 本地文件存在；
3. 本地和远端内容都能按规范 UTF-8 解码；
4. 把 `CRLF` 统一为 `LF` 后文本完全相同。

分类只影响提示文案，不跳过备份和覆盖。删除、新增、非法 UTF-8、其他空白或字符变化均归为 `content`。

## 4. 控制事件

`remote_overwrite` 保持现有字段兼容，并新增：

```json
{
  "conflicts": [
    {
      "path": ".trellis/tasks/task-a/task.json",
      "taskKey": "projectId::.trellis/tasks/task-a",
      "revision": 38,
      "changeType": "line-endings"
    }
  ]
}
```

- 保留 `files` 字符串数组和 `fileCount`，避免其他消费者失效。
- `taskKeys` 继续从 `backup.files` 计算。
- 不把完整文件正文或摘要发送给控制窗口。

## 5. 控制窗口

- 摘要显示“N 个任务、M 个文件”和全局同步版本。
- 任务键去掉 `projectId::` 前缀，展示 `.trellis/tasks/...` 相对目录。
- 文件明细展示路径、`文件版本 rN` 和“内容变化”/“仅换行差异”。
- `event.conflicts` 缺失时回退使用 `event.files` 字符串数组。
- 一键复原文案明确说明会恢复本次全部文件、形成新团队版本并广播。
- 弹窗不提供单文件恢复、diff 或合并能力。

## 6. 兼容与回滚

- 新增 manifest 和事件字段均为可选附加字段，不提升 schemaVersion。
- 旧 manifest 的一键复原仍只依赖 `path`、`existedLocally` 和备份文件。
- 回滚本次代码不会影响已生成的备份内容；旧代码会忽略新增字段。
- 不自动恢复任何历史冲突。

## 7. 风险

- 换行分类依赖规范 UTF-8；无法可靠解码时保守按实质内容变化处理。
- 一键复原仍作用于整个备份，因此提示必须明确“全部文件”。
- 文件版本是服务端最后一次变更版本，不是本次全局拉取版本。
