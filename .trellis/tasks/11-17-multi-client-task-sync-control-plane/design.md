# 技术设计：多客户端任务上报与控制面分离

## 1. 架构边界

### 1.1 服务端是任务事实源

新增服务端权威任务记录，负责：

- 任务身份、所在 taskSpace、标题、描述、优先级；
- 当前负责人、阶段、活动/归档状态；
- 客户端认领、任务版本和写租约；
- Board 查询所需的元数据、事件和审计。

现有 `sync_task_index` 继续作为查询投影，不再承担“任务是否存在”的唯一判断。
任务文件仍然通过 `sync_task_space_file` 保存已认领客户端上传的内容快照。

### 1.2 客户端是认领后的工作副本

- 客户端只在任务被本人认领、或本人明确接管时创建/更新 `.trellis/tasks/**`。
- 客户端上传本人任务内容后，服务端更新权威任务记录和内容快照。
- 其他用户的客户端不接收完整任务正文，只接收必要的控制事件或按需查询。
- `task.json` 中的负责人、阶段和归档状态由服务端权威状态生成；客户端上传不得
  用旧的 `task.json` 字段覆盖服务端元数据。

### 1.3 Git 是任务文档最终历史

- Git 负责已提交的任务文件、代码和归档目录历史。
- Git push/pull 是文件内容的最终收敛手段，不是实时控制协议。
- 客户端长时间未拉取时，服务端仍显示自己的权威状态和“本地可能落后”标记。

## 2. 数据模型

### 2.1 `sync_task`（新增，schema v16）

建议字段：

```text
execution_task_key TEXT PRIMARY KEY
task_space_id TEXT NOT NULL
project_id TEXT NOT NULL
task_id TEXT NOT NULL
relative_dir TEXT NOT NULL
title TEXT NOT NULL
description TEXT NOT NULL
priority TEXT NOT NULL
created_by_user_id TEXT NOT NULL
assignee_user_id TEXT
assignee_dev_id TEXT
stage TEXT NOT NULL
archived INTEGER NOT NULL DEFAULT 0
materialization_state TEXT NOT NULL
  -- none | pending | claimed | materialized | failed
task_version TEXT NOT NULL
content_revision INTEGER
lease_id TEXT
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
archived_at TEXT
```

约束：

- `execution_task_key` 稳定，任务目录从活动路径移动到归档路径时不变。
- `task_version` 每次服务端权威字段变化都递增；租约和上传使用它做比较。
- `materialization_state` 表示服务端是否已生成可执行的本地工作副本。
- 任务在 `pending` 时也必须在 Board 可查，但详情只返回元数据和待落地提示。

### 2.2 `sync_task_lease`（新增）

```text
id TEXT PRIMARY KEY
execution_task_key TEXT NOT NULL
agent_id TEXT NOT NULL
user_id TEXT NOT NULL
lease_token TEXT NOT NULL
status TEXT NOT NULL
  -- active | released | expired | revoked
expires_at TEXT NOT NULL
last_heartbeat_at TEXT NOT NULL
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

- 同一 `execution_task_key` 最多一个 active 租约。
- 租约令牌使用随机值，不使用任务版本充当权限凭证。
- 上传、认领确认、改派和归档都必须在事务中校验 active 租约及任务版本。
- 租约过期由查询/心跳路径和定时回收路径共同收敛，不能依赖客户端主动释放。

### 2.3 `sync_task_command`（演进）

保留现有命令表以兼容 API，但增加：

- `target_user_id`；
- 允许 `agent_id`、`binding_id` 在待交付命令中为 `NULL`；
- 命令领取时再绑定目标用户当前唯一 active Agent/binding。

这样服务端可以在没有任何目标客户端在线时先保存命令；客户端上线后通过
`/api/agent/events` 或可用命令查询领取。命令领取、绑定、running 和完成都必须
使用现有幂等键和租约。

### 2.4 现有表的关系

```text
sync_task                 权威任务和生命周期
  ├── sync_task_lease     任务写租约
  ├── sync_task_command   定向创建/改派/归档控制命令
  ├── sync_task_assignment 负责人/接收历史
  ├── sync_task_space_file 已认领任务内容快照
  └── sync_task_index     Board 查询投影（派生）
