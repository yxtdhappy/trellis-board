# 任务同步性能与归档来源设计

## 1. 目标与边界

本次把任务数据拆成两个事实源：

```text
活动任务：
客户端本地文件 -> Agent 快照 -> sync_task_space_file -> 任务索引

归档任务：
Git 分支 HEAD -> 服务端定时只读导入 -> sync_archive_file -> 任务索引
```

核心边界：

- 客户端不再监听、扫描、上传、拉取或解决 archive 冲突。
- 服务端 Agent API 不再返回或接受归档路径。
- 服务端不 checkout 项目工作副本，只维护按 project 隔离的 bare Git 缓存。
- 归档查询继续使用 `sync_task_index.archived=1`，所以浏览器和桌面归档页的 REST/SSE 界面不需要重做。

## 2. 当前事实与设计依据

- 当前 schema 为 v13，任务文件正文在 `sync_task_space_file`，索引在 `sync_task_index`。
- 当前活动与归档没有分表；Agent snapshot、preflight、changes 和 index 都读取同一文件表。
- 当前有效文件快照中约 `98.6%` 是归档文件，把 archive 从客户端移除能直接消除主要扫描面。
- 当前项目远端同时存在 SSH 和 HTTPS，不能假设所有远端都能使用同一类凭据。
- 旧 Team 代码已有 AES-GCM、临时认证文件、隔离 Git 环境和进程输出脱敏实现，可复用安全模式，但不能恢复旧的 Team Git 工作副本、commit/push 或旧 `git_credential` 行为。

## 3. 数据模型

目标 schema 升到 v14。

### 3.1 活动任务

保留：

```text
sync_task_space_file
sync_task_space_batch
sync_agent_cursor
sync_conflict
sync_conflict_backup
sync_file_audit
```

约束新增：

- `sync_task_space_file` 只允许 `.trellis/tasks/<task-dir>/<file>`。
- Agent `changes`、conflict overwrite、snapshot、preflight、directory snapshot 统一拒绝或过滤 archive 路径。
- 活动 `revision` 的语义保持不变，只由 Agent 批次推进。

### 3.2 归档文件

新增 `sync_archive_file`：

```text
task_space_id
relative_path
blob_oid
sha256
content_text
task_id
task_dir
source_head
updated_at
PRIMARY KEY (task_space_id, relative_path)
```

设计：

- 每个 taskSpace 只保存当前分支 HEAD 下的归档快照。
- 不保存归档墓碑；成功导入时在同一事务中对比新旧集合，删除已消失路径。
- `source_head` 记录文件来自哪个 Git commit，便于排查。
- 外键级联到 `sync_task_space`，taskSpace 清理时同步删除。

### 3.3 归档凭据

新增 `sync_archive_git_credential`：

```text
id
name
scheme                 ssh | https
host                   规范化小写主机名
port                   实际端口
auth_type              ssh_key | https_token
username               HTTPS Token 可选用户名
secret_version
secret_iv
secret_tag
secret_ciphertext
public_key_fingerprint
known_hosts_text
created_by_user_id
updated_by_user_id
created_at
updated_at
UNIQUE(scheme, host, port)
```

凭据身份固定为：

```text
ssh://git.weintdata.cn:1022
https://github.com:443
```

规则：

- 不同来源绝不自动复用凭据。
- SSH 项目没有匹配的 `ssh_key` 时失败关闭。
- HTTPS 项目没有匹配凭据时允许匿名读取；配置了 `https_token` 时只对该来源使用。
- `github.com:443` 的 HTTPS Token 与 `github.com:22` 的 SSH 私钥是两个独立 profile。
- 不在页面提供任意 URL 探测；测试接口只接受已保存 profile 的 ID，避免把凭据用于未配置主机。

### 3.4 定时配置与同步状态

新增单行 `sync_archive_sync_config`：

```text
id = 1
enabled
interval_seconds
updated_by_user_id
updated_at
```

新增 `sync_archive_sync_state`：

```text
task_space_id PRIMARY KEY
ref_name
remote_head
status                 idle | syncing | importing | indexing | current | stale | error | index_error
last_attempt_at
last_success_at
last_indexed_at
last_error
file_count
byte_count
updated_at
```

