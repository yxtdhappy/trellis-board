# 实施计划

## 前置门禁

- [ ] 完成 PRD 评审并确认服务端数据库是任务动态元数据唯一事实源。
- [ ] 确认首版只处理 Team 模式；standalone 的本地扫描行为保持不变。
- [ ] 先完成 schema v16 迁移和回滚验证，再改客户端同步策略。
- [ ] 不在本阶段直接删除现有活动/归档重复副本。

## 1. Schema 与迁移

1. 在 `packages/server/database.js` 增加 v16：
   - `sync_task` 权威任务表；
   - `sync_task_lease` 租约表；
   - `sync_task_command.target_user_id` 及可空 agent/binding 迁移；
   - 必要索引和幂等迁移测试。
2. 从现有 `sync_task_index`、`sync_task_space_file`、`sync_archive_file` 回填任务记录。
3. 增加 v15 备份、重复迁移、空库、旧数据回滚测试。
4. 为活动/归档同 ID 的重复行增加冲突标记，不在迁移中静默删除本地数据。

## 2. 服务端权威任务服务

1. 新建任务生命周期服务，统一处理 create/assign/claim/release/archive。
2. 创建任务时先写 `sync_task`，不要求目标 Agent 在线。
2.1 增加本地 Agent 首次快照 upsert：认证用户成为 creator，首次上传即可建立任务
    记录并进入 Board；同一 execution identity 幂等。
3. 命令允许保存目标用户；客户端上线领取时再绑定唯一 active Agent。
4. 创建/改派/认领/归档全部使用事务、审计事件和 task version。
5. `sync_task_index` 改为从 `sync_task` + 任务内容快照投影，不能反向覆盖权威字段。
6. 查询接口继续支持 active/archive，但同一执行身份只能返回一个最终状态。

风险文件：

- `packages/server/database.js`
- `packages/server/team/task-command-service.js`
- `packages/server/team/task-space-index.js`
- `packages/server/team/task-snapshot-service.js`
- `packages/server/team/http.js`

## 3. 客户端控制面

1. 在 `packages/desktop/src-tauri/src/agent/task_sync.rs` 区分：
   - 服务端控制元数据；
   - 已认领任务内容；
   - 冷启动修复快照。
2. 默认不再调用 `apply_server_groups()` 写入所有活动任务；只写当前用户已认领
   或明确接管的 task ID。
3. 新增待交付/待认领查询，获取本人任务；不接收其他用户正文。
3.1 保留本地 watcher 的首次上传路径：本地 Agent 创建的任务由创建者客户端直接
    注册到服务端，不要求先调用 Board 创建接口。
3.2 增加 handoff 清理状态机：目标 materialized 并上传完成后通知创建者；对干净、
    Agent 管理、未跟踪的活动副本自动写轻量备份和审计后删除，其他情况转备份或人工处理。
3.3 增加非阻塞认领通知：
    - Board 可见时复用 Sonner toast；
    - 窗口隐藏/最小化时接入 Tauri 系统通知插件；
    - 禁止调用 `focus_main_window` 或创建模态/控制窗口；
    - 使用 handoff ID + state 幂等，通知失败不得阻塞清理。
4. 在执行 `task.py create`/改派前申请租约；上传时携带 lease token 和 task version。
5. 任务归档、改派和租约撤销以轻量事件更新本地状态，失败后由下一次拉取修复。
6. 保留显式“全量对账/修复”入口，只用于冷启动和人工排障。

风险文件：

- `packages/desktop/src-tauri/src/agent/task_sync.rs`
- `packages/desktop/src-tauri/src/agent/task_command.rs`
- `packages/desktop/src-tauri/src/agent/runtime.rs`
- `packages/desktop/src-tauri/src/agent/device.rs`
- `packages/server/team/sync-agent-service.js`

## 4. Web 与页面状态

1. 创建/改派弹窗不再要求目标 Agent 在线，只显示待交付状态。
2. Board 活动/归档状态增加 `pending_delivery`、`claimed`、`lease_expired`、
   `version_stale`、`migration_conflict` 的可读文案。
