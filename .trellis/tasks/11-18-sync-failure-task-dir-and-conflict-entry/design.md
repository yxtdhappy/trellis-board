# 设计

## 1. 上传前按归属分类（替代原“403 转归属复核”）

`packages/desktop/src-tauri/src/agent/task_sync.rs` 上传循环（`:7804` 区域）改为分类处理，**不弹归属复核、不中断整次 pull**：

| `fetch_directory` 结果 | 处理 |
| --- | --- |
| `Ok(files)` | 正常进入上传批次 |
| `403 FORBIDDEN`（含 `server_code = FORBIDDEN` 或 `code = TASK_WRITE_FORBIDDEN`） | 写入 cursor `readonly_task_dirs[task_dir] = "FOREIGN_OWNER"`（cursor 锁内单次读改写），日志 `跳过他人任务 {task_dir}`，跳过；该目录不进 `allowed`、不写 baseline |
| `409 TASK_ARCHIVED` | 记入 `server_archived` 列表 → 交给 §2 清理，跳过 |
| `404 NOT_FOUND` | 保持现状：空服务端文件集合，允许首次上传（§4 的归档行探测会在客户端先拿到 409，避免复活） |
| 其它（5xx / 网络 / INVALID_RESPONSE） | 整体失败，错误经 `with_task_dir` 携带 `taskDir` |

- 新增 cursor 字段 `readonly_task_dirs: BTreeMap<String, String>`（`packages/desktop/src-tauri/src/agent/task_sync.rs` 的 `Cursor` 结构，序列化进 `live-cursors.json`）。清理时机：本地目录消失；或服务端控件把该目录的任务改派回本机（`controls` 中 `assigneeUserId == agent.userId`）；均在 cursor 锁内单次写。
- `resolve_group_ownership`（`:5988`）只判分支的现状不改——归属真相只有服务端知道，客户端以服务端响应为准，避免本地维护成员表。
- 下拉方向无需改动：`fileRows`（`packages/server/team/task-snapshot-service.js:290-308`）已用 `visibleTaskIds`（`assignee_user_id = 我 AND archived = 0`）过滤，他人任务文件不会下发。

## 2. 本地残留活跃副本清理

服务端归档后 `relativeDir` 变为 `.trellis/tasks/archive/<month>/<name>`，客户端此前 materialize 出的活跃目录（本机实测为 untracked）不会被自动移除，导致每轮 pull 都 403。

- 触发：处理 `state = archived` 的控件时（既有 `inactive_control_dirs`/归档控制路径），若存在本地活跃目录 `.trellis/tasks/<name>`：
  - 本地归档副本 `.trellis/tasks/archive/<month>/<name>` 存在 **且** 该目录不在本轮 dirty 集合 → `remove_task_directory`，日志 `清理残留活跃副本 {task_dir}`（保留归档副本）。
  - 否则 → 保留目录，`crate::logging::warn("本地残留已归档任务副本 {task_dir}：存在未同步改动，已跳过清理")`，同一任务只记一次（利用既有 cursor pending 去重思路）。
- 不新增 cursor 字段：判断依赖“本地是否存在归档副本 + dirty 集合”，两者都在本轮已算出。

## 3. 服务端 403 语义纠正

`packages/server/team/task-control-service.js` `assertReadable`：

1. 活跃路径查 `sync_task` 命中 → 现有逻辑不变（archived → 409，assignee 不符 → 403）。
2. 未命中时新增一步：按目录 basename 反解归档行
   ```sql
   SELECT * FROM sync_task WHERE task_space_id = ? AND archived = 1
     AND relative_dir LIKE '.trellis/tasks/archive/%/' || ?  -- basename
   LIMIT 1
   ```
   命中 → `throw teamError(409, 'TASK_ARCHIVED', '任务已归档')`。
3. 仍未命中 → 维持 legacy 403 / 404（现有顺序）。

## 4. 手动下载他人任务（只读）

服务端新增两个**只读** agent 接口（`packages/server/team/http.js` + `task-snapshot-service.js`）：

- `GET /api/agent/task-spaces/:id/tasks`
  返回 `{tasks:[{taskId, taskDir, title, stage, assigneeUserId, assigneeDevId, createdByUserId, archived, updatedAt}]}`，只含 `archived = 0`；守卫 `bindingContext` + `assertAgentAccess`（不改写权限）。
- `GET /api/agent/task-spaces/:id/tasks/:taskId/files`
  返回 `{taskId, taskDir, files:[{path, sha256, content}]}`。守卫：`assertAgentAccess` + 任务在该 space 且未归档；**不复用 `assertReadable`**（那是写/负责人视角），新增 `assertTaskVisible(agent, taskSpaceId, taskId)`。

桌面端（`packages/desktop/src-tauri/src`）：

- `TaskSync::download_task(task_space_id, task_id) -> Value`：拉 `tasks` 列表解析 `taskDir`（校验 `active_task_directory_from_relative`）→ 拉文件 → 落盘 `.trellis/tasks/<dir>`（复用现有 group 写入函数，`archived=false`）→ cursor `readonly_task_dirs[dir] = "DOWNLOADED"` → 返回 `{taskId, taskDir, fileCount}`。
- 新命令（`agent_service.rs` + `main.rs` 注册）：
  - `live_task_download(app, task_space_id, task_id) -> Result<Value, String>`
  - `live_local_task_state(app, task_space_id) -> Result<Value, String>` → `{localDirs:[], readonlyDirs:[], archivedResidue:[]}`（扫描 `.trellis/tasks/*` + cursor + 归档副本差集）。