时间语义：

- `last_attempt_at`：本轮 fetch/导入开始时间，失败也会更新。
- `last_success_at`：Git archive 内容成功写入 `sync_archive_file` 的时间。
- `last_indexed_at`：最新 `archive_revision` 成功投影到 `sync_task_index` 和 Board cache 的时间，即页面“最近更新时间”。
- 索引失败时保留 `last_success_at`，但 `last_indexed_at` 不前移，状态为 `index_error`。

新增 `sync_archive_sync_log`：

```text
id
task_space_id
attempt_id
phase                 fetch | import | index
level                 error
error_code
message
detail_json
created_at
```

约束：

- 每个 taskSpace 保留最近 100 条失败日志，插入后同事务清理更老记录。
- 单条展示预算不超过 16 KiB，使用现有 `sanitizeDiagnosticText()` 和结构化脱敏。
- 日志按 `created_at DESC, id DESC` 分页，taskSpace 删除时级联删除。
- 成功日志不写表；成功时间写 `sync_archive_sync_state`，避免正常轮询产生噪声。

### 3.5 双 revision

`sync_task_space` 增加：

```text
archive_revision
archive_indexed_revision
```

`sync_task_space_scan_cache` 增加 `indexed_archive_revision`。

语义：

- `revision/indexed_revision` 只表示活动任务。
- `archive_revision/archive_indexed_revision` 只表示 Git 归档。
- Agent snapshot/cursor 只看活动 revision。
- Board 查询缓存只有在两份 revision 都已投影时才算 current。
- Git 归档发生变化只发布 Board `tasks.changed`，不发布 Agent `task.changed`。

## 4. 客户端设计

### 4.1 路径门禁

在 Rust Agent 中增加唯一判断：

```text
is_archive_task_dir(task_dir)
is_archive_task_path(relative_path)
```

以下路径全部在读取正文之前过滤：

- 全量 local snapshot。
- `task_dirs` 精确扫描。
- watcher 任务目录提取。
- deferred 目录集合。
- dirty/cursor baselines 比较。
- ownership projection 和 HEAD diff。
- pull 服务端文件应用。
- pending 恢复和 conflict review。

`archive` 是 `.trellis/tasks` 的保留目录，扫描根目录时直接跳过，不进入 DFS。

### 4.2 活动任务归档

文件移动前：

```text
.trellis/tasks/11-17-a/
```

文件移动后：

```text
.trellis/tasks/archive/2026-11/11-17-a/
```

新流程：

1. watcher 收到活动目录删除。
2. 目标活动目录不存在。
3. 客户端读取服务端活动目录清单并生成删除墓碑。
4. 批次只提交旧活动路径删除。
5. 服务端活动 revision 前进，活动卡片消失。
6. Git 分支提交并推送后，服务端下一轮归档同步导入新 archive。
7. Board 归档页在下一轮同步后出现任务。

不保证第 5 步和第 7 步原子完成；这是用户已接受的短暂不一致。

### 4.3 旧 pending 迁移

cursor 加载时检查 pending files：

- 纯 archive 文件：丢弃该 pending，不发送。
- 活动删除 + archive 写入：丢弃原 pending ID，只保留活动删除，生成新 `batchId/clientSequence`。
- 直接改写原 batch ID 的文件集合是不允许的，会破坏服务端幂等摘要。
- 迁移结果写入 cursor；无活动删除时不推进服务端 revision。

## 5. 服务端 Agent API

统一增加归档路径拒绝错误：

```text
409 ARCHIVE_SYNC_SERVER_MANAGED
```

应用位置：

- `POST /api/agent/task-spaces/:id/changes`
- conflict `overwrite-server`
- 任何 normalized snapshot group

返回过滤后的数据：

- taskSpace snapshot 只返回活动文件。
- preflight 只比较活动任务。
- directory snapshot 对 archive 目录返回协议错误。
- 归档详情改走服务端内部 archive manifest，不经过 Agent binding。

## 6. 服务端 Git 导入器

### 6.1 Git 缓存

每个 project + branch taskSpace 使用一个 bare 缓存：

```text
<TRELLIS_BOARD_DATA_DIR>/archive-git/<taskSpaceId>.git
```