3. 任务详情在未 materialize 前显示服务端元数据，不展示不存在的正文。
4. 归档/改派确认弹窗明确提示本地副本是否会被清理或进入备份。
5. 普通浏览器不触发客户端本地写入。

风险文件：

- `packages/web/src/api/board.ts`
- `packages/web/src/pages/board/BoardPage.tsx`
- `packages/web/src/features/board/dialogs/TaskDetailDialog.tsx`
- `packages/web/src/components/layout/ProjectRail.tsx`
- 对应组件/纯逻辑测试

## 5. 归档与迁移清理

1. 归档导入按 `execution_task_key` 匹配权威任务，生成 activity tombstone。
2. 客户端收到 tombstone 后先计算本地目录摘要：
   - 未修改：移除活动副本；
   - 已修改：写入 live-backup 并提示；
   - 租约有效：拒绝自动清理。
3. 增加现有两个重复任务的只读诊断与人工清理入口。
4. 保留审计记录，不以 `.gitignore` 隐藏污染。

## 6. 测试

### 单元与服务端测试

- [ ] schema v15 -> v16 幂等升级、备份和回滚。
- [ ] 任务去重、活动/归档同身份收敛。
- [ ] 离线创建/改派命令不要求 Agent 在线。
- [ ] 目标客户端上线后领取命令并绑定唯一 Agent。
- [ ] 租约获取、心跳、过期、接管和 fencing 拒绝。
- [ ] 旧版本客户端上传已归档/已改派任务被拒绝。
- [ ] 归档 tombstone 的干净删除、脏副本备份和租约保护。

### 客户端测试

- [ ] 两个客户端同分支时，B 不因 A 的任务变化写入 A 的任务正文。
- [ ] 本地 Agent 直接创建任务后，创建者客户端首次上传能在 Board 出现，creator
      使用认证用户而不是 `task.json.creator`。
- [ ] 同一本地任务重复上传幂等，不会生成两个 execution identity。
- [ ] 本地创建的创建者可以自办，也可以委派给其他项目成员；委派后创建者本地副本
      不被静默删除，目标客户端只在认领后落地。
- [ ] 目标完成认领、上传和索引后，创建者收到清理事件；干净未跟踪副本被删除，
      脏副本和 Git 跟踪副本保留并产生可诊断状态。
- [ ] 自动删除前产生轻量备份和审计，备份可恢复，清理 ACK 丢失时可幂等重试。
- [ ] 创建者可见时收到页内 toast，隐藏时收到系统通知；两种路径都不抢焦点、不弹确认框。
- [ ] 重复 handoff 事件只通知一次，系统通知失败仍有 Board 内持久状态。
- [ ] 创建者离线、重复事件、重启和清理 ACK 丢失时 handoff 状态可幂等恢复。
- [ ] 首次认领只落地目标 task ID。
- [ ] pending/command 重连和幂等恢复。
- [ ] Git 分支切换、仓库失联和租约过期错误可诊断。
- [ ] 归档/改派事件丢失后，下一次控制面同步可修复。

### Web 测试

- [x] 离线委派立即显示待交付。
- [x] 活动/归档不再同时展示同一执行身份。
- [x] 未 materialize 任务详情不请求不存在的正文。
- [ ] 状态文案和无障碍行为符合现有规范。

### 真实 E2E

- [ ] 两台客户端：A 创建并委派给离线 B，Board 立即显示待交付。
- [ ] B 上线后只落自己的任务并完成认领。
- [ ] A 修改自己的任务，B 工作区无新增未跟踪任务。
- [ ] A 尝试修改 B 的任务，被租约/所有权拒绝。
- [ ] A 归档，B 收到墓碑；干净副本删除，脏副本可恢复。
- [ ] B 离线数分钟后恢复，旧版本写入被拒绝且本地数据保留。
- [ ] 现有两个未跟踪活动副本按迁移规则收敛，不误删。

## 7. 验证命令

