# 活动任务同步与项目级待归属收件箱 E2E 报告

## 1. 测试拓扑与版本

| 层 | 实际运行信息 | 结论 |
| --- | --- | --- |
| 服务端 | PID `5412`，`node packages/server/index.js`，监听 `0.0.0.0:4317`，启动于 2026-11-18 10:23:35 +08:00 | 运行中 |
| 客户端 | PID `10844`，`TrellisBoard_0.4.38_x64-portable`，启动于 2026-11-18 09:24:29 +08:00 | 运行中 |
| Web | `http://192.168.65.27:4317/` | 页面和 API 可达 |
| 服务端日志 | `C:\Users\yuhaojie\AppData\Local\TrellisBoard\server\logs\server.1.log` | 已使用增量读取 |
| 客户端日志 | `C:\Users\yuhaojie\AppData\Local\TrellisBoard\data\logs\desktop.log` | 已使用增量读取 |
| 数据库 | `C:\Users\yuhaojie\AppData\Local\TrellisBoard\server\board.sqlite` | `schema_version=17` |

版本证据：

- 本地 HEAD 为 `96aedff99e9d6aded2643fc7be358633c0460904`。
- `git tag --contains 5c710ee` 返回 `v0.4.38`，证明当前客户端发布版包含本次修复提交。
- 服务端进程启动时间晚于 `5c710ee`，数据库存在 `sync_task_ownership_inbox` 表，schema 为 17。
- 5 个 taskSpace 的 cursor 均为 `revisionGuardVersion=1`、`pending=null`。
- 客户端 09:24 启动后的日志为 `scanMode=incremental/reused`，未出现全量快照修复；没有重复执行 revision guard full snapshot。

## 2. 逐步证据

| # | 操作 | 接口/UI 结果 | 日志与性能 | 结论 |
| --- | --- | --- | --- | --- |
| 1 | 打开 Board 根页面 | `/api/runtime`、`/api/panels`、`/api/tasks/query`、`/api/team/status` 均为 `200` | 无浏览器控制台错误 | 通过 |
| 2 | 创建空分支探针 `11-18-e2e-pending-inbox-20261118-1348` | 客户端自动发现后，`/api/team/status` 的 `ownershipInboxCount=1`，`/api/ownership-inbox` 返回该标题、目录、`TASK_OWNERSHIP_REQUIRED`、来源分支 `main` 和来源客户端 | 客户端 13:47:37 检测到任务文件变化；服务端 `lastSeenAt=13:47:39`；ownership scan `808ms`，后续增量 `613ms` | 通过；10 秒可见 SLA 满足 |
| 3 | 输入不存在的搜索词并填写分支筛选 `main` | 普通 Kanban 变为 0，但项目警示条和“待归属任务 1”仍保留 | 搜索请求 `/api/tasks/query?q=ZZZ...` 与分支请求 `branch=main` 均为 `200`；窗口内无服务端错误 | 通过；收件箱计数不被列表筛选隐藏 |
| 4 | 客户端对唯一可见分支自动归属 | 任务被补写 `branch=main`；revision 603→604；任务出现在普通 `main` 看板；收件箱计数变为 0 | `任务空间投影完成`：`changedTaskCount=1`、`totalMs=392`、`taskCount=129` | 通过 |
| 5 | 选择具体项目查看空状态 | 左侧显示禁用态“待归属任务 0”，主内容区警示条隐藏 | `/api/team/status` 与 `/api/ownership-inbox` 均为 `200`，计数为 0 | 通过 |
| 6 | 创建第二个空分支探针 `11-18-e2e-inbox-equal-entry-20261118-1355` | 13:55:11 进入服务端收件箱，页面自动出现警示条 | 客户端 13:55:09 增量扫描；`scanMode=incremental`，`taskJsonParsed=1`，`elapsedMs=770` | 通过 |
| 7 | 点击主内容区“查看待归属任务” | 展开列表显示标题、任务目录、`TASK_OWNERSHIP_REQUIRED`、来源分支、来源客户端和最近发现时间 | 浏览器请求 `/api/ownership-inbox?...&limit=50` 返回 `200` | 通过 |
| 8 | 收起后点击左侧“待归属任务 1” | 展开的是同一个列表，左侧按钮和主内容区按钮都变为 `expanded` | 再次请求 `/api/ownership-inbox?...&limit=50`，返回 `200` | 通过；双层入口共用状态 |
| 9 | 直接删除尚待归属的第二个本地任务目录 | 普通任务索引已清掉，但 cursor 的 `ownershipPending/pendingRejected` 仍保留；服务端 inbox 超过 20 秒仍残留 1 条；桌面客户端错误显示“1 个任务服务端拒绝待处理” | 客户端后续扫描已降为 `taskDirs=7`，但没有清理不存在任务的 cursor 摘要；服务端无异常堆栈 | **失败，真实缺陷** |
| 10 | 通过桌面客户端“处理 main 的任务归属”打开归属界面 | 界面显示“当前没有需要处理归属的任务”，cursor 随后被清理，但服务端摘要仍未立即删除 | `list_task_ownership` 清理了 cursor，但没有向服务端发送对应 delete | **部分失败；同类清理缺口** |
| 11 | 为探针补一次正常文件变更，触发重新上传 | revision 605→606，服务端在正常任务快照事务中删除 inbox；随后删除任务，revision 606→607 | 上传投影 `totalMs=414`；删除投影 `changedTaskCount=1`、`scannedTaskCount=0`、`totalMs=363` | 通过；产品正常上传路径可清除摘要 |
| 12 | 最终清理校验 | `ownershipInboxCount=0`、`inbox.total=0`、探针任务索引命中 `0`、本地两个探针目录均不存在；桌面客户端显示“已关联 · 同步正常”和“待归属任务 0” | `/api/team/status`、`/api/ownership-inbox`、`/api/tasks/query` 均为 `200` | 通过 |