初始化只允许：

```text
git init --bare
```

不创建普通仓库、worktree、checkout 或项目源码副本。按 taskSpace 隔离可以避免不同分支共用 shallow/promisor 状态。

bare cache 初始化时固定写入：

```text
remote.origin.url = sync_project.remote_url
remote.origin.promisor = true
remote.origin.partialclonefilter = blob:none
extensions.partialClone = origin
```

URL 变化时只允许更新为仍匹配同一 project identity 和同一凭据 origin 的值。

### 6.2 同步单位

定时器查询 active、未 retired 的 taskSpace：

```text
sync_project.status = active
sync_task_space.status = active
sync_task_space.retired_at IS NULL
```

每个 taskSpace 对应一个 branch。对 branch 执行：

```text
git fetch --depth=1 --filter=blob:none --no-tags --force <remote> +refs/heads/<branch>:refs/heads/trellis-archive
git rev-parse refs/heads/trellis-archive
git ls-tree -r -z --long <commit> -- .trellis/tasks/archive
git cat-file --batch
```

约束：

- 所有参数使用 argv 数组，不经过 shell。
- branch 必须通过现有 `validateGitBranchName()`。
- remote 必须来自 `sync_project.remote_url`，地址格式与 project 身份一致。
- 首次和第 N 次 fetch 都保留 shallow + `blob:none`；不得因为缓存已存在而拉取完整分支对象。
- 远端拒绝 partial clone filter 时标记 `git_filter_unsupported` 并停止该 branch，不能静默退化为全分支 blob 下载。
- `core.fsmonitor=false`、`core.hooksPath` 指向空目录、禁止 credential helper、禁止 ext/file protocol。
- HTTPS 强制证书校验。
- SSH 强制 `BatchMode=yes`、`IdentitiesOnly=yes`、`StrictHostKeyChecking=yes`。

### 6.3 文件读取

只接受 regular blob，路径必须通过：

```text
.trellis/tasks/archive/<YYYY-MM>/<task-dir>/<file>
```

继续使用现有任务文件白名单和限制：

- 扩展名：`.json/.jsonl/.md/.txt/.yaml/.yml`
- 单文件最大 1 MiB
- UTF-8 fatal 解码
- BOM/CRLF 规范化
- 使用规范化内容重新计算 SHA-256

非白名单文件、符号链接、异常路径和超大文件不进入正文表；该 branch 标记错误并保留上一次成功快照。首版不导入图片、Office、PDF 等二进制附件。

使用 `git cat-file --batch` 按 blob OID 批量读取。缺少的 archive blob 由 partial-clone promisor 按需从同一远端获取，源码和活动任务 blob 不进入读取集合。

### 6.4 导入事务

先在内存中形成 desired map，再在一个事务中：

1. 删除不再是 Git HEAD 路径的旧 `sync_archive_file` 行。
2. 插入或更新新增/变化行。
3. 更新 `sync_archive_sync_state`。
4. 内容实际变化时递增 `archive_revision`。

完全相同时不写文件表、不递增 revision。

提交后调用：

```text
taskSpaceIndex.enqueue(taskSpaceId, { source: "archive" })
```

索引任务读取活动表和归档表，重建同一 `sync_task_index` 投影；归档-only 投影只通知 Board。
索引服务通过 `onProjectionResult()` 回报结果：

- 成功：更新 `sync_archive_sync_state.last_indexed_at` 和 `status=current`。
- 失败：写 `sync_archive_sync_log(phase=index)`、`status=index_error` 和脱敏 `last_error`，不推进 `archive_indexed_revision`。

## 7. 凭据选择与进程隔离

### 7.1 选择算法

```text
remote = normalize(sync_project.remote_url)
key = remote.scheme + "://" + remote.host + ":" + effectivePort
credential = lookupExact(key)

SSH && no credential           -> credential missing
SSH && ssh_key                 -> decrypt and use
HTTPS && https_token           -> decrypt and use
HTTPS && no credential         -> anonymous
scheme/host/port mismatch      -> never fallback
```

### 7.2 加密

- 凭据使用 AES-256-GCM。
- 随机 12-byte IV，AAD 绑定 credential ID、origin、auth type、secret version。
- 独立 32-byte 主密钥文件：