```powershell
node --test packages/server/test/database-v10.test.js
node --test packages/server/test/database.test.js
node --test packages/server/test/team-task-commands.test.js
node --test packages/server/test/team-gitless-http.test.js
yarn test
yarn build
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
```

## 8. 回滚点

1. 关闭离线创建/改派入口，继续保留现有在线命令路径。
2. 停止活动任务墓碑广播，保留服务端审计和备份。
3. 客户端恢复旧快照模式，但禁止覆盖用户本地活动任务。
4. 数据库 v16 回退前先备份当前库、WAL、SHM 和迁移日志。

## 9. Out Of Scope

- 不重写 `task.py` 的阶段推导规则。
- 不让服务端直接写业务 Git。
- 不自动处理 Git merge/rebase 冲突。
- 不把 standalone 模式改成 Team 控制面。

## 10. 分批执行记录

### A 批：服务端上报与控制面

状态：已完成（2026-11-17）。本记录仅代表 A 批完成，不代表整体任务完成。

已完成内容：

- SQLite schema 升级到 v16，新增 `sync_task` 权威任务表和
  `sync_task_lease` 任务写租约表；重建 `sync_task_command`，支持按
  `target_user_id` 排队以及 `agent_id`/`binding_id` 延迟绑定。
- 从现有活动索引回填权威任务，并在任务归档投影变化时把同一
  `execution_task_key` 收敛为归档墓碑。
- 新增任务控制服务，统一处理权威任务登记、本人可见性、版本、负责人、
  租约获取/心跳/释放，以及旧客户端、非负责人和已归档任务写回拒绝。
- 创建和改派不再要求目标 Agent 在线；命令先按目标用户排队，客户端上线后
  再绑定当前唯一有效 Agent。
- 活动快照只返回本人任务正文和轻量控制信息；上传前校验负责人、任务版本、
  租约和归档状态，首次本地任务上传使用认证用户建立创建者身份。
- 任务空间索引按同一执行身份收敛活动和归档状态，权威负责人与归档状态覆盖
  索引投影，并为待交付任务提供 Board 可查询记录。
- Agent HTTP 增加任务读取、认领、心跳和释放路由。

验证结果：

```powershell
node --test packages/server/test/database.test.js packages/server/test/database-v10.test.js packages/server/test/plugin-store.test.js packages/server/test/team-agent-slot.test.js packages/server/test/team-task-spaces.test.js packages/server/test/team-task-snapshot.test.js packages/server/test/team-task-index-v10.test.js packages/server/test/team-task-commands.test.js packages/server/test/team-task-control.test.js packages/server/test/team-gitless-http.test.js
```

结果：107/107 通过，0 失败、0 取消、0 跳过。

#### A 批质量检查

状态：通过（2026-11-17）。仅代表服务端 A 批可进入下一阶段，不代表整体任务完成。

检查中修复：

- 创建命令恢复任务 slug 与活动目录白名单，拒绝路径穿越、反斜杠和
  `.trellis/tasks/archive/**`。
- 相同 task ID 使用不同幂等键再次创建时返回 `TASK_EXISTS`，不重复排队
  创建命令。
- 已有任务上传只保留服务端权威负责人，客户端修改 `task.json.assignee`
  不能再绕过改派；带过期 `taskVersion` 的写入被拒绝。
- 命令成功结果与 `sync_task.materialization_state` 在同一事务提交，任一
  更新失败时命令保持 `running`，不会出现半成功。
- 离线命令只在监听报告和设备心跳均有效时投递，过期监听不会误领命令。
- 项目成员降为 `read_only`、taskSpace 停用或归档后，Agent 不能继续读取
  正文、申请租约或上传。
- 同一执行身份存在多个活动副本时保留身份冲突，不再任意改写已有权威任务
  路径；唯一归档副本会把索引 `task_key` 收敛到归档路径。
- 修复可选路由分组被解码成字符串 `"undefined"` 的问题，任务控制 GET、
  claim、heartbeat 和 release HTTP 路由已纳入真实请求测试。
