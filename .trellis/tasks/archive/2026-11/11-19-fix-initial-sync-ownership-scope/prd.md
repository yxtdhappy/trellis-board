# 首同步差异复用接入后归属范围，并让「稍后处理」生效、弹窗显示项目、自动提示不再抢焦点

## Goal

首同步在分类差异之前，复用「接入后同步」已有的任务归属闸门：服务端按负责人裁剪、客户端只能读本人任务的目录，不再被首同步判成「仅本地存在」并弹窗拦截；真实的本地新增任务仍然照旧被 review 拦截。同时修掉三个现场问题：点「稍后处理」后不再每轮自动重弹（同内容记忆，内容变化或手动唤回才重展示），弹窗明确显示所属项目名与分支，自动流程不再强制把主窗口抢到前台而是发系统通知。

## 背景

- 现场复现：flyfly6 接入 trellis-board（taskSpace `3536a478-4b1b-4b3b-a8f0-42903482d33d`，binding `c9d58d07-9929-46fb-a74a-c4a108535582`，`initialSyncMode=review`）。首次同步弹「任务差异需要确认」，三条差异全部是「仅本地存在」：11-17-fix-cross-branch-pending-blocking、11-17-multi-client-task-sync-control-plane、11-19-witops-trellis-task-test。
- 这三条在服务端的负责人是 yhj / kyf，没有一条属于 flyfly6（项目成员表把 trellis dev id `flyfly6` 映射到 userId `567875d6-6515-4a22-9cbd-619027312a97`）。
- 机制：服务端快照按 `visibleTaskIds`（`assignee_user_id = agent.userId`）裁剪任务文件，`controlsForAgent` 返回权威空数组；客户端首同步因此拿不到任何服务端任务组，本地三个目录全部落到 `DiffKind::LocalOnly`，review 模式直接 `pendingReview: true` 并停止。实测后果：`initialSyncCompleted=false`、`initialReviewPending=true`、`live-cursors.json` 空、`lastSyncedAt=null`，同步循环永远停在 `syncing`。
- 与接入后同步不一致：常态同步遇到他人任务目录时，`fetch_directory` 会拿到 403 `FORBIDDEN`/`TASK_WRITE_FORBIDDEN`，客户端 `mark_readonly_dir(FOREIGN_OWNER)` 后打日志「跳过他人任务目录（只读镜像）」，不产生差异、不阻塞用户（`pull.rs:458-475`、`upload.rs:160-180`）。首同步缺少这同一道闸门。
- 同一缺陷的第二个症状（用户 m00404 报告）：点「稍后处理」关掉弹窗后，每隔一段时间又自动弹出。链路：`pull.rs:368` 每轮同步都因 `initial_sync_completed=false` 调用 `pull_initial_sync` → review 分支重新 `emit_differences`（`initial_sync.rs:275-287`）→ `agent_service.rs:311-322 publish_control` 对 review 类型在内容变化时强制 `focus_main_window` 并 notify → `control.rs:123-136 dismiss_with_change` 只把队列项 pop 掉、没有任何“已稍后处理”的记忆 → Web 端 `live_control_pending` 轮询（10s 兜底 + `live-control-changed`）再次读到并入弹窗。
- 同一缺陷的第三个症状（用户 m00473 报告）：弹窗只显示「任务空间」UUID（`LiveSyncControlDialog.tsx:663-666`），看不到是哪个项目。`task_sync_error` 事件已带 `projectName`/`branchName`（`errors.rs:9-24`），首同步 review 事件却没带，导致用户无法判断该不该处理。
- 第四个症状（用户 m00571 报告）：自动流程强制抢焦点。`agent_service.rs:312` 对 review 类型每次内容变化都调 `focus_main_window`（`main.rs:894-900`：`show` + `unminimize` + `set_focus`），`:320` 对其他类型每进程首次也调一次；用户在别的窗口干活时被直接顶掉。

## User Flow

1. 用户在向导里选择「逐项确认」（review）并接入项目。
2. 首同步扫描本地任务目录，先按归属闸门把「服务端存在但不可读（他人负责）」的目录标记为只读镜像。
3. 剩余目录才参与差异分类：
   - 有真实差异（本人任务内容冲突、本人任务仅在服务端、真正的本地新任务）→ 弹「任务差异需要确认」，标题区显示项目名与分支，行为不变。
   - 没有真实差异 → 首同步自动完成，写入 cursor 与 `initialSyncCompleted`，进入常态同步。
4. 被标记的他人任务目录在任务列表里显示为只读镜像，不参与上传，也不进待归属收件箱。

## Requirements

- **R1 归属闸门前置**：首同步在 `classify_task_snapshots` 之前，对每个本地候选目录用与常态同步相同的探针判定服务端归属：
  - 403 `FORBIDDEN` / `TASK_WRITE_FORBIDDEN` → 写入 `readonly_task_dirs`（原因 `FOREIGN_OWNER:<assignee>`），不进入差异集合。
  - 409 `TASK_ARCHIVED` / `ARCHIVE_SYNC_SERVER_MANAGED` → 按归档残留处理，不进入差异集合。
  - 404 `NOT_FOUND` → 视为真正的本地新增任务，保留为 `LocalOnly` 差异。
