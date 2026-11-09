# 客户端任务实时上报、落盘与广播技术设计

## 1. 目标与依赖

团队模式下，已关联项目的桌面客户端监听本地 `.trellis`，把未提交变化上传服务端。服务端按文件串行分配版本，更新权威任务投影，并通过 SSE 通知其他客户端。其他客户端刷新 Board、备份冲突文件并写入服务端最新内容。

依赖：

- `11-08-support-multi-team-board` 的多团队 Session、项目权限和设备身份。
- `11-08-desktop-account-login` 的登录、设备凭据、项目关联和 approved binding。
- 单机 watcher 继续作为单机模式的唯一实时刷新来源。

## 2. 核心不变量

1. 团队服务端不启动本地项目 `.trellis` watcher。
2. 单机服务端与团队 sidecar 复用同一 watcher 核心。
3. 服务端文件版本是任务实时内容的唯一权威版本。
4. 并发按请求到达顺序处理，粒度是文件；不同文件合并，同一文件后到覆盖。
5. 客户端应用远端文件前，若本地内容不同，先备份再覆盖。
6. 一键复原把备份作为新版本上传，不只修改本机。
7. Git 是最终代码历史，但不能用较旧 Git 内容静默覆盖更新的实时版本。
8. 非责任人本地修改由发起方阻断提示；原责任人只收通知。
9. 正常网络下，从来源端保存到目标端 Board 可见且本地文件落盘，P95 ≤ 3 秒。

## 3. 架构

```text
来源客户端
  shared watcher
    -> 文件变化批次
    -> 责任人预检
    -> POST /api/agent/live-changes
                         |
                         v
团队服务端 --------------------------------------------
  | 校验设备、绑定、团队成员和路径                    |
  | 文件级事务 + 单调 revision                       |
  | 更新 team_task_index 实时投影                    |
  | SSE: live.changed                                |
  ---------------------------------------------------
       |                         |
       v                         v
其他 sidecar                 Board Web UI
  | 拉取 revision               | 短轮询 revision
  | 备份冲突文件                 | 重新查询任务
  | 原子写入本地 .trellis        |
  | 更新 agent cursor            |
```

## 4. 共享 watcher

当前 [server/watcher.js](../../../server/watcher.js) 已具备目录过滤、递归监听和状态统计。实施时提取为共享模块：

```text
shared/trellis-watcher.js
  createTrellisWatcher({
    repositories,
    onChange,
    onError,
    watch,
    debounceMs
  })
```

规则：

- 保留现有监听根：`.trellis/tasks`、`.trellis/workspace`、`.trellis/.developer`。
- `server/watcher.js` 改为共享模块的薄包装，单机代码不复制 watcher。
- sidecar import 同一个共享模块，以 approved binding 的本地仓库作为 repositories。
- 防抖后按项目/绑定聚合为批次，避免每个文件触发一次请求。
- binding 新增、撤销、项目停用或登录切换时重建 watcher。
- watcher 关闭要清理所有 `fs.watch`、计时器和待发送批次。

## 5. 客户端上报

### 5.1 变化分类

`classifyLivePath()` 只接受：

- `.trellis/.developer`
- `.trellis/workspace/**`
- `.trellis/tasks/**`

拒绝绝对路径、`..`、NUL、符号链接、目录穿越和非 UTF-8 文本。首版只同步文本文件：

```text
.json .jsonl .md .txt .yaml .yml
```

### 5.2 批次

```json
{
  "projectId": "project-1",
  "bindingId": "binding-1",
  "batchId": "uuid",
  "clientSequence": 42,
  "observedAt": "2026-11-08T12:00:00.000Z",
  "assigneeDecision": {
    "warningId": "uuid",
    "action": "continue"
  },
  "files": [
    {
      "path": ".trellis/tasks/11-08-example/task.json",
      "operation": "upsert",
      "sha256": "<64 hex>",
      "content": "{...}"
    }
  ]
}
```

限制：

- 单文件 1 MiB。
- 单批次 8 MiB、最多 64 个文件。
- 同一项目每秒最多 5 个批次；超出返回 429。

### 5.3 自触发抑制

sidecar 应用远端文件前记录 `(absolutePath, remoteSha256)`。watcher 收到事件后：

1. 计算当前文件摘要。
2. 仅当摘要等于刚写入的远端摘要时忽略。
3. 用户或工具在抑制窗口内再次修改导致摘要变化时，必须照常上报。

不能只按路径和时间抑制，否则会吞掉紧接着发生的真实本地编辑。

## 6. 服务端数据模型

数据库 schema 升级到 v7，新增：

