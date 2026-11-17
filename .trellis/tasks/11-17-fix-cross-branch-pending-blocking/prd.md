# 修复活动任务同步阻塞并增加项目级待归属收件箱

## Goal

修复同一 taskSpace 中两个会共同造成活动任务漏同步的问题：

- 待归属、错分支或暂时不可同步的 pending 只能暂停自己的任务，不能阻塞其他任务上传。
- 上传成功只能证明服务端产生了新 revision，不能把本地 cursor 当成已经应用了中间 revision；
  客户端必须从上次完整应用的位置补拉，避免跨客户端变更被永久跳过。

升级后还必须安全修复已经形成的 revision 空洞，让本地存在但服务端缺失的活动任务重新收敛，
同时不静默删除本地任务正文。

空分支/待归属任务还必须持续出现在服务端 Board 的项目视图中，不能只有已关联的桌面客户端
才能看到；展示必须明确区别于正常分支任务，避免把“尚未确定归属”误显示成某个 Git 分支上的任务。

## Background / Confirmed Facts

- 每个 taskSpace 的客户端 cursor 只有一个 `pending: PendingBatch` 槽位；
  `packages/desktop/src-tauri/src/agent/task_sync.rs` 的 `Cursor` 定义。
- `upload_directories()` 每次上传前先重试这个 pending；重试结果为 `skipped` 时直接返回，
  不再处理本次请求中的其他任务。
- `upload_batch()` 会先比较持久化 pending 中的 `task.json.branch` 与当前本地文件；
  两者不同返回 `TASK_OWNERSHIP_PENDING_MISMATCH`；
  `packages/desktop/src-tauri/src/agent/task_sync.rs` 的 `upload_batch()`。
- 上述本地比较破坏了 pending 原样重放：pending 是不可变快照，当前本地文件变化后仍应先发送原批次，
  由服务端幂等重放或按原内容拒绝，不能用当前文件阻断原批次的恢复。
- 当前真实环境中，`trellis-board/main` 的 cursor 从
  `2026-11-17T08:52:29.033Z` 起保留 pending batch
  `a9bac4cb-2b73-4746-bacd-a8786f7eeef8`，其中包含
  `.trellis/tasks/11-17-http-archive-sync`；该任务 `branch=null`、
  `base_branch=team-board`，并持续超过 10 分钟未完成。
- watcher 路径不会丢失：客户端约 `2.439s` 扫到了新任务，阻塞发生在 cursor pending
  重试后的提前返回，不在文件监听或归档扫描。
- 当前客户端已不扫描 `.trellis/tasks/archive/**`；本问题与归档全量扫描无关。
- 归档历史任务 `11-12-fix-cross-branch-task-sync-conflict-flood` 已建立任务级分支门禁、
  服务端二次校验、`ownershipPending`/paused 状态和冲突阻断；本任务不重新设计这些规则。
- 网络失败或响应丢失时，pending 不能直接删除：如果服务端已提交但响应丢失，原
  `batchId/clientSequence/files/mergeEvidence` 是幂等恢复依据。
- 服务端返回明确的待归属、分支不匹配、基线和合入证据错误时，代表原批次没有被接受；
  此时可以清除活动 pending，只保留有上限、可诊断的摘要，不需要长期保留整批正文副本。
- `task.py create` 会明确写入 `branch: null`；
  `.trellis/scripts/common/task_store.py:542`。
- `task.py start` 才在 `branch` 为空时记录当前检出分支；
  `.trellis/scripts/task.py:116`。
- 从 Board 创建的 Agent 任务会在创建后立即执行 `task.py set-branch`，
  因此正常看板创建路径不会留下空分支；
  `packages/desktop/src-tauri/src/agent/task_command.rs`。
- 当前 0.4.31 的 ProjectRail 只汇总“明确属于其他分支”的 paused 目录和
  cursor 中的 `ownershipPending`；config `pending` 里的空分支任务不会进入这两个统计，
  所以用户实际看到项目仍是“同步正常”；
  `packages/desktop/src-tauri/src/agent/device.rs`、
  `packages/web/src/components/layout/ProjectRail.tsx`。
- Board 页面读取服务端任务索引；未上传的本地任务不会出现在普通分支看板或归档索引中。
  在用户只依赖 Board 观察任务的情况下，空分支任务可能长期不可见，直到被手动归属。
- 服务端任务查询按可读 taskSpace 集合取 `sync_task_index`，索引里的 `branch_name`
  当前来自所属 taskSpace，而不是 `task.json.branch`；
  `packages/server/team/task-space-index.js`。
