# 多客户端任务同步控制面 E2E 报告

## 环境与版本

- 日期：2026-11-19，Asia/Shanghai。
- 桌面客户端 A：`yhj`，PID 35184，便携版 build #9
  `TrellisBoard_0.4.45_x64-portable`，SHA256
  `dc7f50cba5be2f2bc5f8615d523edea49032b207ca48a1c39c788c5410170a22`。
- 桌面客户端 B：用户 `test`，机器 `DESKTOP-AC42130`，build #6，仓库
  `\\?\D:\wit\trellis-board`。
- 服务端：A 机 `0.0.0.0:4317`，日志
  `%LOCALAPPDATA%\TrellisBoard\server\logs\server.1.log`。
- 数据库：`%LOCALAPPDATA%\TrellisBoard\server\board.sqlite`。
- taskSpace：`3536a478-4b1b-4b3b-a8f0-42903482d33d`，项目 `trellis-board`，
  基线分支 `main`。
- 客户端日志：`%LOCALAPPDATA%\TrellisBoard\data\logs\desktop.log`。

## 本轮修复

1. 命令结果 revision 不再取上传响应里的 `revision`（上传前空间游标），而是依次取
   `control.task.contentRevision`、`committedRevision`、claim 时保存的
   `contentRevision`。解决 `TASK_VERSION_STALE`。
2. 命令成功上传后主动释放执行租约；服务端 handoff 清理只把第三方租约视为阻塞，
   负责人自己的租约不再阻止创建者清理来源副本。
3. 服务端 `COMMAND_WAITING_INDEX` 作为可重试状态处理，客户端记录重试与放弃日志。
4. Windows 隐藏/最小化通知改为原生 `ToastText02`：
   - WebView2 的 `http://` 非安全上下文没有 Web Notification API；
   - `tauri-plugin-notification` 对便携版 AUMID `com.trellisboard.client` 发送
     `ToastGeneric` 会被系统静默丢弃；
   - 客户端在窗口隐藏或最小化时通过 PowerShell `-EncodedCommand` 调用 WinRT
     原生 Toast，可见时只保留页内提示。
5. 归档 tombstone：客户端只删除本地归档副本存在且摘要一致的活跃副本；摘要不一致
   时保留本地数据并记录告警。

## 验收清单

### 1. 离线委派与目标客户端认领

- Board 创建并委派给离线 B；命令进入待领取状态，B 上线后只领取自己的
  `create_task`。
- 命令 `/start`、`/claim`、`/changes`、`/result` 全部成功；任务以
  `materialized` 进入 Board。

### 2. 目标只落地自己的任务

- B 的仓库只出现目标任务目录，没有因 A 的任务变化生成其他未跟踪任务。
- A 修改自己负责的任务（P9）后，内容 revision 推进到 104；B 侧
  `Test-Path .trellis/tasks/11-19-e2e-own-20261119-9` 为 `False`，B 工作区未被污染。

### 3. 非负责人修改被拒绝

- A 从 handoff 备份恢复 P8 并本地追加修改；服务端任务 content revision 保持
  101/104 不变，归档前任务版本未推进。
- A 客户端本地正文保留，控制状态为非可写；服务端没有接受这次写入。

### 4. 归档 tombstone：干净副本删除、脏副本保留

- 通过临时提交 `45a5f81` 把 P9（干净）和 P10（脏）移入
  `.trellis/tasks/archive/2026-11/`，推送到 `origin/main`；A 执行
  `git pull --ff-only` 后本地获得归档副本。
- 服务端归档同步 14:16:53 UTC：`archiveRevision` 11→12，`fileCount` 950→954，
  `purgedFiles=4`，taskSpace `revision/indexed_revision` 108→109。
- `sync_task`：P9/P10 均 `archived=1`、`task_version=4`，`relative_dir` 收敛到
  `.trellis/tasks/archive/2026-11/...`。
- 客户端 14:16:56 UTC：
  - `清理残留活跃副本 .trellis/tasks/11-19-e2e-own-20261119-9`，P9 活跃目录已删除；
  - `本地残留已归档任务副本 .trellis/tasks/11-19-e2e-own-20261119-10：存在未同步改动，已跳过清理`，
    P10 活跃目录与本地新增行保留。
- 随后临时清理提交 `f65bb67` 删除两个归档探针；服务端归档同步 14:22:33 UTC：
  `archiveRevision` 13，探针归档文件 0。main 最终文件树恢复干净，历史中保留这两条
  测试提交（已获用户同意）。

### 5. 旧客户端离线写入被拒绝