### `project_live_revision`

| 字段 | 说明 |
| --- | --- |
| `project_id` | 主键 |
| `revision` | 项目单调递增版本 |
| `updated_at` | 最后更新时间 |

### `project_live_file`

| 字段 | 说明 |
| --- | --- |
| `project_id, relative_path` | 联合主键 |
| `revision` | 写入该内容的项目版本 |
| `sha256` | 内容摘要 |
| `content_text` | UTF-8 内容；删除时为 NULL |
| `deleted` | 删除墓碑 |
| `task_key` | 所属任务；workspace/developer 可为空 |
| `source_agent_id, source_user_id` | 来源身份 |
| `updated_at` | 写入时间 |

### `project_live_batch`

保存 `batchId`、请求摘要、项目、Agent、用户、revision、时间。`batchId` 唯一，用于幂等重试。

### `agent_live_cursor`

| 字段 | 说明 |
| --- | --- |
| `agent_id, project_id` | 联合主键 |
| `revision` | 已成功拉取并落盘的版本 |
| `updated_at` | 更新时间 |

`team_task_index` 增加 `live_revision` 标记。`live_revision > 0` 的行由实时文件投影生成；Git 完整扫描不得无条件覆盖这些行。

## 7. 服务端接收事务

`POST /api/agent/live-changes`：

1. 用现有 Agent 凭据认证用户和设备。
2. 校验 binding 为 `approved`，项目属于该团队且未停用，用户仍有项目写权限。
3. 校验路径、文件类型、大小、批次数量、速率和摘要。
4. `batchId` 已存在时返回原 revision，不重复应用。
5. `BEGIN IMMEDIATE`：
   - 分配项目递增 revision；
   - 逐文件 upsert `project_live_file`；
   - 插入 `project_live_batch`；
   - 记录审计。
6. 提交后用实时文件视图重建受影响任务投影。
7. 发布 `live.changed` 事件并通知 Board revision。

任何一步失败都回滚，不向其他客户端广播半批次。

## 8. 实时任务投影

不能直接信任客户端声称的任务阶段。服务端用收到的文件内容重新走现有 `server/loader.js` 的任务解析与阶段推导。

新增 `materializeLiveTask(project, taskRelativeDir)`：

1. 从服务端 Git 工作副本读取该任务当前文件作为基线。
2. 用 `project_live_file` 覆盖对应路径。
3. 在系统临时目录创建最小 `.trellis` 视图；该目录必须位于所有业务 Git 工作区之外，
   不能要求接入项目修改 `.gitignore`，也不依赖服务端 Git 全局排除规则。
4. 调用现有任务投影逻辑，生成与普通扫描一致的任务行；文件内容从临时视图读取，
   Git HEAD 与分支元数据仍从未修改的业务工作区读取。
5. 原子更新 `team_task_index`，标记 `live_revision`。
6. 删除临时目录。

`.trellis/workspace` 或 `.developer` 变化时，重新计算受影响 developer 的任务；无法精确映射时回退为项目内相关任务重算。

## 9. 广播与拉取

新增 Agent 事件：

```text
live.changed
payload: { teamId, projectId, revision, taskKeys, sourceAgentId }
```

Agent 收到事件后调用：

```text
GET /api/agent/live-files?projectId=<id>&afterRevision=<cursor>
```

返回：

- 当前项目 revision；
- 每个路径的最新文件内容或删除墓碑；
- 关联 taskKey；
- 是否需要完整重同步。

客户端按文件应用成功后才推进 `agent_live_cursor`。断线重连后从 cursor 补拉最新文件；同一文件中间版本可跳过，只应用当前最新内容。

Board Web UI 新增轻量轮询：

```text
GET /api/team/live-revision
```

正常在线时每 750ms 查询一次。revision 或 taskKeys 变化时立即重载当前任务查询，不再等待 3 秒团队状态轮询。

## 10. 客户端本地应用与备份

### 10.1 备份位置

```text
%LOCALAPPDATA%\TrellisBoard\data\agent\live-backups\
  <projectId>\
    <timestamp>-<revision>-<batchId>\
      manifest.json
      <原相对路径>
```

备份位于项目工作区外，防止 watcher 再次扫描。`manifest.json` 记录项目、任务、路径、本地摘要、远端摘要、revision、来源设备、备份时间和恢复状态。

### 10.2 应用顺序

对每个远端文件：

1. 读取本地文件摘要。
2. 摘要相同则只推进 cursor。
3. 摘要不同则复制本地文件到备份。
4. 创建父目录，写临时文件、fsync、原子 rename。
5. 删除操作先把本地文件复制到备份，再 unlink。
6. 所有文件成功后原子写入 `agent_live_cursor`。
7. 失败时保留备份、停止该批次后续写入并显示同步失败。