- **R2 入口一致**：所有首同步分类入口（review / bootstrap / safe 三种模式，以及首同步重试与修订守卫路径）都经过同一个 helper，不允许只修一条路径。
- **R3 只读镜像不回流**：被标记的目录不出现在上传队列、`deferred` 记录、待归属收件箱与“待同步”角标。
- **R4 只对真实差异拦截**：review 模式的拦截条件保持“存在非 `Same` 的真实差异”；若差异只剩他人任务目录，首同步必须自行完成（`initialSyncCompleted=true`、写入 revision、`lastSyncedAt` 有值）。
- **R5 不误吞**：探针遇到网络错误、5xx、超时等非归属类错误时，不得标记只读、不得丢弃差异，保持首同步待确认并允许下次重试。
- **R6 不动服务端裁剪语义**：服务端继续只下发本人任务内容与本人控制信息；本次只让客户端识别“服务端隐藏但确实存在”的目录。
- **R7 可诊断**：跳过他人任务目录时输出一条 warn 日志，含任务目录与原因，便于现场排查。
- **R8 稍后处理必须真正生效**：用户点「稍后处理」关闭「任务差异需要确认」后，只要同一任务空间的首同步差异内容没变（忽略 `revision`），本次应用运行期间不再自动弹出，也不再抢焦点。现状是每个同步周期（约 60s）重新 emit、hub 重新入队、Web 轮询重新打开。
- **R9 可手动唤回**：ProjectRail 的 `live_control_show` 入口在被稍后处理后仍然能重新展示该差异，不因为去重而变成“没有等待确认的任务差异”。
- **R10 内容变化必须重新提示**：差异集合变化（任务目录增删、`kind` 变化）时重新弹出并聚焦一次；仅 `revision` 推进不算变化。
- **R11 生命周期**：记忆只存在进程内存，应用重启后允许再提示一次；首同步完成或被用户实际处理（`live_control_initial`）后清空，避免残留压制后续真实差异。
- **R12 弹窗显示所属项目**：「任务差异需要确认」必须让人一眼看出是哪个项目的任务，展示项目名与分支；只给任务空间 UUID 不算可识别信息。项目名取绑定上的 `displayName`（服务端项目名，回退仓库名），分支取 `binding.branchName`。
- **R13 不再强制抢焦点**：所有由自动流程触发的控制弹窗（`initial_sync_review`、`task_file_conflict`、`task_ownership_review`、`task_sync_error` 等经 `publish_control` 发布的类型）不再调用 `focus_main_window`，改为发一条系统通知（`tauri-plugin-notification`），由用户决定是否点开。判定口径：
  - 用户主动触发的入口（ProjectRail「查看任务差异」→ `live_control_show` → `show_pending_control`）保持聚焦，因为那是用户点击造成的。
  - 托盘/单实例唤醒、更新通知等非弹窗场景保持现状，不在本次范围。
  - 通知正文必须带项目名与分支（沿用 R12 的 `projectName`/`branchName`），review 与 ownership 带条目数，冲突带任务标题。
- **R14 点击通知回窗口**：点系统通知（`action_id == "tap"`）后主窗口获得焦点（`focus_main_window`）。由主进程注册一个无条件生效的 `on_action` 处理器，所有通知类型共用；点击不自动打开具体任务或对话框。
- **R15 同步通知三档设置**：偏好设置提供「从不 / 仅在未聚焦时 / 始终」三选一，默认「始终」（= 保持现状）。取值 `never` | `unfocused` | `always`，与外观偏好同存于设备级 `appearance.json`（字段 `notifyMode`），主进程发通知前读取：
  - `never` → 不发任何同步通知（应用内弹窗与角标照旧）。
  - `unfocused` → 仅当主窗口未聚焦时发（`is_focused()` 返回 `Err` 或无窗口按未聚焦）。
  - `always` → 每次都发。

## Non-goals

- 不改通知点击后的应用内跳转语义（点通知聚焦主窗口即可，不自动打开具体任务）。
- 不做按通知类型分别开关、免打扰时段、通知音等其它通知设置。
- 不改变服务端控制面语义，不给客户端下发他人任务内容或完整控制记录。
- 不依据 `task.json` 的 `assignee` 字段自行推断归属（不是权威来源，改派后不可信）。
- 不重做 review / safe / bootstrap 三种模式的用户可见语义。
- 不重设计跨分支差异语义（由 11-17-multi-client-task-sync-control-plane 负责），本次只保证首同步与接入后同步口径一致。
- 不涉及归档任务的归档/清理流程改动。

## Acceptance Criteria