- 服务端快照写入会拒绝 `task.json.branch` 为空的任务；
  `packages/server/team/task-snapshot-service.js`。
- 客户端在能够从项目 taskSpace 或已有任务声明中唯一推断分支时会自动补写 `task.json.branch`；
  无法唯一推断时进入 `TASK_OWNERSHIP_REQUIRED`，该任务不会上传到任何分支 taskSpace；
  `packages/desktop/src-tauri/src/agent/task_sync.rs` 的 ownership 分类逻辑。
- 因此“服务端项目级待归属视图”不能简单依赖现有分支看板查询，需要单独承接尚未确定归属的任务，
  同时保持它们不属于任何分支 taskSpace、不能参与分支 ownership 或合入证据判定。
- 2026-11-17 现场共有 6 个活动任务目录，服务端 `sync_task_index` 只有 3 个：
  `11-17-archive-local-snapshot-read`、`11-17-fix-archive-filter-listener-dev-id`、
  `11-17-in-window-task-sync-dialog`。
- 漏掉的 3 个任务并非都因分支过滤：
  - `11-17-http-archive-sync`：旧 pending 的 `branch=null` 与当前本地 `branch=main`
    不一致，触发 `TASK_OWNERSHIP_PENDING_MISMATCH`，并提前终止上传。
  - `11-17-fix-cross-branch-pending-blocking`：在该 pending 之后创建，被同一提前返回阻塞。
  - `11-17-desktop-log-timestamp-format`：服务端在 revision 443 删除该任务，
    但客户端 cursor 仍保留其 4 个文件基线，导致后续差异判断误以为服务端已有这些文件。
- 当前 taskSpace 同时有两个活动客户端：
  `yhj/Z0198-YHJ-E` 与 `fenglei/Z0314-FL-E`。服务端审计显示：
  `fenglei` 在 `2026-11-17T01:53:51.827Z` 以 revision 443 删除
  `11-17-desktop-log-timestamp-format`；`yhj` 于 `01:53:57.451Z`
  以 revision 444 上传自己的批次。客户端随后直接把本地 revision 写到 444，
  没有先应用 revision 443 的跨客户端删除事件。
- 客户端上传成功后会直接把返回的服务端 `revision` 写入 cursor；
  `packages/desktop/src-tauri/src/agent/task_sync.rs` 的 `upload_batch()`。
  后续拉取只请求 `revision > cursor.revision` 的变更；
  `packages/desktop/src-tauri/src/agent/task_sync.rs`、
  `packages/server/team/task-snapshot-service.js`。
  因此 revision 443 被直接跳过，旧基线永久残留，直到强制全量对账或该任务再次发生本地变更。
- 当前服务端已存在基于 `sync_task` / `sync_task_lease` 的任务控制面，负责分支任务认领、
  lease、改派、handoff 和写入门禁；项目级待归属摘要不能复用或伪装成该权威任务行，
  也不能绕过 `claim/lease/taskVersion` 契约。
- `revision` 必须恢复为“本地已经完整应用的最高服务端 revision”，不能混用为
  “本客户端最近一次上传产生的 revision”。否则两个客户端交错写入时必然存在 revision 空洞。
- 已升级但受旧缺陷影响的 cursor 没有可证明的“最后完整应用 revision”。需要一次性安全基线修复：
  用 full snapshot 重建服务端基线，下载 server-only 任务；本地有而服务端没有的活动任务作为
  local-only 重新上传。服务端-only 的远端删除事件与历史 local-only 任务无法可靠区分，
  修复策略选择保留并重新同步本地任务，避免静默删除数据。

## Requirements

### R1 pending 原样幂等重放

- 活动 pending 必须始终优先按原 `batchId/clientSequence/files/mergeEvidence` 发送；
  不得用当前本地文件替换 pending，也不得因为当前本地 branch 变化而在发请求前拒绝重放。
- 服务端要求抬高 `clientSequence` 时，继续执行现有的一次性恢复逻辑，并保持文件数组不变。
- 服务端成功重放时清除 pending、推进本地 sequence 和已确认文件基线，但不得推进已应用 revision。

### R2 阻断只影响所属任务

- pending 重放收到明确的 `TASK_OWNERSHIP_REQUIRED`、`TASK_OWNERSHIP_MISMATCH`、
  `TASK_MERGE_EVIDENCE_REQUIRED`、`TASK_MERGE_EVIDENCE_INVALID` 或
  `TASK_OWNED_BY_BASELINE` 时，清除活动 pending，并写入该 taskDir 的有界诊断摘要后继续处理其他任务。