## 3. 缺陷结论

真实失败项是“删除尚待归属的本地任务后，项目级收件箱没有随之收敛”。

已核实的代码路径：

- `packages/desktop/src-tauri/src/agent/task_sync.rs:5955-5983`：
  `resolve_task_ownership()` 先清理 `ownershipPending`，随后把清理后的
  `current_ownership_pending` 同时作为 `sync_ownership_inbox()` 的
  `previous_pending` 传入。
- `packages/desktop/src-tauri/src/agent/task_sync.rs:5698-5723`：
  服务端 delete 只从“previous 中存在、current 中不存在”的目录生成。
- 因此当任务从未上传、随后被本地删除时，客户端没有保留可用于生成 delete 的
  previous 集合，服务端摘要会残留；桌面端还可能继续显示“服务端拒绝待处理”。

该问题不属于脚手架，结论来自真实文件删除、cursor、SQLite 行和桌面 UI 的一致性对照。

## 4. 性能观察

- 活动任务接入收件箱：客户端增量扫描约 `0.6-1.4 秒`，服务端摘要约在下一轮同步内出现，
  两次探针都在 10 秒内被页面发现。
- 正常任务投影：revision 604 为 `392ms`，revision 606 为 `414ms`。
- 删除任务投影：revision 605 为 `188ms`，revision 607 为 `363ms`。
- 本次任务创建和删除期间，客户端 ownership 扫描均为 `incremental`，没有出现任务同步触发的
  归档全量递归扫描。
- 后台归档 Git 同步仍会单独运行，本轮日志中单次约 `5.7-8.2 秒`，但
  `needsIndex=false`、`readMs=0`、`purgedFiles=0`，属于本任务范围外链路。

## 5. 未覆盖项

- 没有在真实客户端制造“旧 branch=null pending 后面紧跟一个新 main 任务”的队头阻塞场景；
  当前 cursor 原本无 pending，只有 Rust 单测覆盖该状态机。
- 没有构造两个真实客户端相邻 revision 写入/删除的交错场景。
- 当前 `trellis-board` 只有一个可见 taskSpace，客户端会很快自动推断为 `main`；
  因此未进行长期存在的多分支歧义任务测试。
- 本机没有可用 `cargo`/`rustup`，Rust 编译和单元测试仍未执行。