- [ ] 用本机真实绑定（flyfly6，binding `c9d58d07-9929-46fb-a74a-c4a108535582`）重新首同步：不再弹出「任务差异需要确认」；三个他人任务目录写入 `readonly_task_dirs`（`FOREIGN_OWNER:*`）；`initialSyncCompleted=true`；`live-cursors.json` 中出现该任务空间的 revision；`lastSyncedAt` 非空。
- [ ] 手工新建一个仅本地存在、服务端 404 的任务目录后重新首同步：该目录仍以 `LocalOnly` 差异出现并触发 review 弹窗。
- [ ] 服务端返回 409 归档残留的目录不产生差异，也不阻塞首同步。
- [ ] 模拟网络/5xx 失败时，不写只读标记，差异保留并可重试。
- [ ] 首同步存在真实差异时点「稍后处理」：连续 3 个同步周期（约 3 分钟）内不再自动弹窗、不再抢焦点；同步周期数由日志/单测确认。
- [ ] 稍后处理后差异内容变化（例如本地新增一个任务目录）→ 弹窗重新出现一次。
- [ ] 稍后处理后点击 ProjectRail 的「查看任务差异」（`live_control_show`）→ 弹窗重新出现。
- [ ] 首同步完成后（`initialSyncCompleted=true`）不再有被压制的残留差异记录；应用重启后可再提示一次。
- [ ] 「任务差异需要确认」弹窗显示项目名与分支（紧凑态与展开态都能看到）；旧客户端未带项目字段时回退显示任务空间 ID，不出现空白。
- [ ] 首同步触发 review 时不抢焦点：焦点在其他窗口时只收到系统通知，主窗口不被 `show/unminimize/set_focus`。
- [ ] 通知正文含项目名与分支；点击通知后主窗口获得焦点，且不会误开「更新」对话框。
- [ ] 偏好设置「同步通知」三选项（从不 / 仅在未聚焦时 / 始终）默认「始终」：「始终」时窗口前台也发通知；「仅在未聚焦时」前台不发、失焦发；「从不」任何情况都不发，但应用内弹窗仍照常出现。切换后重启客户端仍生效（读写 `appearance.json` 的 `notifyMode`）。
- [ ] 旧版 Web 端调用 `appearance_save` 不带 `notifyMode` 时，不会清掉已保存的取值（非法值回退 `always`）。
- [ ] ProjectRail「查看任务差异」仍会聚焦主窗口（用户主动操作）。
- [ ] 单元测试覆盖 403 / 409 / 404 三条分支，以及“他人目录被跳过 + 真实本地任务被保留”的组合场景；通知文案构造有纯函数单测。
- [ ] `cargo test` 中 task_sync 相关测试全绿；`yarn test`（`node --test packages/*/test/*.test.js`）不受影响。

## Risks

- **误吞真实冲突**：把非 404 的失败当成“服务端没有该目录”会静默跳过真实差异 → 只对明确的 `404 NOT_FOUND` 判“本地新增”，其余错误必须保留差异。
- **往返请求成本**：每个本地候选目录多一次 `/files` 探针 → 仅首同步执行一次，活动目录数量有限（现场 3 个）。
- **只读标记副作用**：`mark_readonly_dir` 会同步清掉该目录的 `deferred` 记录，误标会让用户的本地改动看起来消失 → 只在收到服务端 403 归属拒绝时标记。
- **旧绑定残留**：之前误标或已完成的 cursor 不会被自动回滚；验证需覆盖已有 `readonly_task_dirs` 与新接入两种起点。
- **压制过头**：稍后处理的记忆若按 `control_key`（含 `revision`）或按整包 JSON 比较，服务器 revision 一变动就会立刻重新弹窗；必须用“忽略 `revision` 的差异签名”。反之若签名过粗（只看 `taskSpaceId`），真实新增冲突会被永久吞掉。
- **通知与更新通知抢同一个 tap 回调**：`update.rs:134-141` 的 `on_action` 只判 `action_id() == "tap"` 就聚焦并 emit `update-open-dialog`；同步通知也走 `tap`，会把「更新」对话框误开 → 处理方式：该回调在 emit 前先判 `update_available`，无更新时只聚焦。
- **焦点判定失败**：`WebviewWindow::is_focused()` 返回 `Err`（窗口已销毁等）时若当成“已聚焦”会静默吞掉通知 → 统一按“未聚焦”处理，宁多提示不漏提示。
- **旧客户端覆盖新偏好**：旧 Web 包调用 `appearance_save` 只传 `theme`/`fontSize`，若参数为必填会保存失败、若直接覆盖会清掉 `notifyMode` → 新参数用 `Option<String>`，缺省时保留已存值，非法值经 `normalised()` 回退 `always`。
- **手动唤回失效**：去重若直接丢队列项，`live_control_show` 会返回“没有等待确认的任务差异”，用户失去重新进入首同步确认的唯一入口 → 必须保留可重放的副本。