- 增加 v15 -> v16 权威任务回填测试，验证活动/归档重复身份选择归档最终
  状态并保留 v16 前置备份。

最终聚焦回归：

```powershell
node --test packages/server/test/database.test.js packages/server/test/database-v10.test.js packages/server/test/plugin-store.test.js packages/server/test/team-agent-slot.test.js packages/server/test/team-task-spaces.test.js packages/server/test/team-task-snapshot.test.js packages/server/test/team-task-index-v10.test.js packages/server/test/team-task-commands.test.js packages/server/test/team-task-control.test.js packages/server/test/team-gitless-http.test.js
```

结果：116/116 通过，0 失败、0 取消、0 跳过。所有改动的生产 JS 文件通过
`node --check`，`git diff --check` 通过。仓库当前没有 lint 或独立 typecheck
步骤，未伪造该类通过项。

已知限制：

- 尚未执行真实双客户端 E2E。
- 归档墓碑目前由索引投影收敛验证，尚未完成真实 Git 归档与双客户端联动 E2E。
- pending 操作取消后的权威任务清理由后续策略或显式处理覆盖。
- handoff 清理通知、桌面端轻量备份和本地副本清理尚未实现，继续留在 B2。
- 桌面 B1 已实现控制面消费、claim/heartbeat/release、上传 fencing 和
  archived/reassigned 停写；B2 的自动清理、ACK 和通知尚未实施。
- Web 的离线委派状态、pending 文案和未 materialize 详情属于 C 批，尚未实施。
- 已有权威任务的写入已切换为强制 `taskVersion + leaseToken`；未知本地任务的
  首次上传仍允许由认证用户建立权威记录并获得一次性 lease。
- Board 阶段当前仍来自活动任务文件扫描投影；`sync_task.stage` 已持久化，
  但尚未成为扫描阶段的最终覆盖源，后续控制面批次需要统一该投影。

### B1 批：桌面控制面消费、租约与旧写门禁

状态：代码已收敛，等待有 Rust 工具链的环境补跑桌面单测（2026-11-17）。
本记录不代表整体任务或 B2 完成。

已实现：

- 新增 `task_control.rs`，解析 snapshot `controls`，区分
  `materialized/claimed/pending_delivery/reassigned/archived/handoff_materialized`；
  snapshot 缺少 `controls` 时保留旧服务端兼容路径，字段存在时按权威控制面处理。
- 新增 `task-control-state.json`，按 binding 保存控制状态、`taskVersion` 和
  claim/heartbeat 返回的 lease；logout/换账号清理该文件。pending 上传重试从持久状态
  恢复 lease，失效后再 claim。
- 桌面客户端新增任务 GET、claim、heartbeat、release 调用。Board create/assign
  命令在本地写任务前先 claim 目标任务；未 claim 的 `pending_delivery` 不落盘。
- 已有任务上传从实际 `task.json.id` 得到 executionTaskKey，请求携带当前
  `taskVersion/leaseToken`；服务端缺失字段返回
  `TASK_VERSION_REQUIRED/TASK_LEASE_REQUIRED`，旧版本、归档、改派和租约占用来回均失败关闭。
- 纯删除批次没有 `task.json` 正文时，从持久化控制状态按任务目录恢复
  executionTaskKey，再 heartbeat/claim 并携带 fencing；服务端删除墓碑不再清空既有
  描述和阶段元数据。控制列表不再截断到 200 个本人任务。
- `reassigned/archived` 控制墓碑只释放已知 lease、记录本地状态并停止自动上传；
  本地任务目录和数据保留，不自动备份、删除或通知。

验证结果：

```powershell
node --check packages/server/team/task-control-service.js
node --check packages/server/team/http.js
node --check packages/server/test/team-task-control.test.js
node --check packages/server/test/team-gitless-http.test.js
node --check packages/server/test/team-task-commands.test.js
node --test packages/server/test/database.test.js packages/server/test/database-v10.test.js packages/server/test/team-task-control.test.js packages/server/test/team-task-commands.test.js packages/server/test/team-gitless-http.test.js packages/server/test/team-task-snapshot.test.js packages/server/test/team-task-index-v10.test.js
```

