# 服务端无 Git 实时任务同步设计

## 1. 目标与结论

Team Board 的服务端只做三件事：

1. 接收并持久化客户端上报的 `.trellis/tasks/**` 快照；
2. 基于该快照扫描任务、维护索引并广播 revision；
3. 在 Web 端创建或改派任务时，把命令投递给目标用户唯一在线 Agent。

项目 Git 的 clone、fetch、commit、push、凭据、工具链批准、项目工作副本和服务端定时 Git
刷新全部退出 Team Board 运行链路。客户端自身继续使用 Git，服务端不读取客户端本地路径，
也不验证远端对象是否存在。

本次是破坏式协议和运行时替换，不保留双模式：

- Team 模式不兼容旧项目、旧实时覆盖层、旧 Agent 协议或旧 Git 操作；
- 单独模式继续使用本机仓库、`task.py` 和现有扫描行为；
- 数据库使用新增表保存新模式，旧表和历史文件不自动删除，只停止读写；
- 旧 `data/projects/**`、`git-credentials.key` 和数据库旧表保留为人工回滚材料。

## 2. 当前实现与根因

当前 Team Board 的实时内容不是单一权威来源：

- Agent 上报 `.trellis/.developer`、`.trellis/tasks/**` 和 `.trellis/workspace/**`
  （[agent/live-sync.js](../../../../agent/live-sync.js:74)）；
- 服务端同时维护项目 Git 稀疏克隆和实时覆盖层；
- 服务端定时 fetch/fast-forward 后重新扫描
  （[server/team/http.js](../../../../server/team/http.js:1750)）；
- 实时覆盖层与 Git 扫描结果合并时，同路径比较不能天然表达目录移动
  （[server/team/live-sync.js](../../../../server/team/live-sync.js:766)）；
- Web 创建和改派任务直接在服务端 Git 工作副本执行 `task.py`、commit 和 push
  （[server/team/task-writes.js](../../../../server/team/task-writes.js:883)）。

因此旧实现存在两个事实源和两个推进时钟。任务已从活动目录移动到归档目录，但 Git 基线仍在
旧路径时，实时拉取可以把旧路径重新物化。新设计不再“合并 Git 和实时层”，而是直接把服务端
任务快照作为唯一投影输入。

## 3. 总体架构

```text
本地 Git 仓库 A                         服务端 SQLite                         本地 Git 仓库 B
  Agent sidecar                         sync_project                         Agent sidecar
  watcher .trellis/tasks  --CAS batch-->  sync_task_space                    <--revision--
                                         sync_task_space_file
                                               |
                                               v
                                      tasks-only scan worker
                                               |
                                               v
                                      sync_task_index -> SSE

Board Web --create/assign command--> sync_task_command --> 唯一在线目标 Agent
                                                    |
                                                    v
                                       目标 Agent 本地执行 task.py / 改 task.json
                                                    |
                                                    v
                                              同一 CAS 同步链
```

项目 Git 只在客户端之间传递源码、`.trellis/scripts`、`.trellis/spec`、`.trellis/config.yaml`、
`.trellis/workflow.md`、`.trellis/agents`、workspace 和 Agent 工具目录。任务实时内容由
Team Board 传递。

## 4. 身份模型

### 4.1 Git 项目

Git 项目身份是规范化后的 Git 远端：

- HTTPS 去掉 userinfo、默认端口、末尾 `/` 和 `.git`；
- SSH/scp 写法统一为同一主机、端口和仓库路径；
- 主机名小写；
- 默认端口 `443`/`22` 不进入身份；
- 本地路径远端由 `TRELLIS_BOARD_ALLOW_LOCAL_GIT_REMOTES` 控制；standalone 默认开启，
  team 默认关闭，team 需要时显式开启。

规范化函数放在共享纯模块中，客户端和服务端使用同一实现。服务端不运行 `git ls-remote`，
因此它以认证 Agent 自报的 origin 为项目身份输入。Agent 必须先验证：

- 所选目录就是 `git rev-parse --show-toplevel` 返回的仓库根；
- origin 存在且能规范化；
- 当前分支存在且能通过 Git 引用格式校验。

服务端再次做字符串和格式校验，避免恶意输入进入唯一键。此模式信任已认证客户端报告的远端
身份，不证明该远端当时可访问；该限制会写入操作诊断和审计。

### 4.2 任务空间

任务空间身份是全局唯一的：

```text
taskSpace = canonicalRemoteIdentity + branchName
```

团队不进入任务空间主键。团队和成员只控制可见性、读写角色和命令投递。

同一 Git 远端的不同分支是同一项目下的不同任务空间：

- task、revision、游标、监听器、pending batch、命令和索引互相隔离；
- 一个分支删除任务不能删除另一个分支的任务；
- 任务编辑身份不能只使用相对路径，必须包含 taskSpace ID。