## 6. 首轮结论（2026-11-18）

- 新建空分支任务进入项目级收件箱：通过。
- 左侧入口、主内容区警示条、筛选不可隐藏：通过。
- 唯一分支自动归属且普通看板仅保留一份：通过。
- 客户端已重启且未重复 revision guard full snapshot：通过。
- 本地直接删除尚待归属任务后的客户端 cursor 与服务端摘要清理：**不通过**。

在修复该删除收敛缺口前，不应把本任务标记为完整 E2E 通过。

## 7. 删除收敛缺口复验（2026-11-19，0.4.44）

### 7.1 版本与拓扑

| 层 | 实际运行信息 | 结论 |
| --- | --- | --- |
| 客户端 | `TrellisBoard_0.4.44_x64-portable`，PID `24108` / `27624` / `35496` 多次重启 | 运行中 |
| 服务端 | PID `23752`，监听 `0.0.0.0:4317` | 运行中 |
| 数据库 | `board.sqlite`，schema 17 | `sync_task_ownership_inbox` 可查 |
| 客户端 cursor | `data/agent/live-cursors.json` | `revisionGuardVersion=1`、`pending=null` |

修复链路已进入当前版本：

- `a1f6d07 fix(sync): 收敛已删除待归属任务收件箱`，包含于 `v0.4.39` 及之后。
- `8c101fc fix(sync): 启动时续传离线待归属删除`，包含于 `v0.4.40` 及之后。
- 本轮复验使用 `0.4.44` portable，未改代码，仅复验既有修复。

### 7.2 删除待归属任务后收敛（原失败项）

探针 `11-19-e2e-ownership-delete-delayed-0955`（`branch=null`，任务 ID 与目录名不同）：

| 相对时间 | 观察 |
| --- | --- |
| +2.5s | 服务端 inbox 与 cursor `ownershipPending`、`pendingRejected` 同时出现 |
| +4.57s | 删除本地任务目录（账本仍为非空） |
| +5.63s | 删除后 **1065ms**，inbox、`ownershipPending`、`pendingRejected` 全部清零；任务索引仍为 0 |

结论：原“删除尚待归属任务后收件箱不收敛”的缺陷已修复，复验通过。

另做了一个更激进的竞态探针 `11-19-e2e-ownership-delete-race-0952`
（创建后约 100ms 内删除）：

- watcher 未收到可用的删除事件，服务端 inbox 与两份 cursor 账本残留超过 2 分钟。
- 重启客户端后，启动清理路径在约 61 秒内将 inbox 与两份账本清零。
- 该竞态不是本次验收项，且启动兜底可恢复；但说明“创建即删除”的极短窗口存在
  watcher 事件合并风险，后续可单独评估是否需要在周期性对账中加速补偿。

### 7.3 revision 只表示已应用位置

探针 `11-19-e2e-revision-semantics-1008`（`branch=main`）：

| 相对时间 | 服务端 revision | cursor revision | pending | 说明 |
| --- | --- | --- | --- | --- |
| +21ms | 28 | 18 | 无 | 基线 |
| +2.2s | 28 | 18 | `6492fdfb…` | 上传批次已持久化 |
| +2.7s | **29** | **18** | 同一批次 | 服务端已提交，待应用 revision 未跳跃 |
| +2.8s | 29 | **18** | 已清除 | pending 清除、sequence/baselines 推进，revision 仍为 18 |
| +45s 删除后 | **30** | **18** | 无 | 墓碑提交同样不推进 cursor revision |

重启后再次创建 `11-19-e2e-upload-after-restart-1015`：服务端 31→32→33，
cursor revision 始终为 18。

结论：上传应答和墓碑提交只更新 sequence/baselines，不再冒充已应用 revision，验收项通过。

### 7.4 本轮未收敛观察

两次带 trace 的重启（09:57、10:03、10:09）中，`启动同步完成` 仅出现在
`0a934f94`、`259b1dc1`、`d3a320e8`、`a92fe04b` 四个 taskSpace，
缺少 `3536a478`（trellis-board/main）。