### 10.3 覆盖通知和一键复原

覆盖成功后，通过 Tauri 本地控制窗口显示：

- 任务名称和路径；
- 被覆盖文件数量；
- 远端 revision；
- 备份位置；
- “一键复原”按钮。

一键复原：

1. 从备份读取文件。
2. 以新的 `batchId` 上传到服务端。
3. 服务端分配更高 revision，广播所有客户端。
4. 其他客户端执行备份后覆盖。
5. 当前客户端在 watcher 抑制窗口内写回文件。

因此复原不是本地分叉，而是新的权威版本。

## 11. 责任人警告

### 11.1 警告判定

上传前调用：

```text
POST /api/agent/live-changes/preflight
```

输入项目、任务标识和拟变化路径。服务端返回：

```json
{
  "requiresConfirmation": true,
  "warningId": "uuid",
  "assignee": { "username": "alice", "displayName": "Alice" },
  "expiresAt": "..."
}
```

当前操作者为责任人、任务无责任人或路径不属于任务时不需要警告。

### 11.2 本地交互

sidecar 把待确认变化保存在本地 pending 队列，向 Rust 输出不含文件内容的控制事件。Tauri 打开本地 `control.html` 模态窗口：

- 取消：备份本地改动，恢复服务端当前文件，不推进本地 realtime cursor。
- 继续推进：保留原责任人，上传批次并写审计。
- 接管任务：先把本地 `task.json.assignee` 更新为当前用户映射的 Trellis developer ID，再上传并变更责任人。

服务端必须再次校验 `warningId`、当前 revision 和责任人，不能只相信前端。

### 11.3 原责任人通知

`continue` 或 `takeover` 成功后，服务端向原责任人发送 `task.live.overridden` 通知。Board 显示通知，不需要原责任人在线确认。

### 11.4 Board 直接写操作

通过 Board API 修改有责任人任务时，服务端返回 `ASSIGNEE_CONFIRMATION_REQUIRED`。Web UI 复用同一三按钮弹窗后携带确认结果重试。

## 12. Git 收敛

Git 拉取或任务写入后：

1. 计算 Git 文件和 `project_live_file` 的 SHA-256。
2. 摘要相同：删除对应实时覆盖行。
3. 删除墓碑且 Git 也不存在：删除覆盖行。
4. 摘要不同：保留实时覆盖，继续作为 Board 最新状态。
5. 某任务所有覆盖行清空后，清除 `team_task_index.live_revision`，恢复 Git 扫描结果。
6. 脏检查只要求目录级未跟踪结果，不展开每个未跟踪文件，也不依赖接入项目
   `.gitignore` 或服务端 Git 全局排除规则。

不允许仅因 Git commit 时间更晚就覆盖内容不同的实时版本。若长期不一致，项目状态显示“实时内容尚未进入 Git”，由用户后续 commit/push 收敛。

## 13. 保留与清理

- `project_live_file` 最新状态保留到 Git 摘要一致。
- `project_live_batch` 审计保留 30 天。
- 本地备份保留 30 天，且每个任务至少保留最近 20 份；超限只清理最旧备份。
- 清理备份前必须确认没有 pending 复原记录。

## 14. 安全与错误

| 条件 | 行为 |
| --- | --- |
| binding 非 approved | 403 |
| 设备撤销或账号禁用 | 现有 Agent 认证失败 |
| 路径越界、符号链接或二进制 | 400，整批拒绝 |
| 文件/批次超限 | 413 |
| 频率超限 | 429，可重试 |
| 重复 batchId | 返回原 revision |
| 责任人确认过期 | 409，重新 preflight |
| 本地写盘失败 | 保留备份，cursor 不推进，显示错误 |
| SSE 断线 | 重连后按 cursor 拉取最新文件 |

日志不得包含文件正文。审计只记录路径、摘要、revision、来源和动作。

## 15. 风险与回滚

- 最大风险是实时内容与 Git 工作区长期分叉。必须显示“实时未入 Git”状态，并禁止静默清理覆盖层。
- 自动写回可能触发 IDE 文件变化提示；首版通过备份和复原入口兜底。
- 文件级最后写入优先仍可能覆盖同一文件的并发编辑，备份和复原是恢复手段，不提供自动文本合并。
- 回滚点：共享 watcher -> 服务端存储与投影 -> Agent 拉取落盘 -> Tauri 提示/复原 -> Board 快速刷新。每层可独立关闭实时同步开关。

