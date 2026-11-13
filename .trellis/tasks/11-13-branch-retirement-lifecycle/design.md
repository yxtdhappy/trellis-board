# 分支弃用生命周期与安全移除设计

## 1. 目标与边界

本设计在 Team 模式下增加 taskSpace 的弃用生命周期，解决项目分支在历史增长后持续占用项目栏和任务选择器的问题。

- “弃用”是可恢复的软操作：隐藏、只读保留，不删除任务、冲突、审计或快照。
- “移除分支”是不可恢复的硬操作：经过二次确认后删除 taskSpace 及其级联数据。
- 管理操作全部放在服务端管理台的项目页面，桌面客户端不新增管理命令。
- 服务端只删除 Board taskSpace，不删除真实 Git 分支。
- 现有 `disabled` 继续表示技术停用；只有带 `retired_at` 的 taskSpace 才是“已弃用”。

## 2. 数据模型

### 2.1 Schema v12

为 `sync_task_space` 增加三列：

| 字段 | 语义 |
| --- | --- |
| `retired_at TEXT` | 弃用时间；为空表示未弃用 |
| `retired_by_user_id TEXT` | 执行弃用的用户 ID |
| `retired_reason TEXT` | 可选的弃用原因，最长 500 字符 |

新增索引：

```sql
CREATE INDEX IF NOT EXISTS sync_task_space_retired
  ON sync_task_space(project_id, retired_at, status);
```

`status` 仍允许 `active | disabled | indexing | error`。弃用时同时把技术状态设为 `disabled`，并用 `retired_at` 区分“弃用”与普通技术停用：

- `retired_at IS NULL + status=active`：正常。
- `retired_at IS NULL + status=disabled`：历史技术停用，不自动视为已弃用。
- `retired_at IS NOT NULL`：已弃用，生命周期状态为 `retired`。

`sync_task_space` 仍是聚合根。物理移除依赖现有外键级联清理任务文件、binding、cursor、索引、命令、冲突和 `sync_file_audit`；不新增第二套清理表。

### 2.2 迁移

- `DATABASE_SCHEMA_VERSION` 从 `11` 升到 `12`。
- 新增 `ensureV12Schema()`，通过 `PRAGMA table_info(sync_task_space)` 幂等补三列和索引。
- 升级前继续使用现有 `VACUUM INTO` 备份，文件名改为 `board.sqlite.pre-v12.*`。
- 新库直接包含最终列；已有 v11 数据库升级后所有行的 `retired_at` 为空。
- 现有 `disabled` taskSpace 不自动变成 `retired`，管理员需要在管理台明确执行“弃用”或“移除分支”。

## 3. 服务契约

在 `createTaskSpaceService()` 增加以下方法：

```text
listAdminTaskSpaces(actor, projectId)
retireTaskSpace(actor, projectId, taskSpaceId, { reason })
restoreTaskSpace(actor, projectId, taskSpaceId)
purgeTaskSpace(actor, projectId, taskSpaceId, { confirmation })
```

公共权限为项目 `lead`、项目所属团队管理员或系统管理员，复用现有 `canManage` 判定。权限校验必须在读取或写入前完成。

### 3.1 弃用

在事务中：

1. 校验项目、taskSpace 归属和管理权限。
2. 已弃用时直接返回幂等结果。
3. 设置 `retired_at`、`retired_by_user_id`、`retired_reason`，技术状态改为 `disabled`。
4. 将全部 binding 的 `is_listening` 设为 0。
5. 取消该 taskSpace 的 `pending/delivered/running` 命令。
6. 保留 binding、cursor、任务、冲突和审计，支持恢复。

返回分支摘要、受影响 binding 数和弃用时间。

### 3.2 恢复

仅允许操作带 `retired_at` 的 taskSpace。事务中清除弃用元数据并把技术状态恢复为 `active`；不主动设置任何 binding 的 `is_listening=1`，也不自动恢复客户端 watcher。恢复写一条审计，分支会重新进入普通视图。

### 3.3 移除分支

允许从 `active`、`disabled` 或 `retired` 状态执行，不要求先弃用，也不要求所有客户端解绑。

调用方必须提交与当前分支名完全一致的 `confirmation`，例如：

```json
{ "confirmation": "codex/temp-feature" }
```

服务端在删除前收集摘要：

- 分支名、taskSpace ID、当前生命周期状态
- 活动任务数、归档任务数、未归档任务数和文件数
- approved binding、在线监听和受影响 Agent
- 待处理冲突数和进行中命令数

清除流程：

1. 先调用强制数据库快照备份；备份失败立即中止，不进入删除事务。
2. 在 `withTransaction()` 中再次加载并校验 taskSpace 状态、项目和权限。
3. 写 `task_space_purged` 审计，保留全局审计事件。
4. 删除 `sync_task_space` 行，依赖外键级联删除任务文件、binding、cursor、索引、命令、冲突、冲突备份和文件审计。
5. 提交后刷新查询 revision 并广播 Board 变更。

删除不触碰 `sync_project`、其他 taskSpace、项目成员、团队权限或 Git 仓库。备份文件名可用于审计；不把完整本地数据目录写入用户界面。