打开 HTTP trace 后确认根因不是“启动同步被跳过”，而是 **pull 循环无法收敛**：

- cursor 基线仍包含两个已经移入 archive 的任务目录：
  `.trellis/tasks/11-18-desktop-node-detection`、
  `.trellis/tasks/11-18-web-component-reuse-audit`。
- pull 把这两个“本地活动目录已消失”的目录判定为 dirty；
  随后 `upload-local` 的 `localGroups=0`，服务端
  `GET /api/agent/task-spaces/3536a478.../files?taskDir=...` 返回
  409 `ARCHIVE_SYNC_SERVER_MANAGED`。
- 客户端把 409 归入 `archived_dirs` 并只做 `cleanup_archived_residue`，
  没有清除 cursor 中这两个目录的基线；`pull_tracking` 在上传后递归回自身，
  下一轮再次得到同样的 dirtyDirs=2。
- 日志中 `pull-cursor → snapshot?afterRevision=18 → pull-local dirtyDirs=2 →
  upload → 409` 以约 1.4 秒周期持续重复，`启动同步完成` 因此始终不打印，
  cursor revision 停在 18，服务端 revision 已到 33。
- 结果是：本机未应用 revision 19-28 的墓碑和跨客户端任务
  `11-19-witops-test-outline-flow`（revision 26）。上传和删除其他任务仍正常
  （服务端 31→33），但已应用位置无法前进。
- 期间出现过一次 `GIT_TIMEOUT`（09:53:40，taskSpace `3536a478`），与本循环无直接关系。

该缺陷会让“启动补拉/事件补拉”在存在归档移出残留时永久空转，直接阻断
R3“下一次 pull 从已应用 revision 之后补齐中间变更”的验收，需要在本任务或后续任务修复。
初步修复方向：服务端明确返回 `ARCHIVE_SYNC_SERVER_MANAGED` 时，除删除本地残留外，
还要通过 cursor patch 清除该目录的 baselines（以及相关 deferred/readonly 状态），
使下一轮 pull 不再把它当作 dirty；或让 pull 在计算 dirtyDirs 时按任务控制状态排除
已归档任务。

处置：经用户确认，在本任务内修复。修复完成后在本报告追加复验记录。

### 7.5 清理基线后的收敛模拟

在等待代码修复前，手动备份并删除 cursor 中上述两个归档目录的基线（以及同目录的
deferred/readonly/账本残留，模拟目标修复的效果），重启 `0.4.44` 客户端：

| 观察 | 结果 |
| --- | --- |
| 启动同步 | `3536a478` 启动同步完成，`elapsedMs=6310`（修复前永不完成） |
| 第一轮 pull | `dirtyDirs=1`（仅当前任务更新的 e2e-report），上传提交 `committedRevision=39` |
| 第二轮 pull | `dirtyDirs=0`，随后 cursor revision **18 → 39** |
| 循环 | 不再出现重复的 `pull-cursor → pull-local dirtyDirs=2 → 409` |
| 服务端 revision | 39，与 cursor revision 一致 |
| 收件箱/账本 | inbox 0，`ownershipPending`/`pendingRejected` 为空 |

说明：跨客户端任务 `11-19-witops-test-outline-flow` 未在本地落盘；本轮 pull 只应用
revision 和墓碑，不下载 server-only 任务，符合当前普通 pull 的职责。关键结果是已应用
revision 能正常追平，证明“清除归档目录基线”即可终止循环。该模拟同时确认 cursor 备份
位于 `live-cursors.json.bak-20261119-preloopfix`。

### 7.6 首轮未覆盖项状态

- 真实双客户端交错 revision：仍未用两台真实客户端复现；服务端自动化测试覆盖。
- 旧 `branch=null` pending 队头阻塞 + 新任务：仍只有 Rust 单测覆盖。
- 多分支歧义任务长期停留：本机仍只有单一可见 taskSpace，未覆盖。
- 本机没有 Rust 工具链，Rust 编译/单测依赖 CI。

### 7.7 代码修复（工作区，待 CI 与新版本 E2E）

已按 7.5 的模拟结果实现修复：