Board 的项目筛选仍按 Git 项目；分支作为项目下的独立任务空间展示。任务卡和详情必须显示分支。
Team 模式的任务列表必须选择具体 taskSpace；“全部项目”只显示项目/分支摘要和计数，不跨分支
聚合任务卡。这样 Board 的主查询本身也不会混合两个分支的 revision。

### 4.3 团队与成员

- 首次创建 Git 项目时，接入用户选择一个所属团队作为 owner team；
- owner team 的 active 成员默认可读；
- 其他团队不能读取项目内容，只能看到“项目已存在，需要访问授权”；
- owner team 管理员或项目负责人可以邀请其他团队；
- 邀请后仍只有一个全局项目和一份任务快照，不复制项目；
- 项目成员表保存 `lead|member|read_only` 和 Trellis developer ID；
- team admin 可管理项目访问，但只有映射了 Trellis developer ID 的 lead/member 可以写任务。

### 4.4 单账号单 Agent

新增服务端活动槽：

```text
sync_active_agent(user_id PRIMARY KEY, agent_id UNIQUE, updated_at)
```

同一账号只有 `sync_active_agent.agent_id` 指向的设备可以通过 Agent 鉴权。注册新设备时在同一事务
内完成：

1. 找到该账号旧活动 Agent；
2. 撤销旧设备及旧任务空间 binding；
3. 取消旧 Agent 的 pending/delivered/running 命令；
4. 写入新设备并原子替换活动槽；
5. 向旧 Agent 发布撤销事件并关闭 SSE；
6. 写审计。

同一安装使用仍有效的本地凭证重复登录时复用原 Agent；只有换设备、强制新建设备或凭证失效
才替换活动槽。账号级项目权限保留，旧设备的本地仓库绝对路径和 binding 不复用。新设备必须
手动重新选择本地仓库。

## 5. 数据模型

`DATABASE_SCHEMA_VERSION` 升到 `10`。新模式只使用 `sync_*` 表和已有账号、团队、审计、执行扩展
表。旧 `team_project`、`project_live_*`、`git_operation`、`git_credential` 等表不迁移、不清空、
不读写。

### 5.1 项目与访问

`sync_project`

| 字段 | 含义 |
| --- | --- |
| `id` | 全局项目 ID |
| `name` | 展示名称 |
| `remote_url` | 规范化后的远端展示值 |
| `remote_identity_hash` | 全局唯一远端身份 |
| `owner_team_id` | 首次接入团队 |
| `status` | `active/disabled` |
| `created_by_user_id` / `created_by_agent_id` | 接入来源 |
| `created_at` / `updated_at` | 时间 |

约束：`remote_identity_hash` 全局唯一。

`sync_project_team_access(project_id, team_id, access_role, created_by_user_id, created_at)`

- `access_role` 为 `owner|member`；
- owner team 自动写一行；
- member team 表示被邀请团队；
- 同项目同团队只允许一行。

`sync_project_member(project_id, user_id, role, trellis_dev_id, ...)`

- 沿用现有 `lead/member/read_only` 语义；
- `trellis_dev_id` 在项目内唯一；
- 团队邀请解决“可读”，项目成员映射解决“可写和负责人身份”。

### 5.2 任务空间

`sync_task_space`

| 字段 | 含义 |
| --- | --- |
| `id` | 全局任务空间 ID |
| `project_id` | Git 项目 ID |
| `branch_name` | 共享分支 |
| `status` | `active/disabled/indexing/error` |
| `revision` | 已提交快照 revision |
| `indexed_revision` | 已成功投影 revision |
| `last_error` | 最近投影或同步错误摘要 |
| `created_by_user_id` / `created_by_agent_id` | 首次接入来源 |
| `created_at` / `updated_at` | 时间 |

约束：`UNIQUE(project_id, branch_name)`。

`sync_task_space_file`

| 字段 | 含义 |
| --- | --- |
| `task_space_id` | 任务空间 |
| `relative_path` | `.trellis/tasks/**` 相对路径 |
| `revision` | 当前内容写入 revision |
| `sha256` | LF 规范化后的内容摘要 |
| `content_text` | 当前文本；删除后为 `NULL` |
| `deleted` | 删除墓碑 |
| `task_id` | `task.json.id`，无法解析时为 `NULL` |
| `task_dir` | 文件所属完整任务目录 |
| `source_agent_id` / `source_user_id` | 最后修改来源 |
| `source_client_sequence` | 来源设备序号 |
| `updated_at` | 修改时间 |

主键：`(task_space_id, relative_path)`。删除保留墓碑，用于增量拉取和确定删除来源。

`sync_task_space_batch(task_space_id, agent_id, batch_id, user_id, revision, request_sha256,
client_sequence, created_at)`

- `batch_id` 在 `(agent_id, task_space_id)` 内幂等；
- 相同批次重放返回原 revision；
- 相同 batch ID 不同请求摘要返回 `IDEMPOTENCY_CONFLICT`。

`sync_agent_binding`