- Node 语法检查：5/5 通过。
- Node 聚焦回归：80/80 通过（数据库迁移、任务控制、任务命令、HTTP、快照和索引）。
- `git diff --check`：通过。
- IDEA MCP 对改动 Rust 文件的 `get_file_problems` / `lint_files`：无错误；
  该结果不能替代 Rust 编译。
- Rust 测试未启动：当前 shell 的 PATH 中没有 `cargo`，常见 Rust 安装目录也未发现
  `cargo.exe`/`rustc.exe`。不能在无工具链情况下伪造 `cargo test` 通过。

### B1 批质量检查（2026-11-17）

- 修复协议 payload 白名单，接收控制面新增的 `taskId` 和 `taskVersion`，避免
  `create_task` 命令在客户端协议校验阶段被丢弃。
- 修复首次本地任务上传：响应 `control` 可能先于本地 `executionTaskKey` 建立，
  现在按 `control.executionTaskKey` 保存同一响应的 lease；新增响应身份一致性校验。
- `create_task` 在服务端只提供 `taskId/taskVersion` 时可由 taskSpace 和 taskId
  派生 executionTaskKey 后 claim；服务端当前同时提供显式字段。
- 控制状态路径拒绝越界目录，lease/taskVersion 采用版本单调更新；控制记录存在但
  服务端 GET 返回缺失时停止自动上传，避免把已存在任务当成首次上传复活。
- 租约被其他客户端占用、改派 `FORBIDDEN`、归档和版本落后均失败关闭；纯删除批次
  仍从持久控制状态恢复 executionTaskKey，并重新 heartbeat/claim 后携带 fencing。
- 剩余验证：真实双客户端 E2E、`cargo test`/桌面构建。

### B2 批：handoff 清理与通知

状态：代码已收敛，仅能以 Node 测试、Web 构建和 IDEA 静态检查判定可进入后续验收；完整 B2
未通过（2026-11-18）。本记录不代表整体任务完成。

已完成：

- creator 收到 `handoff_materialized + source_cleanup_pending` 后，对干净且由 Agent
  管理、未跟踪的活动副本先写轻量备份和审计，再删除。
- dirty/Git tracked 副本保留并记录冲突；清理 ACK 幂等、重启和 ACK 丢失恢复。
- 服务端新增 `POST /api/agent/tasks/:executionTaskKey/handoff-ack`，只允许任务创建者把
  `source_cleanup_pending` 收敛为 `completed` 或 `source_cleanup_conflict`；cleaned 必须携带
  合法 `backupId`、64 位 `manifestSha256`、正文件数和正总字节数。已完成终态重复 ACK 只有全部
  元数据一致才幂等，否则返回 `HANDOFF_ACK_MISMATCH`；审计不包含任务正文、标题或本机路径。
- 本地 `task-control-state.json` schema 版本保持 1，增加 handoff ACK 和通知去重状态。清理前验证
  真实目录、`task.json.id`、cursor baseline 文件集合与摘要、Git 状态全部为 `??`。
- 干净副本复制到 `live-backups/<taskSpaceId>/handoff-<manifestSha256前16位小写hex>`，写入
  `handoff-manifest.json` 和 `handoff-meta.json`；先持久化 cleaned pending ACK，再删除活动目录并 ACK。
  备份上限为 100,000 文件和 64 MiB 规范化文本，超限 ACK `conflict/backup_too_large`。
- 备份写入后回读验证 manifest 摘要、完整文件集合、逐文件摘要和规范化大小、总字节数，以及
  taskSpace、executionTaskKey、taskId、taskDir 和 materialized revision。复制中断或本次新建备份
  验证失败时清理不完整目标。
- dirty、Git tracked、Git 不确定、文件集合或摘要不一致、目录含符号链接/特殊文件/读取失败时
  失败关闭；可分类状态 ACK 对应 conflict，本地检查异常收敛为 `conflict/unknown`，不中断其他任务同步。