前端（`packages/web/src/features/board`）：

- `task-view.ts` 的任务模型已带 `relativeDir`；`Kanban.tsx`/`TaskCard.tsx` 传入本地状态。
- 新 hook `useLocalTaskState(taskSpaceId)`：`invoke('live_local_task_state')`，监听 `live-control-changed` 与关联变更事件刷新（与 `LiveSyncControlDialog` 的刷新节奏一致，不新增轮询）。
- `TaskCard.tsx`：卡片状态徽标——本机存在 → 「已在本机」；`readonlyDirs` 含该目录 → 「已在本机（只读）」；否则「未下载到本机」+ 下载按钮（`Download` 图标，`title="下载到本机"`，`onClick` → `invoke('live_task_download', { taskSpaceId, taskId })`）。成功后 `toast.success('已下载到本机')` 并刷新 local state；失败 `toast.error` 展示 message。
- 只读副本永不参与上传：§1 的上传过滤直接跳过 `readonly_task_dirs` 中的目录。

## 5. 目录级错误携带 taskDir

- 新增 `fn with_task_dir(error: AgentError, task_dir: &str) -> AgentError`：`details` 已有 `taskDir` 则保留，否则注入；保留 `code/status/server_code/conflict_id`。
- 4 个 `fetch_directory` 调用点统一 `.map_err(|e| with_task_dir(e, &task_dir))`：`task_sync.rs:6611`、`:7804`、`:8739`、`:9165`。
- `task_sync_error_event`（`:72-97`）增补 `errorCode`、`serverCode`；`report_error`（`:4866`）日志补 `taskDir`/`code`。
- `LiveSyncControlDialog.tsx` `task_sync_error` 网格新增「错误码」行（`errorCode / serverCode`，为空不渲染）。

## 6. 冲突待处理入口（保留原方案）

- 新命令 `live_conflicts_show(app, task_space_id?) -> bool`：`TaskSync::reopen_conflicts()` 拉 `/conflicts`，逐条 `fetch_directory` 探活——存活 → 构造 `task_file_conflict` 控制事件；`404`/`409 TASK_ARCHIVED`/`409 ARCHIVE_SYNC_SERVER_MANAGED` → `resolve_conflict(..., {"action":"use-server"})`（服务端该动作只置 `resolved`，不写文件，`task-snapshot-service.js:1338-1341`）+ `clear_conflict_blocked`。命令层 `publish_control` + `show_pending_control`。
- `ProjectRail.tsx`：`conflictPendingCount > 0` 时把状态文案从项目选择按钮移出，改为行下独立按钮「已关联 · N 个冲突待处理 · 点击处理」→ `invoke('live_conflicts_show', { taskSpaceId })`；`false` → `toast.info('没有待处理的任务冲突')`。

## 7. 服务端归档收敛冲突（根因）

- `reconcileProjection` 归档分支（`task-control-service.js:960-975`）在 `revokeLeases` 后同事务：
  ```sql
  UPDATE sync_conflict SET status = 'resolved', resolved_at = ?
  WHERE task_space_id = ? AND status = 'pending' AND (task_dir = ? OR task_id = ?)
  ```
  参数 `existing.relative_dir` / `existing.task_id`。
- `listConflicts`（`task-snapshot-service.js:1203`）追加防御：`NOT EXISTS (SELECT 1 FROM sync_task t WHERE t.task_space_id = c.task_space_id AND t.archived = 1 AND (t.task_id = c.task_id OR t.relative_dir = c.task_dir))`。
- 该改动与 `11-18-archive-purge-active-rows`（`f055129`，只清 `sync_task_space_file`）互补，两者都不覆盖对方的表。

## 兼容与风险

- `task_sync_error` 新增字段、`task_ownership_review` 不再因 403 触发：旧前端忽略未知字段；弹窗归属动作路径保留（其他来源仍会用）。
- 只读副本目录一旦被用户手动编辑，上传被跳过 → 需要接管归属才会回传；UI 明确标注“只读”。
- 每次 pull 仍会对他人任务目录各发 1 次 `fetch_directory`（200/403）——目录数有限，且 403 后写入 `readonly_task_dirs` 可继续存在；若想彻底省掉请求，可用 `readonly_task_dirs` 命中时直接跳过而不再探测（默认采用直接跳过，探测仅在 state 变化时发生）。
- 清理活跃重复副本依赖“无未同步改动”，避免静默丢改动；dirty 情况仅日志告警。

## 验证策略

- Rust 单测：`with_task_dir` 注入/保留；403 分类写入 `readonly_task_dirs` 并跳过；归档残留清理的两种分支（有/无归档副本、dirty/非 dirty）；`download_task` 落盘 + 只读标记。
- 服务端单测：`assertReadable` 归档基名反解返回 409；`/tasks` 列表只返回未归档；`/tasks/:id/files` 对非负责人可读、对未绑定 agent 拒绝；归档后 `sync_conflict` 置 resolved 且 `listConflicts` 不返回。
- Web：`tsc -b` + 看板手测（卡片三态徽标、下载按钮、只读标记）。
- 端到端：重启客户端 → pull 不再失败；看板对未下载任务点下载 → 目录出现且不参与上传；mdp 冲突点击入口 → 弹窗/已处理提示；部署新服务端后冲突收敛。