```

归档任务不再作为另一条独立任务记录写入活动索引。归档 Git 导入只更新同一
`execution_task_key` 的 `archived`、`archived_at` 和 `relative_dir`。

## 3. 服务端接口与事务

### 3.1 创建和改派

`POST /api/tasks`：

1. 校验项目、taskSpace、负责人和 slug；不要求目标 Agent 在线。
2. 生成稳定的 `execution_task_key`、`task_id` 和相对目录。
3. 在同一事务中插入 `sync_task`、负责人 assignment、`sync_task_command` 审计记录，
   并写 `audit_event`。
4. 立即推进 Board 查询版本并返回 `202` 和待交付操作。
5. 任务状态为 `pending_delivery`；目标客户端上线后完成 materialization。

`POST /api/tasks/assign`：

1. 校验目标任务存在且仍是 active。
2. 更新 `sync_task.assignee_*` 和 `task_version`。
3. 写 assignment 历史、目标用户命令和审计事件。
4. 不要求目标客户端在线；旧负责人收到解绑通知，新负责人收到待认领通知。

### 3.2 命令领取

`available(agent)` 只返回：

- `target_user_id` 等于当前 Agent 用户；
- 目标 taskSpace 与当前 binding 一致；
- 尚未成功或取消；
- 租约未过期或已回收。

领取命令时在同一事务中绑定 `agent_id`、`binding_id`，之后再执行任务。

### 3.3 内容查询

新增/演进的 Agent 接口只返回本人已认领任务的内容：

```text
GET /api/agent/tasks/:executionTaskKey
POST /api/agent/tasks/:executionTaskKey/claim
POST /api/agent/tasks/:executionTaskKey/heartbeat
POST /api/agent/tasks/:executionTaskKey/release
```

`GET` 在未持有租约时只返回元数据；持有有效租约后才返回完整文件内容。

### 3.4 本地 Agent 创建任务接入

本地 Agent 创建任务不经过 `POST /api/tasks`，而是在仓库中产生：

```text
.trellis/tasks/<MM-DD-slug>/task.json
.trellis/tasks/<MM-DD-slug>/prd.md
...
```

客户端 watcher 触发首次上传时，服务端执行 upsert：

1. 从认证 Agent 上下文取得 `created_by_user_id`，不能使用 `task.json.creator`。
2. 计算稳定 `execution_task_key` 和任务 ID；同一路径重复上传必须幂等。
3. 如果该执行身份不存在，创建 `sync_task`：
   - `created_by_user_id` = 当前认证用户；
   - `assignee_user_id` = 当前用户，或从有效项目成员映射得到的目标负责人；
   - `stage`、`task_version`、`relative_dir` 从首次快照生成；
   - `materialization_state=materialized`，因为创建者本地已有文件。
4. 保存内容快照到 `sync_task_space_file`，但只对创建者和有效租约持有者提供完整
   正文；其他客户端只看到元数据和状态。
5. 如果任务初始负责人不是创建者，创建 `pending_delivery` assignment，并给目标
   用户生成待认领控制信息。

同一任务后续被委派时，进入正常改派流程，不重新创建任务记录。

创建者本地目录不因委派而自动删除；服务端将创建者标记为非当前写持有者，创建者
下次连接后只能查看或按租约申请接管。删除/转交本地副本的行为必须由明确的归档、
手工清理或用户确认触发。

## 4. 客户端同步流程

### 4.1 启动和重连

1. 客户端连接 taskSpace，上报当前用户、Agent 和本地仓库绑定。
2. 客户端拉取自己的任务控制状态和待交付命令，不拉取全部活动任务正文。
3. 没有本地工作副本的任务保持远程状态，不写 `.trellis/tasks/**`。
4. 有本地工作副本但服务端已归档/改派的任务显示状态差异，等待清理或确认。

### 4.2 认领和落地

1. 客户端收到 `create_task`/`assign_task` 控制命令。
2. 客户端校验真实 Git 分支、仓库和 taskSpace。
3. 客户端申请写租约。
4. 服务端返回唯一 `task_id`、目标目录、版本和任务元数据。
5. 客户端执行现有 `task.py create` 或原子改派，写入工作副本。
6. 客户端上传本人任务文件，等待服务端索引；成功后 ACK 命令。
7. 服务端把 `materialization_state=materialized`，Board 保持实时。

### 4.3 修改上传

- 客户端必须先持有租约；没有租约的本地变化只能显示为待认领/冲突。
- 上传携带 `task_version`、lease token、文件摘要和 base sha256。
- 服务端只接受与命令目标 taskSpace、分支、租约和当前版本一致的内容。
- 租约过期或任务已归档时返回明确的 `TASK_LEASE_EXPIRED`/`TASK_ARCHIVED`，
  不能覆盖服务端。

### 4.4 其他客户端

- 其他客户端不自动写入该任务正文。
- 它们只收到任务 ID、状态、负责人和版本变化，用于刷新 Board 或显示远端任务。
- 如果需要查看正文，使用只读详情接口；如果需要接管，先申请租约并重新拉取。

### 4.5 本地创建的首次上传

- 创建者客户端不需要先调用 Board 创建接口。
- watcher 读到完整任务目录后，上传任务快照和元数据；服务端在首次接收时建立
  `sync_task` 权威记录并发布 Board 变更。
- 创建者继续本地工作时不等待其他客户端；其他客户端只收到任务元数据变化。
- 创建者委派他人后，本地副本保留但变为只读/待迁移，目标用户需要认领后才能
  获得自己的本地工作副本。

## 5. 归档与改派生命周期

### 5.1 归档

- 客户端执行归档后，立即发送轻量归档控制信号；失败不影响 Git 归档提交。
- 服务端把同一 `execution_task_key` 标记 `archived=1`，生成活动墓碑。
- 所有持有本地活动副本的客户端收到墓碑：
  - 本地没有变化：删除活动副本；
  - 本地有变化：移动到冲突备份，等待人工确认；
  - 仍持有有效租约：先释放租约或拒绝自动清理。
- 服务端归档 Git 同步作为最终事实校验；即使即时信号丢失，后续同步也能收敛。

### 5.2 改派

- 服务端更新负责人并递增 task version。
- 旧负责人收到 `TASK_REASSIGNED`：
  - 没有本地变化：删除或标记只读；
  - 有本地变化：保留备份，禁止继续上传；
  - 有租约：服务端撤销租约。
- 新负责人上线后只按需拉取该任务，不广播给其他项目成员。

### 5.3 委派完成后的创建者副本清理

新增 handoff 状态，状态机如下：

```text
handoff_pending
  -> target_materializing
  -> source_cleanup_pending
  -> source_cleanup_conflict
  -> completed
```

触发顺序：

1. 创建者发起委派，服务端更新 `assignee_user_id`、递增 task version，并创建目标
   用户的待交付 assignment。
2. 目标客户端申请租约、执行认领和 materialization，并把完整任务目录上传。
3. 服务端在事务中校验：
   - 目标 Agent 是该 assignment 的唯一 active Agent；
   - 上传文件摘要、task version 与 materialization 结果一致；
   - 索引已追上本次 revision。
4. 成功后写入：

```text
materialized_by_agent_id
materialized_at
materialized_revision
materialized_manifest_sha256
source_cleanup_state = pending
```

5. 服务端只向创建者发送 `task.handoff.materialized` 控制事件；事件不包含任务正文。
6. 创建者客户端只显示单向通知，不进入确认流程：
   - Board 窗口可见：在现有 Sonner toast 区域显示自动消失提示；
   - Board 窗口隐藏或最小化：通过桌面系统通知显示；
   - 不调用 `focus_main_window`、不创建控制窗口、不激活主窗口；
   - 通知事件使用 handoff ID + state 幂等键，重复投递不重复显示；
   - 通知发送失败只记录脱敏日志，不改变 handoff 状态。
7. 创建者本地计算任务目录摘要，并检查：
   - 该任务是否由 Agent 管理；
   - 是否有未提交或未跟踪的用户修改；
   - 是否属于 Git 跟踪文件。
8. 清理规则：

```text
干净 + Agent 管理 + 未跟踪 -> 写轻量备份和审计 -> 自动删除活动副本 -> ACK
有修改 + 未跟踪 -> 移入 live-backup -> 标记 conflict -> 不删除
Git 跟踪 -> 不自动删除，提示用户通过 Git 处理
租约仍有效 -> 先释放租约或拒绝清理
```

自动删除是默认行为，不需要用户逐次确认；备份至少保留任务目录、摘要、来源
taskSpace、materialized revision 和删除时间。

9. 服务端收到 ACK 后把 handoff 标为 completed；若创建者长期离线，状态保持
   `source_cleanup_pending`，Board 显示创建者副本待清理。

注意：目标“已生成目录”本身不能触发删除。只有目标完整上传、服务端校验并索引成功
后才允许进入清理阶段，避免目标崩溃或上传不完整时丢失唯一副本。

通知与清理解耦：通知只是告知创建者，清理仍按本地摘要和 Git 跟踪状态自动执行。
通知不要求用户确认，也不得阻塞清理 ACK。

## 6. 迁移

### 6.1 服务端数据迁移

从现有 `sync_task_index`、`sync_task_space_file` 和 `sync_archive_file` 回填
`sync_task`：

- 按 `execution_task_key` 去重；
- 活动文件与归档文件同时存在时，以归档为最终 state，但保留冲突审计；
- 已有任务文件生成 `materialized`，仅凭服务端元数据生成的任务生成 `pending`；
- 迁移不删除原始表，保留回滚数据。
- 迁移后首次收到本地 Agent 创建的未知任务快照时，按 R3.1 现场登记，不要求事先有
  Board 创建命令。

### 6.2 客户端本地迁移

- 扫描本地活动目录和归档目录。
- 对同 ID 的活动+归档重复副本：
  - 活动文件摘要等于历史服务端快照且无用户修改时，备份后删除活动副本；
  - 内容不同则保留活动副本并标记 `migration_conflict`；
- 不把未认领的用户本地文件自动上传到其他用户任务。

## 7. 兼容与风险

- 旧客户端仍可能尝试拉取完整快照。服务端必须按协议版本返回 `426` 或只返回
  metadata-only 兼容响应，不能继续写全员任务正文。
- 任务创建 API 的返回形状要从“在线命令已入队”扩展为“任务已创建、命令待交付”。
- Git 最终收敛依赖用户成功提交、推送和拉取；Board 不能把未拉取状态显示成实时一致。
- 归档与改派的即时控制信号是尽力送达，Git 归档同步是可恢复的最终事实校验。
- 不使用服务端直接改写业务 Git；离线创建只保存服务端任务记录，不要求目标客户端在线。

## 8. 回滚

1. 关闭新任务创建/离线委派入口，保留 `sync_task` 和审计数据。
2. 服务端恢复只读活动快照接口，但停止向客户端广播完整正文。
3. 客户端停止清理本地副本，保留迁移备份。
4. 回退 schema 前先保留 v16 数据库和同步日志；不能在运行时直接降级数据库。