- P8 重新指派给 `test` 后，B 离线本地修改 `prd.md`（追加 `test`）。
- 服务端版本推进到 `task_version=6`、`content_revision=105`。
- B 恢复后日志：`任务进入 Reassigned 控制状态，本地数据保留并停止写回`；B 本地
  正文保留 `test`，服务端没有接受 B 的过期写入。

### 6. Handoff 双客户端闭环

- P4：命令成功，handoff 自动 `completed`，来源副本清理 ACK 为 cleaned，备份
  `handoff-da866f5ddf2c03fc`（2 文件/595 字节）。
- P8：清理完成，备份 `handoff-eca492921eca89e9`（2 文件/542 字节）。
- 目标客户端在清理时仍持有租约；服务端只把第三方租约视为阻塞，未再误判
  `HANDOFF_LEASE_HELD`。
- 用户在 A 机实际看到 P8 的 Windows 通知（ToastText02）。

### 7. 迁移重复处理

- 新建活跃目录 `.trellis/tasks/11-19-e2e-dup-archived-20261119`，`task.json.id`
  故意复用已归档任务 `worktree-auto-attach`（内容不同）。
- 客户端检测到后没有上传：服务端没有新增 `sync_task_space_file`/上传批次；
  归档 `sync_task` 行保持 `archived=1`，本地目录与正文保留。
- 该路径由服务端 claim 的 `TASK_ARCHIVED`/基线归属规则拦截，归档身份保持唯一，
  不会复活或静默删除；活跃任务之间同 ID 的 `identity_conflict` 由自动化测试
  `增量新增重复 task.json.id 仍在全任务范围标记身份冲突` 覆盖。
- 探针目录已删除，归档真实任务未受影响。

## 清理记录

- 本地探针目录：P1–P10、重复 ID 探针全部删除；B 的临时镜像不再保留。
- 数据库清理前备份：
  `%LOCALAPPDATA%\TrellisBoard\server\backups\board.sqlite.pre-probe-cleanup.2026-11-19T14-25-59Z`，
  94,306,304 字节（`sqlite3.backup` API）。
- 单事务删除探针行：
  - `sync_task` 10；
  - `sync_task_index` 8；
  - `sync_task_lease` 70；
  - `sync_task_assignment` 8；
  - `sync_task_command` 10；
  - `sync_file_audit` 34；
  - `sync_task_space_file` 20；
  - `sync_conflict` 1。
- 清理后复核上述表的探针计数全部为 0；用户任务
  `11-19-branch-mismatch-notify` 与真实归档任务 `worktree-auto-attach` 保留。
- `live-backups` 删除 5 个探针备份（记录后删除）：
  - `handoff-6ba951e3dde66015`（P5，1322 字节）；
  - `handoff-da866f5ddf2c03fc`（P4，1398 字节）；
  - `handoff-69dd1c01812ce1c6`（P6，1336 字节）；
  - `handoff-8442596a35a4b2bf`（P7，1401 字节）；
  - `handoff-eca492921eca89e9`（P8，1346 字节）。
- 临时构建目录与局域网 HTTP 服务已停止/删除；本轮证据快照保留在
  `%TEMP%\trellis-e2e-archive-20261119\`（报告完成后可删除）。

## 自动化验证

```text
node --test packages/server/test/team-task-commands.test.js \
  packages/server/test/team-task-control.test.js \
  packages/server/test/agent-event-stream.test.js \
  packages/server/test/team-task-index-v10.test.js

49 passed / 0 failed / 0 skipped
```

- GitHub Actions `windows.yml` build #9 构建成功（客户端 A 使用该构建）。
- 先前 `yarn test`：643 tests / 642 passed / 1 skipped / 0 failed；`yarn build`
  与 `yarn build:desktop` 通过；仅保留既有 chunk/theme-init 提示。
- IDEA MCP 对 `runtime.rs` 错误级检查无错误。

## 未覆盖边界

- P9/P10 是 A 独占任务，B 的控制面不会收到它们的墓碑；跨用户归档墓碑的接收未在
  B 侧单独复测。服务端控制按用户过滤，B 侧 handoff/命令闭环已单独验证。
- 归档脏副本当前策略是保留原活跃目录并告警，未额外生成独立 live-backup 目录；
  满足“不得静默删除”，但产品提示目前以客户端日志/本机状态为主。
- 迁移重复探针走的是“归档身份 claim 拒绝”路径，因此 Board 不会出现第二行
  `identity_conflict`；活跃任务同 ID 的冲突由自动化测试覆盖。
- 未复测“本地为 Git tracked 且已修改”的归档副本；本轮脏副本为未跟踪目录。