- `cursor.rs`：`CursorPatch` 新增 `task_dir_removals`；在 cursor 写锁内按
  `{taskDir}/` 前缀移除 baselines 并移除同名 deferred，新增
  `remove_task_dir_cursor_state()` 批量持久化。
- `upload.rs`：服务端返回 `TASK_ARCHIVED`/`ARCHIVE_SYNC_SERVER_MANAGED` 后，
  对清理后确实不存在的本地活跃目录写一次 `task_dir_removals` patch；
  本地仍有内容的目录保留基线，避免误删用户数据。
- `local_files.rs`：新增 `active_task_directory_exists()` 供上述安全判断。
- 测试：`task_dir_removals_clear_only_target_directory_state` 与
  `archived_directory_409_clears_cursor_state_and_pull_advances_revision`
  覆盖基线清理、循环终止、下一轮 pull 推进 revision。
- 规范：`.trellis/spec/backend/desktop-realtime-sync.md` 已写入契约。

验证状态：IDEA lint（error/warning）与 `git diff --check` 通过；独立 `trellis-check`
复查 0 个需修改发现。本机无 Rust 工具链，编译与单测待 CI。

### 7.8 0.4.45 真机复验（修复已生效）

版本与构建：

- 工作提交 `2c08b29`（`fix(sync): 收敛归档残留导致的 pull 循环`），发版提交
  `bf8b37c chore(release): 0.4.45`，标签 `v0.4.45`。
- GitHub Actions run `44448351024` 成功（Node/Rust 单测、desktop 打包、Release 发布）。
- portable 包
  `TrellisBoard_0.4.45_x64-portable.zip`，SHA-256
  `cc66bd66b9dbf53269ba1d65d13692258654148a1ce6f6d9dc1d7b4c6b85bed8`，
  本地校验一致。

复验步骤与结果：

1. 停止 0.4.44 客户端，备份 `live-cursors.json`，向 `trellis-board/main` 的 cursor
   重新注入两个归档目录的 4 条 stale baseline，并把 revision 置为 56
   （服务端为 57）。
2. 启动 `0.4.45` portable 客户端（PID `37612`，开启 HTTP trace）。
3. 首次 pull 得到 `dirtyDirs=2`；客户端对两个归档目录各请求一次
   `/files?taskDir=...`，均返回 409 `ARCHIVE_SYNC_SERVER_MANAGED`。
4. `upload-total`：`committedRevision=0`、`revision=56`、`targetDirs=2`；
   随后 `task_dir_removals` 生效，两个目录的基线被清除。
5. 第二次 `pull-cursor` 后应用快照：`启动同步完成 taskSpaceId=3536a478`
   `elapsedMs=7646`（修复前永不打印）。
6. 最终状态：cursor revision **57**（与 server revision 57 一致）；
   baseline 只剩两个当前任务目录；`pending`、`ownershipPending`、
   `pendingRejected` 为空；项目 inbox 为 0。
7. 全程只出现两次归档目录 `/files` 请求和两次 pull-cursor，
   未再出现 1.4 秒级的 `pull → 409 → pull` 循环。

结论：7.4 的归档残留 pull 循环在 `0.4.45` 上修复并真机复验通过；
备份文件为 `live-cursors.json.bak-20261119-before-0445-e2e`。

## 8. 复验结论

- 原失败项“删除尚待归属任务后 cursor 与项目收件箱收敛”：**复验通过**（1.065s 内收敛）。
- 上传不推进已应用 revision：**复验通过**。
- 存在归档移出残留时 pull 循环空转、已应用 revision 无法前进：**已在 0.4.45 修复并真机复验通过**
  （见 7.8：启动同步恢复、revision 56→57、无循环）。
- 真实双客户端 revision 交错、旧 pending 队头阻塞和多分支歧义：仍未做真实 E2E，
  沿用自动化覆盖说明。

本任务的两个真实缺陷（删除收敛、归档残留 pull 循环）均已修复并复验通过，可以进入收尾；
上述未覆盖场景应作为已知限制保留，而不是声称已做真实 E2E。