- 绑定 `agent_id + task_space_id`；
- 保存 `local_repo_key`、本地显示名和固定分支；
- 状态为 `pending/approved/rejected/revoked`；
- 不保存本地绝对路径。

`sync_agent_cursor(agent_id, task_space_id, revision, updated_at)`。

### 5.3 索引、命令和冲突

`sync_task_index`

- 主键：`(task_space_id, task_key)`；
- `project_id` 用于项目筛选；
- 保存 `branch_name`、`execution_task_key`、`task_id`、路径和现有列表字段；
- `UNIQUE(task_space_id, execution_task_key)`；
- 同 taskSpace 内重复 `task.json.id` 标记身份冲突，不进入可写任务。

`sync_task_index_tag` 与 `sync_task_space_scan_cache` 分别保存标签和任务空间级 Board 缓存。

`sync_task_command`

| 字段 | 含义 |
| --- | --- |
| `id` | 独立操作项 ID |
| `task_space_id` / `project_id` | 目标任务空间 |
| `agent_id` / `binding_id` | 唯一目标 Agent 和本地绑定 |
| `command_type` | `create_task/assign_task/sync_branch/refresh_status` |
| `idempotency_key` / `request_hash` | Web 操作幂等 |
| `payload_json` | 受限命令载荷 |
| `status` | `pending/delivered/running/succeeded/failed/cancelled` |
| `attempts` / `lease_expires_at` | 投递租约 |
| `result_json` / `error_text` | 用户结果 |
| `created_by_user_id` | Web 操作人 |
| `created_at/updated_at` | 时间 |

创建或改派失败重试复用同一命令 ID 和幂等键。取消只终止尚未成功的命令。

`sync_conflict`

- 保存任务空间、task ID、冲突文件摘要、当前 revision、服务端来源、客户端基线和 conflict ID；
- 不保存用户敏感凭据；
- 同一 pending batch 再次冲突时复用或刷新 conflict ID，不创建正式任务。

`sync_conflict_backup`

- 仅在用户选择“用我的版本覆盖”时保存覆盖前服务端内容和新内容；
- 保存来源用户、设备、时间、revision 和审计 ID；
- 普通拒绝写入不保存第二份正文。

`sync_file_audit` 是 append-only 文件变更审计：

```text
task_space_id, relative_path, task_id, operation,
old_sha256, new_sha256, revision, source_user_id,
source_agent_id, occurred_at
```

不保存每个历史版本的完整正文；历史版本由客户端 Git 管理。

## 6. 客户端项目接入

### 6.1 本地预检

入口从“按服务端项目点关联”改为项目栏中的“接入本地项目”。流程：

1. 用户选择目录；
2. Agent 验证仓库根、origin 和当前分支；
3. 读取是否存在 `.trellis`；
4. 返回仓库名、规范化远端、分支、当前 HEAD、是否存在 `.trellis` 和检测到的 Agent 工具；
5. 用户在此时选择团队和 Trellis developer ID。

目录选择取消只结束 loading，不产生 binding、server project、游标或本地配置。

### 6.2 缺少 `.trellis`

客户端必须内置固定版本的 Trellis 运行环境，不依赖用户系统 PATH，也不调用服务端初始化：

```text
<install>/trellis-runtime/node.exe
<install>/trellis-runtime/node_modules/@mindfoldhq/trellis/bin/trellis.js
```

执行：

```text
node.exe trellis.js init -y --skip-existing -u <developerId> <selected flags>
```

Agent 工具 ID 和 flags 复用 `shared/trellis-agent-tools.js`。初始化成功后：

- 提醒用户检查生成文件；
- 明确提示“提交并推送后才能建立团队任务空间”；
- 不自动 commit、push、切换分支或改写历史。

已经存在 `.trellis` 时跳过基础初始化。用户后续可对同一仓库再次选择缺失 Agent 工具，执行同一
固定 CLI 的 `--skip-existing` 初始化；该选择只属于当前客户端，不上报服务端。

### 6.3 首次推送确认

只有新执行初始化的仓库需要推送门禁。状态机：

```text
needs_init
  -> initializing
  -> waiting_commit
  -> waiting_push
  -> unable_to_verify（网络不可达）
  -> ready
```

检查顺序：

1. `git rev-parse HEAD` 读取本地 HEAD；
2. `git ls-tree -r --name-only HEAD -- .trellis` 确认 `.trellis` 初始化文件已进入 HEAD；
3. `git status --porcelain=v1 --untracked-files=all -- <初始化路径>` 确认共享初始化路径干净；
4. `git ls-remote origin refs/heads/<branch>` 读取远端分支 SHA；
5. SHA 一致才进入 `ready`；
6. SHA 不一致时 fetch 目标分支并用 `rev-list --left-right --count HEAD...FETCH_HEAD`
   区分本地领先、远端领先和分叉；
7. 远端不可达只显示“无法确认是否已推送”，不得显示“未推送”。

Agent Git 白名单新增只读操作：