```text
<data>/archive-git-credentials.key
```

- POSIX 为 `0600`；Windows 继承数据目录 ACL。
- API DTO 不读取 `secret_ciphertext`。
- 更新时未提供 secret 表示保留旧 secret；显式轮换才递增 `secret_version`。

### 7.3 临时认证文件

只在单次 Git 子进程期间创建：

```text
<data>/.archive-git-auth/<random>/
```

- 目录 `0700`，私钥 `0600`。
- `finally` 删除；服务启动时清理崩溃遗留目录。
- 私钥、Token、临时路径加入进程脱敏列表。
- `known_hosts` 按 credential 保存，测试连接时展示主机指纹并要求管理员确认；不接受 `StrictHostKeyChecking=no`。

## 8. 调度、并发与退避

后台服务：

```text
createArchiveGitSyncService({
  db,
  config,
  boardEvents,
  agentEvents,
  taskSpaceIndex,
  logger
})
```

规则：

- 默认周期 300 秒，管理页可调，建议范围 60 秒到 24 小时。
- 使用串行 timeout 调度，不用可重叠的 `setInterval`。
- 全局最多 2 个 branch 并发，每个 taskSpace/bare cache 一把锁；同 project 的不同 branch 也必须使用不同 cache。
- 启动后延迟执行一次；项目/分支新增后可安排一次近时同步。
- 失败退避序列：30s、1m、2m、5m、10m、30m，上限为配置周期。
- fetch/import 失败更新 `sync_archive_sync_state` 并写 `sync_archive_sync_log`；索引失败由投影回调同样写日志。
- 失败不删除旧文件、不推进失败阶段的 revision。
- 服务关闭时 abort 子进程并等待调度器停止。

## 9. 管理页与 API

新增仅 system admin 可见的“归档同步”页面。

API：

```text
GET    /api/admin/archive-sync
PATCH  /api/admin/archive-sync/config
POST   /api/admin/archive-sync/credentials
PATCH  /api/admin/archive-sync/credentials/:id
DELETE /api/admin/archive-sync/credentials/:id
POST   /api/admin/archive-sync/credentials/:id/test
POST   /api/admin/archive-sync/run
GET    /api/admin/archive-sync/task-spaces/:taskSpaceId/logs
```

页面内容：

- 启用开关和同步周期。
- 凭据列表：origin、类型、配置状态、指纹、更新时间。
- 新建/轮换 SSH 私钥或 HTTPS Token。
- SSH 主机指纹确认。
- project + branch 状态、最近更新时间（`last_indexed_at`）、最近尝试时间、最近成功时间、文件数和最后 commit。
- 最近更新时间为本地化时间；从未成功索引时显示“尚未更新”，不能拿“最近尝试时间”冒充更新时间。
- 状态为失败时提供“查看失败日志”入口，弹层按时间倒序分页展示阶段、错误码、摘要和活动时间。
- “立即同步”与失败后的手动重试。

敏感表单只支持写入；读取接口不返回原值。审计只记录 origin、auth type、操作者和结果。
失败日志只通过 system admin API 返回，使用 `sanitizeDiagnosticText()` / `diagnosticError()` 脱敏；日志不得包含私钥、Token、Authorization、Cookie、绝对路径或任务正文。

## 10. 索引与查询

- `sync_task_index` 继续同时存在活动与归档行。
- 活动行来自 `sync_task_space_file`，归档行来自 `sync_archive_file`。
- 索引物化请求携带 `activeRevision` 和 `archiveRevision`。
- 投影事务完成后分别写 `indexed_revision`、`archive_indexed_revision`。
- Board 缓存键包含这两个 revision。
- warm 投影状态（未变化任务事实、目录指纹、project/workspace 成员、详情和人工阶段指纹）与
  Board cache、双 indexed revision 同一事务写入 `sync_task_space_scan_cache.projection_state_json`；
  服务重启后校验版本、结构和 revision 并继续增量投影，状态损坏才回退 full。
- Team 服务启动后在后台预热未停用的 project/taskSpace，预热与正常写入共用 single-flight；预热不阻塞
  HTTP 监听，持久化状态可用时首次活动任务不再等待全量扫描。