### 3.4 列表与可见性

- `listReadable()` 只返回 `retired_at IS NULL` 且技术状态可用的 taskSpace。
- `listStatusReadable()` 保留历史 `disabled` 以维持现状，但排除 `retired_at IS NOT NULL`。
- `listAll()` 继续只服务团队管理视角，并返回所有 taskSpace，包括已弃用分支。
- `listTaskSpaces(projectId, actor)` 返回项目内全部 taskSpace，供管理台使用；普通项目成员无管理权限。
- `taskSpacePublic()` 增加 `retiredAt`、`retiredByUserId`、`retiredReason` 和派生 `lifecycleStatus`；普通列表不会出现 retired 项。
- `resolve()`、`preflight()`、`attach()`、任务查询和 taskSpace 授权均拒绝 retired taskSpace。

## 4. HTTP 与管理台

### 4.1 API

新增项目级路由，避免管理台依赖系统管理员项目列表：

```text
GET    /api/projects/:projectId/task-spaces
POST   /api/projects/:projectId/task-spaces/:taskSpaceId/retire
POST   /api/projects/:projectId/task-spaces/:taskSpaceId/restore
DELETE /api/projects/:projectId/task-spaces/:taskSpaceId
```

- GET 仅返回当前项目内且当前用户有管理权限的 taskSpace 摘要。
- retire 请求体为 `{ reason? }`。
- restore 请求体为空。
- DELETE 请求体必须包含 `confirmation`，且等于分支名。
- 路由成功后调用 `taskSpaceIndex.incrementQueryRevision()` 和 `boardEvents.publish()`。

### 4.2 前端数据流

`apps/web/src/api/admin.ts` 增加 taskSpace 摘要类型和四个 API 函数；`useAdminProjects.ts` 在选择项目时并行加载 members、bindings、team-access、audit 和 task-spaces。

`ProjectsTab.tsx` 增加“分支管理”面板：

- 活跃、技术停用、已弃用分组展示。
- 每行显示分支名、任务数、文件数、监听数、最后活动时间和当前状态。
- 活跃分支提供“弃用”和“移除分支”。
- 已弃用分支提供“恢复”和“移除分支”。
- 移除分支打开专用确认弹层，第一步展示影响摘要，第二步要求最终确认；提交中禁用操作，失败保留弹层并显示服务端原因。

管理台仍是唯一操作入口；Board 项目栏、创建任务和改派选择器只消费服务端过滤后的可见分支。

## 5. 客户端同步状态传播

不新增 Tauri 管理命令。服务端通过现有 Agent heartbeat 传递生命周期变化：

- taskSpace 被弃用后返回 `status=disabled` 和 `TASK_SPACE_RETIRED`，客户端合并 binding 后移除 active watcher。
- taskSpace 被物理移除后 heartbeat 返回 `BINDING_UNKNOWN`，现有客户端逻辑停止该 binding 的同步并显示关联失效。
- 恢复后不主动设置监听；客户端下一次心跳可以重新上报，新的监听状态仍由现有五态模型计算。

## 6. 安全与并发

- 所有管理写操作在服务端鉴权，前端隐藏按钮不能代替权限校验。
- 弃用和移除都必须按 `projectId + taskSpaceId` 双重校验，防止跨项目删除。
- `confirmation` 必须精确匹配分支名；接口不能只依赖前端 `window.confirm`。
- 清除前使用严格备份接口；备份失败不删除。
- 删除事务内再次校验 taskSpace，避免预览后状态漂移。
- 同一任务空间的并发弃用、恢复和清除以 SQLite `BEGIN IMMEDIATE` 串行化。
- 审计事件不依赖 taskSpace 外键，因此 taskSpace 被删除后仍能在项目审计中查询。

## 7. 兼容、回滚与限制

- v12 数据库需要升级后的服务端；回滚时必须恢复自动生成的 `pre-v12` 备份。
- 现有 `disabled` 历史分支不自动隐藏；管理员可先选择弃用或直接移除。
- 不使用前端本地状态模拟删除；所有列表刷新都以服务端为准。
- 不删除真实 Git 分支，也不清理客户端本地 `.trellis/tasks` 目录。
- 删除会级联清除 `sync_file_audit` 和冲突备份；全局 `audit_event` 与操作前数据库快照保留。

## 8. 验证策略

- 数据库：新库 v12、v11 升级、重复迁移、旧 `disabled` 保留、pre-v12 备份。
- 服务：权限、幂等弃用/恢复、直接移除、活动/停用/已弃用三种入口、级联计数、备份失败不删除、跨项目拒绝。
- HTTP：项目负责人可访问自己的项目；普通成员 403；确认字符串不匹配 400；删除后项目和审计可读。
- 可见性：普通 `/api/team/status` 和任务选择器不返回 retired；管理台项目列表可读 retired。
- Agent：弃用后 heartbeat 返回 disabled；物理移除后返回 BINDING_UNKNOWN；恢复不会主动设置 listening。
- UI：管理台分组、二次确认、错误保留、刷新后状态一致；真实浏览器和桌面客户端各验收一次。