- `ls-remote`；
- `ls-tree`；
- 复用到 `rev-parse`、`status`、`fetch`、`rev-list`。

`push`、`checkout`、`switch`、`reset`、`stash`、`clean` 继续禁止。

### 6.4 解析和接入

`resolve` 是只读操作：

- 项目不存在：返回 `canCreate=true`，要求选择 owner team；
- 项目存在且当前账号可访问：返回项目和已有任务空间；
- 项目存在但团队无权限：返回 `ACCESS_REQUIRED`，不返回任务内容；
- 项目存在、团队已授权、分支不存在：允许创建新任务空间。

`attach` 才创建项目、任务空间、成员和 Agent binding。创建项目与 owner team、首位 lead、
任务空间在同一事务完成；并发相同远端必须命中同一全局项目。

换设备后重新选择目录，命中既有项目和任务空间，不重新创建。若本地仓库已由同一 Agent 绑定
其他分支，新增该分支 binding；不删除原分支 binding。

## 7. Tasks-only 快照协议

### 7.1 路径和内容边界

只接受：

```text
.trellis/tasks/<task-dir>/<file>
.trellis/tasks/archive/<YYYY-MM>/<task-dir>/<file>
```

拒绝：

- 绝对路径、盘符、反斜杠未规范化、NUL、`.`/`..`；
- 符号链接；
- `.trellis/spec/**`、`.trellis/scripts/**`、`.trellis/config.yaml`、
  `.trellis/workflow.md`、`.trellis/agents/**`、`.trellis/workspace/**`、
  `.trellis/.developer`；
- `.codex`、`.opencode`、`.pi`、`.cursor`、`.claude` 等 Agent 工具目录；
- 非 UTF-8、非白名单文本扩展名；
- 单文件超过 1 MiB、单批超过 8 MiB 或超过 64 个文件。

文本在客户端和服务端都使用现有 LF 规范化规则，完整性先校验客户端原始字节摘要，再以 LF 文本
计算存储摘要。

### 7.2 任务原子单位

同步单位是“完整任务目录”，不是单文件。一个请求中的文件必须属于同一任务目录，或者是同一
task ID 的一次活动目录到归档目录移动。

服务端校验：

- 所有路径都位于同一 taskSpace；
- 文件集合加入后能由合法 `task.json` 形成完整任务；
- `task.json.id` 稳定且未与其他路径冲突；
- 删除只能删除目录中的已知文件；
- 移动必须在一个事务中完成旧路径删除和新路径写入。

客户端本地应用远端 revision 时也按完整任务目录处理：先将结果写进同卷临时目录，再以目录级
替换提交。失败时恢复原目录，不能留下半个任务。

### 7.3 文件级 CAS

每个 `upsert` 或 `delete` 携带 `baseSha256`：

- `null` 表示客户端认为该路径不存在；
- 64 位摘要表示客户端基于的服务端当前内容；
- 服务端在同一 `BEGIN IMMEDIATE` 事务中逐文件比较当前摘要；
- 任一文件不一致，整批拒绝；
- 全部一致才写入全部文件、增加一个 taskSpace revision、写 `sync_file_audit` 并调度投影。

规则：

- 创建任务：新目录所有文件 `baseSha256=null`；
- 修改任务：只提交实际变化文件，每个文件带本地已知服务端摘要；
- 删除任务：删除该目录全部非墓碑文件，每个带当前摘要；
- 归档移动：旧目录文件 `delete`，新目录文件 `upsert`，同 batch、同 task ID；
- 内容与当前摘要相同是无操作，不增加 revision；
- 同一 batch ID 重放返回原 revision；
- 同一 batch ID 不同内容返回 `IDEMPOTENCY_CONFLICT`。

服务端不会用“后到覆盖先到”解决同文件冲突。

### 7.4 revision 与 cursor

- 每个成功且有变化的 batch 只增加 taskSpace revision 一次；
- `sync_task_space_file.revision` 是该文件最后变化 revision；
- 删除墓碑也进入增量结果；
- 首次接入使用 `afterRevision=0` 获取完整快照；
- 已绑定客户端重启使用持久化 cursor 增量拉取；
- 只有本地完整应用并推进本地 cursor 后，才上报 server cursor；
- SSE 断线、页面 focus、Agent 事件流重连都从持久化 cursor 补拉。

### 7.5 首次接入预检

接入前先调用 `POST /api/agent/task-spaces/preflight`。该接口只依赖认证 Agent 和团队访问权限，
读取项目、taskSpace、revision 及文件元数据，不建立 project/taskSpace/binding/cursor，也不返回
任务正文。客户端再扫描本地 `.trellis/tasks/**`：

```text
{
  taskId, relativeTaskDir, files: [{ path, sha256 }],
  complete, invalidReason
}
```

按 task ID 分类：