- 基线 taskSpace 去重、分页、搜索、负责人、阶段和标签逻辑不变。
- 归档详情 `manifestForDirectory()` 对 archive 路径读取 `sync_archive_file`；活动路径继续读取 `sync_task_space_file`。

## 11. 迁移

v13 -> v14：

1. 使用现有快照备份生成 `board.sqlite.pre-v14.*`。
2. 新建 archive 表、凭据表、状态表、失败日志表和 revision 字段。
3. 将 `sync_task_space_file` 中 `deleted=0` 的 archive 行复制到 `sync_archive_file`，标记为 legacy import。
4. 从 `sync_task_space_file` 删除 archive 行及冲突/pending 中的 archive 条目。
5. 重建 taskSpace 索引和 Board cache。
6. 在首次成功 Git 导入前，旧归档仍可只读展示；首次成功后以 Git 快照替换。
7. 迁移必须幂等，重复启动不会重复复制或改变源数据。

如果迁移前备份失败，服务拒绝继续升级 Team 数据库。

## 12. 失败矩阵

| 条件 | 结果 |
| --- | --- |
| Agent 上传 archive 路径 | `409 ARCHIVE_SYNC_SERVER_MANAGED`，整批不写 |
| Agent snapshot 请求 archive | 不返回该文件；目录请求返回协议错误 |
| SSH 来源没有精确匹配凭据 | branch 状态 `credential_missing`，不连接远端 |
| HTTPS 私有仓库无 Token | 认证错误，旧归档保持可读 |
| Git 凭据跨 host/port 匹配 | 拒绝，绝不回退另一 profile |
| Git 网络超时 | 状态 `error`，进入退避，旧 snapshot 与索引保留 |
| branch 不存在 | 状态 `branch_missing`，不删除旧 snapshot |
| 远端不支持 `filter=blob:none` | 状态 `git_filter_unsupported`，停止导入，不下载完整源码 blob |
| archive 中出现非法路径/超限文件 | 整 branch 导入失败，不提交部分结果 |
| 没有 archive 目录 | 成功导入空集合，清空该 branch 的旧 Git 归档 |
| 归档内容无变化 | 不写文件、不递增 revision |
| 仅 archive revision 变化 | 发布 Board event，不唤醒 Agent |
| 索引未追上 revision | Board cache 继续返回上一份一致结果，并保留 syncing 状态 |
| fetch/import 失败 | `status=error`，写该 taskSpace 的 `phase=fetch|import` 日志，保留旧索引 |
| 索引投影失败 | `status=index_error`，写 `phase=index` 日志，`last_indexed_at` 不前移 |
| 日志超过保留上限 | 只保留该 taskSpace 最近 100 条失败记录 |

## 13. 性能预期与验收

当前服务端活动文件 67 行、归档 4,826 行。客户端过滤 archive 后，常规扫描集从约 4,893 行降到 67 行，理论扫描面下降约 98.6%。

实际性能仍必须按原门槛 E2E：

- 文件写完到活动 revision committed：P95 `<= 2s`
- 看板点击到首次可见：P95 `<= 5s`

服务端 Git 导入不在 HTTP 请求线程中执行，归档同步失败或变慢不能阻塞任务创建。

## 14. 风险与回滚

风险：

- bare Git 缓存带来新的磁盘占用和运维状态，但不需要项目工作副本。
- 第一次导入大型 archive 会产生瞬时 CPU、磁盘和 SQLite WAL 压力；使用并发上限和单 branch 事务控制。
- 凭据按 origin 隔离增加管理页配置数量，但显著降低跨域凭据复用风险。
- SSH 主机密钥确认若省略会破坏信任边界，不能降级为自动接受。
- 归档-only revision 若不与 Agent revision 分开，会让所有客户端做无意义拉取，因此双 revision 是必须设计。

回滚：

- 先停止归档调度。
- 保留 Git 导入数据只读，不影响活动任务恢复为旧路径。
- schema 回退不直接删列；恢复旧代码后以 v13 兼容读取，必要时从 v14 前备份恢复。
- 客户端 archive 过滤若需紧急回退，可恢复 Rust 扫描实现；服务端仍会拒绝新归档上传，避免形成第二写者。