- 控制面新增 `leaseHeldByOtherUser`。他人仍有有效租约时不自动删除并 ACK
  `conflict/lease_active`；服务端返回 `HANDOFF_LEASE_HELD` 时同样收敛为冲突。
- cleaned ACK 网络失败保留 pending，后续控制同步、事件触发和重启后重试。重试前重新验证完整备份；
  备份缺失、身份或摘要不一致时改为 `conflict/missing`，不会发送虚假 cleaned。
- 删除前重新校验来源 manifest 与真实 Git 分支，并先把活动目录原子重命名到
  `.trellis/.agent-handoff-cleanup-<uuid>`；后续同步清理遗留暂存目录。
- `task_handoff` 不进入 `ControlHub`，不调用 `focus_main_window`。新增
  `handoff_notice_pending` Tauri 命令、`handoff-control-changed` 事件及
  `packages/web/src/desktop/HandoffNotice.tsx`；Board 可见时显示 Sonner 页内提示，冲突状态保留
  非模态持久页内提示。隐藏或最小化时仅在 WebView 暴露 Web Notification API 且权限已授予时尝试
  系统通知；API、权限或安全上下文不可用时降级为持久页内状态并在恢复可见时补提示。cleaned ACK
  完成后仍可被隐藏页面恢复时读取并补提示，固定卡片只展示冲突和处理中项；普通浏览器无 Tauri
  时静默降级。

验证结果：

```powershell
node --check packages/server/team/task-control-service.js
node --check packages/server/team/http.js
node --check packages/server/test/team-task-control.test.js
node --check packages/server/test/team-gitless-http.test.js
node --test packages/server/test/team-task-control.test.js
node --test packages/server/test/team-gitless-http.test.js
node --test packages/server/test/team-task-control.test.js packages/server/test/team-gitless-http.test.js
$files = Get-ChildItem -LiteralPath 'packages\server\test' -Filter '*.test.js' -File -Recurse
node --test $files.FullName
yarn build
git diff --check
```

- Node 语法检查：4/4 通过。
- Node 聚焦回归：15/15 通过（`team-task-control.test.js` 与 `team-gitless-http.test.js`）。
- 全量服务端测试：502 项中 501 通过、1 跳过、0 失败、0 取消；跳过项为既有平台权限用例。
- Web `yarn build`：通过；Vite 仅报告既有大 chunk 警告，不影响退出码。
- 本任务改动的 10 个 JS/TS 文件通过 `oxfmt --check`。仓库级 `yarn format:check` 仍因
  12 个与本任务无关的既有文件失败，未顺手格式化这些文件。
- IDEA MCP 对 `task_control.rs`、`task_sync.rs`、`agent_service.rs`、`main.rs`、
  `HandoffNotice.tsx`、`BoardPage.tsx` 检查无错误。
- `git diff --check`：通过。

剩余边界：

- 当前 `Cargo.toml` 没有 Tauri notification 依赖；隐藏或最小化时使用 Web Notification API
  尽力通知，权限未授予、局域网非安全上下文或目标 WebView 不暴露 API 时仍只能使用持久页内状态。
  目标 Windows WebView 的系统通知能力尚未真机验证，因此该验收项不能判定完成。
- 当前环境没有 `cargo`、`rustc`、`rustfmt`、`rust-analyzer`，Rust 单测、`cargo fmt --check`、
  `cargo clippy` 和桌面构建未运行。
- 真实双客户端 handoff、Windows 页内/隐藏态通知和桌面安装包 E2E 未运行。

### C 批：Web/Board 控制状态与按需正文

状态：实现完成，待主会话质量检查和真实 E2E（2026-11-18）。本记录不代表整体任务完成。

已完成：

- Team Board 不再把“监听到在线客户端”作为创建或改派的前置条件；前端只在任务空间停用或
  账号只读时提前阻止，可写成员与最终权限继续由服务端校验。离线目标显示待交付并允许排队。