- `same`：同一路径、同一文件集合和摘要；
- `local-only`：仅本地有完整任务；
- `server-only`：仅服务端有完整任务；
- `content-conflict`：同一 task ID 两边都有但任一路径内容不同；
- `move-delete-conflict`：一边移动或修改，另一边删除；
- `invalid`：缺少/损坏 `task.json`、重复 task ID 或目录不完整。

三个入口：

1. **暂不接入**：不写本地、不建 binding、不写 cursor、不上传。
2. **仅同步无冲突项**：用户明确选择后才 attach；只下载 `server-only` 和安全 `same` 项；
   跳过本地独有、内容冲突、移动删除争议；不上传本地内容。
3. **查看并处理差异**：按完整任务目录展示，可选择下载服务端任务、导入本地任务、处理冲突或
   保存本地副本，最后一次性应用选择。

服务端新项目或新分支快照为空时返回 `new`/`branch_new`。用户确认后使用内部 `bootstrap` 模式，
`local-only` 作为正常首次上传；若预检到 attach 之间已有其他客户端写入，则转为差异审查。
新 binding 持久化 `initialSyncMode=bootstrap|safe|review` 与 `initialSyncCompleted=false`；
双方一致时直接完成，不显示空审查窗口。完成后才启动 watcher。

## 8. 冲突处理

CAS 失败返回：

```json
{
  "code": "TASK_FILE_CONFLICT",
  "conflictId": "conflict-id",
  "message": "任务「xxx」的 task.json 已被其他成员修改",
  "details": {
    "taskId": "task-id",
    "taskTitle": "可读任务名",
    "files": [
      {
        "path": ".trellis/tasks/.../task.json",
        "baseSha256": "...",
        "currentSha256": "...",
        "revision": 42,
        "changedBy": {
          "displayName": "张三",
          "deviceName": "DESKTOP-A",
          "occurredAt": "2026-11-11T..."
        }
      }
    ],
    "suggestion": "先查看差异，再选择保留服务端版本或用本地版本覆盖"
  }
}
```

主提示只展示任务名、文件名、人员、设备和时间。摘要、revision 和错误码放在“技术详情”。

四个动作：

- **查看差异**：客户端读取本地和服务端完整任务目录，按文件展示 unified diff。
- **使用服务端版本**：先备份本地完整任务目录，再用服务端目录原子替换，不写服务端。
- **用我的版本覆盖**：二次确认后提交 `conflictId + currentSha256 + 本地文件`。服务端重新核对
  当前摘要；仍一致时备份服务端旧内容和新内容，写入新 revision 并审计；已变化则生成新冲突。
- **仅保存本地副本**：把本地完整任务目录复制到客户端冲突备份目录，保留原冲突，不偷偷上传或
  删除。

第一版不自动 merge Markdown、JSON 或 JSONL。

## 9. 服务端任务投影

### 9.1 快照物化

Worker 不再复制 Git `.trellis` 基线，也不执行 Git 收敛。每次投影：

1. 在系统临时目录创建空根目录；
2. 从 `sync_task_space_file` 读取该 revision 的非删除文件；
3. 只写 `.trellis/tasks/**`；
4. 以 taskSpace 元数据调用 `scanRepository()`；
5. 生成 Board 后原子替换 `sync_task_index` 和 taskSpace cache；
6. 更新 `indexed_revision`，再发布 `tasks.changed`。

同 taskSpace 最多一个物化请求在途。期间新 revision 合并为下一轮；旧 revision 结果不能覆盖新
revision。投影失败保留上一份一致 Board、已提交 revision 和错误摘要，按 1/2/4 秒，最大 30 秒
退避重试。

### 9.2 loader 解耦

`scanRepository()` 增加可选扫描上下文：

- `workspaceSummaryResolver`：回退到本地文件扫描；
- `members`：由 `sync_project_member.trellis_dev_id` 提供；
- `repositoryMetadata`：直接提供 taskSpace 的 branch/head 信息，不执行 Git；
- `rootPath` 或等价入口：扫描快照临时根，不要求 `project.path` 是真实仓库。

Team 快照扫描传入：

```text
workspace.available = false
workspace.evidence = "workspace 由客户端 Git 管理，服务端不判定会话记录"
members = project_member trellis_dev_id
developer = null
branch = task_space.branch_name
```

`journal` 仍可作为最后一个只读阶段显示“服务端不判定”，不阻塞前面的阶段推导。服务端扫描不读取
`.trellis/scripts`、`.trellis/spec`、config、workflow 或 workspace 内容。

### 9.3 taskSpace 隔离

- `taskKey`、`executionTaskKey` 必须包含 taskSpace ID；
- `task.json.id` 作为稳定任务身份，路径移动不换 execution identity；
- 同一 taskSpace 重复 `task.json.id` 是身份冲突；
- 不同 taskSpace 可使用相同 `task.json.id` 和相对路径；
- 手工阶段、计划字段、依赖、事件、assignment 和归档查询都按 taskSpace 解析；
- `/api/tasks/query`、详情、写入和命令都必须显式携带或能从索引唯一解析 taskSpace；
- 项目删除/停用必须枚举其 taskSpace 清理派生数据。