- 网络错误、超时、服务端暂不可达和未知失败必须保留原 pending，失败关闭，不得猜测服务端未接受。
- `TASK_FILE_CONFLICT` 继续进入现有服务端冲突和 `conflictBlocked` 流程。
- 不再为已明确拒绝的 pending 长期保留完整 `files` 副本；诊断只记录
  `batchId/clientSequence/taskDir/reason/createdAt/blockedAt`，防止 cursor 无限膨胀。

### R3 revision 只表示已应用位置

- 上传成功只更新 sequence 和 baselines；`cursor.revision` 只能由完整 pull/apply 成功路径推进。
- 在 revision R 上传并得到 R+N 后，只要中间 revision 尚未应用，cursor 仍保持 R；
  下一次 pull 必须从 R 之后读取并应用墓碑和其他客户端的变更。
- `task.changed` SSE、watcher reconcile、启动补拉和显式同步继续复用现有短路规则，但必须使用
  “已应用 revision”，不能使用上传应答 revision 冒充已应用位置。

### R4 旧 cursor 一次性安全修复

- cursor v3 新增向后兼容的 `revisionGuardVersion`；缺失或小于 1 时，在首次运行执行一次 full snapshot
  基线修复，成功后写为 1。
- 修复必须下载 server-only 任务、保留并重新上传 local-only 任务；内容冲突由现有 CAS 转为冲突确认，
  不得静默覆盖任一侧。
- 修复期间不得删除本地活动任务；历史跨客户端删除若只看 full snapshot 无法区分，按 local-only 重新同步，
  以保证数据完整优先。
- 新接入绑定完成首次同步时直接写入当前 guard 版本，后续正常启动不重复 full snapshot。

### R5 保持一致性门禁

- 可同步任务仍必须经过 task-level ownership、真实检出分支、文件级 CAS、冲突阻断、
  pending 原样重放和服务端最终校验。
- 不得通过清空 pending、删除本地任务或跳过 ownership/CAS 来绕过阻塞。
- 不修改服务端任务快照协议；新增 cursor 字段必须向后兼容，不能要求升级服务端才能恢复活动任务同步。

### R6 可观测状态

- 项目/分支同步状态必须能区分“同步正常”“pending 等待重试”“跨分支任务暂停”、
  “待确认归属”和“冲突待处理”，不能在用户侧统一显示为“同步正常”。
- 诊断信息至少包含 taskSpace、taskDir、原因、pending 创建时间和最近重试状态；
  不输出任务正文、Token、Cookie 或私钥。

### R7 服务端项目级待归属视图

- 无法唯一确定分支归属的活动任务必须进入服务端 Board 的项目级“待归属”集合，
  只看网页端、没有打开桌面客户端的项目成员也能持续看到。
- 待归属任务不属于任何 Git 分支 taskSpace；不得把 taskSpace 分支冒充成任务分支，
  也不得让其参与分支 ownership、合并证据或普通分支看板统计。
- 项目级视图至少显示任务标题、项目、任务目录、最近发现时间、来源客户端/来源分支（若可获得）
  和待归属原因，并提供明确的状态标识“待归属”。
- 项目导航必须显示待归属数量警示；即使当前选择了具体分支或搜索过滤后列表为空，
  项目级待归属数量也不能被静默隐藏。
- 任务补齐分支归属并完成正常同步后，必须从待归属集合移除，只在对应分支看板保留一份。
- 首版服务端只保存并展示有界摘要：任务 ID、标题、项目、任务目录、来源客户端、来源分支
  （若可获得）、最近发现时间和待归属原因；完整正文与附件仍以本地任务文件和正常 taskSpace
  快照为准。
- 首版网页端负责发现和定位，不在服务端直接下发跨分支归属命令；分支归属仍由已关联客户端完成。
- 项目导航使用双层入口，不新增顶部一级导航：
  - 选中具体项目时，在项目名下方、分支列表上方固定显示“待归属任务 N”；
    数量大于 0 时使用黄色警示，数量为 0 时保留灰色入口。
  - “全部项目”范围中，只在有待归属任务的项目行显示黄色数量徽标。
  - 主内容区在筛选栏下方、流程指标和看板上方显示不可被分支筛选或搜索隐藏的警示条；
    点击左侧入口或警示条都展开同一个项目级待归属列表。
- 项目级待归属列表与桌面分支级“待确认归属”动作分工：
  - 项目级列表由服务端摘要驱动，供所有 Board 用户查看和定位；
  - 分支级列表继续由已关联客户端驱动，负责执行 `task.py set-branch` 等归属动作。