- 任务查询投影补充 `materializationState`、`controlTaskVersion`、`handoffState`、
  `leaseStatus`、`leaseExpiresAt`、`previousAssigneeUserId` 和身份冲突信息。最新租约从
  `sync_task_lease` 读取，因此 `expireLeases()` 清空 `sync_task.lease_id` 后仍能显示过期状态。
- `claim`、`release` 和 `handoff-ack` 改变控制面后推进查询 revision 并发布 Board
  `tasks.changed`，已打开的 Board 会重新查询 REST 投影。
- 看板卡片、团队表格和详情显示 `pending_delivery`、`claimed`、`materialized`、
  `lease_expired`、`version_stale`、迁移冲突、改派和 handoff 等控制状态；未知状态保留
  “状态未知”兜底，且不宣称正文已落地。
- 未 materialize 的任务详情跳过 `/api/task`，不读取、不渲染不存在的正文、阶段证据、依赖和产物；
  仍显示服务端元数据、控制状态和负责人改派。任务转为待接管时会清除此前已缓存的正文详情，
  已 materialize 的详情则保留 Board 行上的权威控制字段。
- 创建、派发和操作列表文案改为目标客户端离线也可排队；归档/改派提示说明旧负责人本地副本
  可能保留、进入受保护清理，或因被 Git 跟踪而需要手工处理。
- 没有控制字段的 standalone/旧 Team 数据继续按正文可用兼容；普通浏览器不会触发客户端本地写入。

验证结果：

```powershell
node --test packages/web/test/team-web.test.js
node --test packages/server/test/team-task-index-v10.test.js
node --test packages/server/test/team-gitless-http.test.js
node --test packages/server/test/database.test.js
node --test packages/server/test/database-v10.test.js
node --check packages/web/src/lib/team-client.js
node --check packages/server/database.js
node --check packages/server/team/http.js
node --check packages/server/team/task-space-index.js
$files = Get-ChildItem -LiteralPath 'packages\server\test' -Filter '*.test.js' -File -Recurse
node --test $files.FullName
$files = Get-ChildItem -LiteralPath 'packages\web\test' -Filter '*.test.js' -File -Recurse
node --test $files.FullName
yarn workspace @trellis-board/web build
git diff --check
```

- Web 纯逻辑测试：27/27 通过。
- 任务索引回归：19/19 通过，覆盖 `lease_id` 清空后从最新租约投影 `expired`。
- Team HTTP 回归：4/4 通过，覆盖离线创建 pending 可查询、claim 后状态更新且查询版本推进。
- 数据库迁移回归：`database.test.js` 12/12、`database-v10.test.js` 6/6 通过。
- 4 个改动的生产 JS 文件通过 `node --check`。
- 服务端全量测试：503 项中 502 通过、1 跳过、0 失败、0 取消；跳过项为既有平台权限用例。
- Web 全量测试：85 项中 84 通过、1 失败；失败项为 `markdown.test.js` 对 highlight.js
  `language-js` 类名的既有期望不一致，本任务未修改 Markdown/highlight 文件。
- 除 `TaskDetailDialog.tsx` 外，本批其余 16 个 JS/TS/TSX 文件通过 `oxfmt --check`。
  `TaskDetailDialog.tsx` 保留基线格式以避开约 600 行无关缩进重排；该文件通过 TypeScript
  构建和 IDEA 错误级检查，但单文件 `oxfmt --check` 仍会报告既有格式差异。
- IDEA MCP 错误级检查无错误；`git diff --check` 通过。
- `yarn workspace @trellis-board/web build` 通过；Vite 仅报告既有大 chunk 警告。

剩余边界：

- 当前没有 Tauri notification 依赖；隐藏或最小化时已尝试 Web Notification API，但权限、
  安全上下文和目标 WebView 支持情况尚未真机验证，该项继续保持为 B2 未完成边界。
- 当前环境没有 Rust 工具链，`cargo test`、`cargo fmt --check`、`cargo clippy` 和桌面构建未运行。
- 真实双客户端离线创建、claim、租约过期、改派和归档清理 E2E 未运行。
- Web 全量测试中的 Markdown highlight 类名失败属于本任务外的既有测试/实现漂移，未在本批修复。
- 本批未提交、未推送、未归档任务。