## 10. Web 创建与改派任务

### 10.1 在线 Agent 约束

Web 创建带负责人任务或改派任务时，服务端查找：

```text
sync_active_agent
  -> agent_device active
  -> target user
  -> sync_agent_binding approved
  -> target taskSpace
  -> last_seen_at 在 stale 窗口内
```

只有唯一结果才入队。以下情况在创建操作项前拒绝：

- 目标用户没有有效 Agent；
- Agent 离线；
- 未关联目标任务空间；
- binding 为 rejected/revoked；
- 目标用户没有项目写角色或 Trellis developer 映射；
- 项目或任务空间已停用。

错误必须指出目标用户、项目、分支和下一步，例如：

```text
李四当前没有在线 Agent，无法接收分支 feature/a 的创建命令。
请让李四打开客户端并关联该项目后重试。
```

### 10.2 命令生命周期

```text
pending -> delivered -> running -> succeeded
                         |-> failed -> pending（同一幂等键重试）
             |-> cancelled
```

- Web 请求成功后返回 `202 + operation`，不写任务文件，不创建临时任务卡；
- Board 单独显示“创建中/改派中”操作项；
- Agent 通过 SSE 收到命令并租约领取；
- 创建失败前正式任务不出现；
- 改派失败前任务继续显示原负责人并标记“改派中”；
- 命令成功后，Agent 必须先通过同一 CAS 链上传任务，服务端索引读到目标 task ID 后才把命令置为
  succeeded；
- 超时重投复用同一命令和幂等键，不能创建第二个任务。

### 10.3 客户端执行

`create_task`：

1. 校验仓库根、origin、分支和 taskSpace binding；
2. 检查没有 merge/rebase/cherry-pick/revert 等中断 Git 状态；
3. 记录命令前 `git status --porcelain=v1 -z --untracked-files=all`；
4. 如果该 slug/task ID 已由上次未完成命令创建，直接复用，不重复调用 `task.py`；
5. 调用项目自己的 `.trellis/scripts/task.py create ... --no-start`；
6. 比较执行前后 Git 状态，除新任务目录外不得产生新变化；
7. 通过 tasks-only CAS 上传完整新任务目录；
8. 返回包含 task ID、相对目录和 revision 的结果。

`assign_task`：

1. 解析目标 task ID 和当前路径；
2. 验证目标 `task.json` 的本地摘要等于命令基线；
3. 只修改 `task.json.assignee`，临时文件加 rename；
4. 比较执行前后 Git 状态，只允许目标 `task.json` 变化；
5. 以该文件当前服务端摘要做 CAS 上传；
6. 服务端索引成功后命令完成。

无关源码或其他任务允许 dirty。创建只保护新任务目录，改派只保护目标任务目录。不得自动执行
全仓 merge、reset、stash、checkout 或 push。

## 11. Agent 协议和 SSE

`AGENT_PROTOCOL_VERSION` 升到 `3`，旧版本返回 `426`。

新增命令：

```text
create_task
assign_task
sync_branch
refresh_status
```

命令 payload 只允许显式白名单字段。前端不能传本地路径、shell 参数、Git 命令或额外环境变量。

事件：

- Agent SSE：`command.available`、`agent.revoked`、`task.changed`、`cursor.invalidated`；
- Board SSE：继续使用轻量 `tasks.changed`，只触发 REST 快照对齐；
- 事件不携带任务正文或文件内容；
- 新设备替换活动槽后，旧 Agent 的 SSE 立即关闭；
- taskSpaceId 变化、命令状态变化、投影成功都会触发前端重新查询，不靠 750ms revision 轮询。

同步期间客户端项目栏显示：

```text
正在同步任务，此时切换分支可能导致任务错位或污染，建议等待同步完成。
```

本次不拦截菜单/终端/IDE 的分支切换，也不自动迁移 pending batch 或修复切换后的污染。

## 12. HTTP 契约

### 12.1 Agent

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `POST` | `/api/agent/task-spaces/preflight` | 未建立 binding 前只读读取任务 manifest 元数据 |
| `POST` | `/api/agent/task-spaces/resolve` | 只读解析远端、项目和访问状态 |
| `POST` | `/api/agent/task-spaces/attach` | 创建/加入项目并建立 binding |
| `GET` | `/api/agent/task-spaces/:id/snapshot` | manifest 或增量快照 |
| `GET` | `/api/agent/task-spaces/:id/files` | 读取指定 revision 的文件正文 |
| `PUT` | `/api/agent/task-spaces/:id/cursor` | 推进服务端游标 |
| `POST` | `/api/agent/task-spaces/:id/preflight` | 责任人确认和待写摘要预检 |
| `POST` | `/api/agent/task-spaces/:id/changes` | CAS 原子批次 |
| `POST` | `/api/agent/task-spaces/:id/conflicts/:conflictId/resolve` | 覆盖类冲突动作 |