## Acceptance Criteria

- [ ] 已有 `branch=null` pending 时，客户端先原样重放；服务端明确拒绝后不阻塞后续
      `branch=main` 任务上传。
- [ ] 上述新任务在看板可见，旧 pending 的拒绝原因在客户端可诊断，不再显示为“同步正常”。
- [ ] `branch=null` 且无法唯一推断归属的任务持续出现在服务端 Board 的项目级待归属视图，
      不要求用户先打开桌面客户端或先选择某个分支才能发现它。
- [ ] 待归属任务不会出现在普通分支统计中，也不会计入任何 taskSpace 的 ownership/合入证据。
- [ ] 项目导航显示待归属数量；清零后警示消失，任务归属并同步后只在目标分支保留一份。
- [ ] 选中项目时，项目名下方固定显示“待归属任务 N”；选择“全部项目”时，仅对有待归属
      任务的项目行显示数量徽标。
- [ ] 主内容区的待归属警示条位于筛选栏下方、看板上方，选择具体分支或执行搜索都不能隐藏
      项目级数量；点击左侧入口和警示条进入同一待归属列表。
- [ ] 没有待归属任务时，左侧入口灰显为 0，主内容区警示条隐藏。
- [ ] 首版待归属条目只包含有界摘要，不复制完整正文或附件；网页端不直接修改任务分支。
- [ ] pending 在不确定失败后保留原 batch ID、序列和文件内容；明确拒绝后只保留有界摘要。
- [ ] 客户端重开、服务端 restart、网络恢复后，活动任务上传和旧 pending 状态均可恢复。
- [ ] 将阻塞任务归属修正后，可以从当前本地快照创建新批次；不会误重放已明确拒绝的旧内容。
- [ ] 阻塞任务继续属于其他分支时，不向当前 taskSpace 写入该任务，也不产生新的冲突洪泛。
- [ ] 客户端在 revision R 上传拿到 R+N 时不把 cursor 推进到 R+N；随后 pull 能从 R 开始取得
      其他客户端在中间 revision 写入的墓碑和更新。
- [ ] 旧 cursor 首次运行一次性修复后，`11-17-desktop-log-timestamp-format` 这类
      本地存在、服务端 revision 已越过删除事件的任务重新上传并在 Board 可见。
- [ ] 一次性修复不删除任何本地活动任务；server-only 任务下载后读取一致。
- [ ] `revisionGuardVersion=1` 后再次启动不重复 full snapshot；普通增量 pull 仍保持低成本。
- [ ] Rust 单元测试覆盖：pending 原样重放、明确拒绝后继续、网络失败保留、revision 不跳跃、
      cursor 空洞修复、本地任务保留、重启恢复和旧 cursor 兼容。
- [ ] 服务端测试覆盖两个 Agent 在相邻 revision 写入/删除时，客户端按已应用 revision 可取得完整当前状态。
- [ ] 服务端测试覆盖 inbox upsert/delete 幂等、同一任务多来源聚合、200 项上限、项目权限、
      正常任务接入后同事务清理摘要，以及摘要接口失败不影响普通任务快照。
- [ ] Web 测试覆盖项目级数量、左侧固定入口、全部项目徽标、不可被筛选隐藏的警示条、
      同一展开状态、分页隔离、空状态和可访问性。
- [ ] 真实 E2E 覆盖：制造跨客户端 revision 交错和阻塞 pending，确认其他当前分支任务自动出现在 Board；
      待归属摘要同时出现在左侧入口和主内容区，归属后消失；重启桌面客户端后不重复全量修复；
      清理测试数据后活动索引和项目计数消失。

## Out of Scope

- 不优化服务端归档 Git 的全量对象读取或 51 秒级后台同步耗时。
- 不改变任务分支唯一性推断、服务端 ownership API、CAS 或冲突合并规则。
- 不自动删除或物理迁移其他分支上的任务目录。
- 不在本任务中处理历史冲突数据批量清理。
- 不保证区分“旧 revision 空洞期间被远端删除、但本地仍保留”的活动任务；
  一次性修复选择保留本地并重新同步，可能恢复远端曾删除的任务。

## Notes

- 关联任务：
  `.trellis/tasks/11-17-in-window-task-sync-dialog`（同步确认交互）、
  `.trellis/tasks/archive/2026-11/11-12-fix-cross-branch-task-sync-conflict-flood`
  （任务级分支门禁）。
- 本任务当前只完成需求收敛，尚未运行 `task.py start`，也未修改产品代码。