### 最终全范围检查（2026-11-18）

- 修复 handoff 通知去重键，改为 `executionTaskKey + handoffState + outcome`，同一任务从处理中进入
  conflict 或 cleaned 时不会再被误判为重复。
- 最终 Web 构建通过；`team-web.test.js` 27/27 通过；`git diff --check` 通过。
- 最新服务端全量回归 503 项中 502 通过、1 跳过、0 失败；Web 全量 85 项中 84 通过，唯一失败仍是
  与本任务文件无关的既有 highlight.js 类名期望。
- IDEA `build_project` 返回成功且无问题，但当前 IDEA 项目仅有 `JAVA_MODULE`，不能据此证明 Rust
  已编译。当前 PATH 和常见安装目录仍无 `cargo`/`rustc`，因此 `cargo test`、`cargo fmt --check`、
  `cargo clippy` 与完整桌面构建仍未执行。
- 真实双客户端 E2E、Windows 隐藏/最小化系统通知和桌面安装包验收仍未执行。因此本任务继续保持
  `in_progress`，不能进入提交/归档阶段，也不能宣称整体完成。

### 真实 E2E 修复闭环（2026-11-18）

状态：由当前单客户端环境完成的控制面创建链路已通过。第二账号 handoff、Windows 隐藏态通知和
真实 Git 归档清理仍是未覆盖边界。

真实 E2E 发现并修复：

- Agent SSE command 的标准命令位于 `payload.command`，旧 Rust 客户端只读取顶层字段，导致命令停在
  `delivered`。客户端优先读取嵌套字段并兼容旧顶层字段；兼容期服务端同时发送两种形状。
- 内容 revision 未变化时，负责人等控制字段变化不会触发任务索引重投影。现以权威任务指纹参与
  no-op、增量缓存和持久投影判断。
- 内容上传阶段仅按“创建者 ≠ 负责人”提前写 `source_cleanup_pending`，导致跨用户
  `create_task` 被误判为来源副本交接。现在只有 `assign_task` 在命令结果和索引校验完成后进入
  来源清理，`create_task` 成功保持 `handoff_state=none`。
- 命令完成后新增向后兼容的 `control.changed` SSE 失效事件，创建者无需等待无关任务变化即可拉取
  最新控制状态；旧客户端忽略未知事件。

真实创建链路：

```text
taskId: e2e-create-control-fixed-20261118
commandId: 1adfbfcd-e97e-4ed6-9dd7-f0b25ea4df3b
revision: 541
```

- `/start`、`/claim`、`/changes`、`/result` 均返回 200。
- 命令最终 `succeeded`，任务 `materialized_revision=541`，Board 索引负责人为 `yhj`。
- 数据库 `materialization_state=materialized`、`handoff_state=none`。
- Board 显示“任务已落地”，操作显示“任务文件已同步并由服务端索引成功”。

清理：

- 探针正文先移动到 `%TEMP%` 可恢复备份。
- watcher 在 revision 542 写入 4 条删除墓碑，Board 与索引移除探针。
- 清理前生成 79,753,216 字节独立数据库备份。
- 单事务精确删除 3 个探针任务、6 个租约、4 条命令、12 个文件墓碑、34 条文件审计和 10 个批次；
  清理后全部计数为 0。

最终验证：

```text
yarn test
643 tests / 642 passed / 1 skipped / 0 failed

yarn build
yarn build:desktop
git diff --check
```

- Web 构建与桌面 UI 构建通过；仅有既有大 chunk 和 `theme-init.js` 非 module 提示。
- 当前 Windows 环境仍无 Rust 工具链；Rust 单测和桌面客户端打包由 GitHub `windows.yml` 真实执行。
- 双账号 handoff、隐藏/最小化系统通知和真实 Git 归档清理仍不能在本机单客户端环境完成，不能标记为
  已通过。