### 12.2 Web

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/tasks/query` | Team 模式要求 `taskSpaceId`，按任务空间隔离分页 |
| `POST` | `/api/tasks` | 入队 `create_task`，返回 202 操作项 |
| `POST` | `/api/tasks/assign` | 入队 `assign_task`，保留原负责人直到成功 |
| `GET` | `/api/task-operations` | 当前可见任务空间的创建/改派操作 |
| `POST` | `/api/task-operations/:id/retry` | 同一幂等键重试 |
| `POST` | `/api/task-operations/:id/cancel` | 取消未成功命令 |
| `POST/DELETE` | `/api/projects/:id/team-access` | owner 邀请/移除其他团队 |

删除 `/api/admin/git-credentials`、`/api/admin/projects/probe`、SSH trust、项目 refresh/repair、
`/api/git-operations/*` 以及旧实时路径。Team 模式不再返回 Git 凭据、fetch/push 时间或工具链状态。

## 13. 前端

### 13.1 项目接入

- 项目栏增加“接入本地项目”，不再要求服务端先有项目；
- 接入向导显示仓库、远端、分支、`.trellis` 状态、团队和 developer ID；
- 缺少 `.trellis` 时显示 Agent 工具多选和“初始化”按钮；
- 等待提交/等待推送状态展示用户可直接执行的 `git status`、`git commit`、`git push` 提示；
- “无法确认”状态提供“重新检查”，不误报失败；
- 已接入项目显示“添加本机 Agent 工具”入口，只影响当前设备。

### 13.2 任务空间和风险

- 项目下按分支展示任务空间；
- 当前分支任务空间在创建、详情和筛选里都显示 branch；
- 同步中显示分支切换风险提示，但不禁用用户入口；
- 一个账号的新设备登录后，旧客户端显示“已在其他设备登录并被下线”。

### 13.3 差异与冲突

- 首次接入在 Web 向导展示只读预检结果，使用“暂不接入 / 仅同步无冲突项 / 查看并处理差异”；
  “暂不接入”只清除待接入路径，不建立 binding；
- 差异按任务目录分组，默认折叠文件级摘要；
- 冲突显示可读人员、设备、时间、任务名和文件；
- 查看差异、使用服务端、覆盖、仅保存本地副本四个动作明确分开；
- 覆盖二次确认并说明会保留双方内容；
- 创建/改派使用独立操作列表和进度弹窗，不插入临时任务卡。

### 13.4 管理台

- 删除 Git 凭据、项目 probe、工具链批准和 SSH trust 页面；
- 项目访问页保留成员、团队邀请、Agent binding 和审计；
- Agent 列表只把 active slot 设备显示为“当前有效 Agent”，其他显示历史/已替换；
- 项目停用只停止任务空间访问和命令投递，不删除客户端仓库。

## 14. 代码边界

新增：

- `shared/remote-identity.js`：客户端/服务端共用远端规范化；
- `shared/task-snapshot.js`：路径、任务目录、摘要和差异分类；
- `server/team/task-space-service.js`：项目、任务空间、团队访问和 binding；
- `server/team/task-snapshot-service.js`：快照、CAS、冲突、cursor 和审计；
- `server/team/task-command-service.js`：在线 Agent 检查和 Web 命令；
- `agent/project-onboarding.js`：仓库预检、Trellis 初始化、推送状态；
- `agent/task-command.js`：本地 `task.py`/负责人写入和路径级安全检查；
- `desktop/sidecar/trellis-runtime.js`：定位并调用安装包内固定 CLI；
- Web 项目接入、分支、差异、冲突和任务操作组件。

重写：

- `server/team/live-sync.js` → `task-snapshot-service.js`；
- `server/team/projects.js` → `task-space-service.js`；
- `server/team/task-writes.js` → `task-command-service.js`；
- `server/team/task-index.js`、`scan-worker.js` 支持 taskSpace 和纯快照扫描；
- `agent/live-sync.js` 收紧为 tasks-only、CAS 和目录级应用；
- `agent/index.js`、`agent/protocol.js`、`agent/api.js` 增加命令和 taskSpace；
- `server/team/http.js`、`server/team/board.js`、`permissions.js`、`agents.js` 改用新表。

删除 Team 运行时引用：

- `server/team/git-manager.js`；
- `server/team/git-credentials.js`；
- `server/team/git-askpass.js`；
- `server/team/remote-identity.js`（纯逻辑移入 shared）；
- Team 项目 clone、Git fetch scheduler、Git operation 恢复和工具链审批；
- 对应前端 credentials/onboarding/SSH/Git operation 组件和测试。

不删除：旧数据库表、`data/projects/**`、`data/git-credentials.key`、用户账号和团队记录。

## 15. 错误、安全和失败语义

- 所有 Agent 文件输入在写数据库前校验，单批失败不落半批；
- 冲突不静默覆盖，覆盖必须二次确认并保留双方内容；
- 命令结果禁止包含本地绝对路径、Token、Cookie 或私钥；
- 服务端任务扫描只读取快照临时目录，不访问客户端仓库；
- 本地应用远端任务时拒绝符号链接、越界和非普通文件；
- 写任务时无关 dirty 允许，目标路径 dirty 必须拒绝并说明具体文件；
- 新 Agent 生效后旧凭证立即失效；
- 项目停用、成员移除、binding 撤销时取消对应待执行命令；
- 远端/网络失败与内容冲突分开提示；
- SQLite 文件损坏时停止写入并保留备份，不从未知客户端自动覆盖数据库。

## 16. 备份、升级与回滚

- schema v10 只新增 `sync_*` 表，不迁移旧项目数据；
- 升级前用 SQLite `VACUUM INTO` 备份当前数据库；
- 每 24 小时创建 task snapshot 数据库备份，保留最近 7 份；
- 旧二进制只接受 schema 6-9，不能原地读取 schema v10；回滚必须先恢复
  `board.sqlite.pre-v10.*` 备份，升级后产生的 `sync_*` 数据不会带回旧版本；
- 新二进制首次启动后旧项目不会自动成为新项目，需要客户端重新接入；
- 回滚时不自动恢复新项目，也不删除旧 `data/projects` 或 Git 凭据密钥；
- 物理清理旧表、旧 `data/projects` 和 Git 凭据密钥必须作为单独的数据清理操作获得授权。

## 17. 验证策略

### 17.1 自动测试

- 远端规范化：HTTPS/SSH/scp、默认端口、userinfo、`.git` 和未授权输入；
- schema v10：全新库、v9 旧数据保留、新表为空、备份和回滚；
- taskSpace 全局唯一和同远端多分支隔离；
- 团队 owner/invite/read/write 权限；
- 单账号活动 Agent 替换、旧 SSE 关闭、旧命令取消；
- CAS 成功、无操作、摘要冲突、删除墓碑、幂等和整批回滚；
- 首次预检五种分类和三个入口；
- 冲突人员/设备/时间、四动作、覆盖备份和审计；
- tasks-only 扫描不读 Git、workspace、scripts、spec、config；
- 活动目录与归档目录移动不产生旧路径幽灵任务；
- 创建/改派命令在线检查、状态机、重试和取消；
- Agent 本地路径保护：无关 dirty 允许，目标路径 dirty 拒绝；
- 客户端首次/增量游标、目录级应用、重启和 SSE 补拉；
- 前端纯逻辑：项目/分支选择、差异分类、操作状态和冲突文案。

### 17.2 Windows E2E

使用隔离的裸 Git 远端、临时数据库、独立端口和两个真实 Agent 配置，验收：

1. 新仓库无 `.trellis`，客户端用固定 Trellis runtime 初始化 Codex + OpenCode；
2. 未提交、未推送、远端不可达分别显示正确状态；
3. commit + push 后接入团队 A，服务端不产生 Git 工作副本；
4. 团队 B 先看到访问提示，邀请后加入同一 taskSpace；
5. 两个客户端通过 SSE/CAS 在 3 秒目标内同步任务；
6. 同文件并发修改只有一个成功，另一个显示明确冲突；
7. 查看差异、服务端版本、我的版本和保存本地副本均不产生半个任务；
8. 活动任务归档后，另一个客户端重启不会恢复旧活动路径；
9. Web 创建/改派在目标 Agent 离线时拒绝，在线时只生成独立操作项；
10. 创建/改派本地执行成功后 Board 才出现正式任务或新负责人；
11. 同仓库另一分支使用独立 taskSpace、revision 和 cursor；
12. 新设备登录踢下线旧 Agent，旧设备无法心跳或领取命令；
13. 停止服务重启后快照、审计、cursor 和索引一致；
14. 服务端日志、数据库和 API 不出现 Git 凭据、本地仓库路径或 GitHub/SSH Token。

## 18. 风险、取舍和延期项

- **远端身份是客户端自报**：服务端不访问 Git，无法独立证明远端存在。通过认证、Agent 强校验、
  审计和全局唯一键降低风险，但不能完全替代 Git 远端所有权验证。
- **Trellis runtime 增加安装体积**：为了离线、可重复地在客户端初始化，必须随桌面安装包携带
  Node runtime 和固定 Trellis CLI。不能依赖用户 PATH 或服务端执行。
- **不做自动内容合并**：冲突需要用户选择，吞吐低于自动 merge，但不会生成语义错误的任务文件。
- **服务端不保存完整历史**：历史依赖客户端 Git；服务端仅保留当前快照、墓碑、审计和冲突备份。
- **分支切换仍是用户风险**：本次只提示，不拦截外部 Git 操作，也不自动修复切换后的任务污染。
- **旧表物理清理延期**：为保证数据库可回滚，本次只停止读写旧表，不自动删除用户数据。
- **server-side 责任确认继续保留**：CAS 解决数据冲突，不替代原有非责任人修改确认和接管审计。
