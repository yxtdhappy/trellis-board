# 实施

> 顺序按依赖：先错误携带（可与其它并行）、再上传归属、再残留清理、再服务端语义/新接口、最后 UI 与冲突入口。

## 1. 目录级错误携带 taskDir（客户端）

`packages/desktop/src-tauri/src/agent/task_sync.rs`

1. 新增自由函数（放在 `task_sync_error_event` 附近）：
   ```rust
   fn with_task_dir(mut error: AgentError, task_dir: &str) -> AgentError {
       let mut details = error.details.take().unwrap_or(Value::Object(Default::default()));
       if let Value::Object(map) = &mut details {
           map.entry("taskDir".to_string()).or_insert_with(|| json!(task_dir));
       }
       error.details = Some(details);
       error
   }
   ```
2. 4 个调用点加 `.map_err(|e| with_task_dir(e, &task_dir))`：`:6611`（增量拉取）、`:7804`（上传前取服务端版本）、`:8739`（`upload_reviewed_local_task`）、`:9165`（`conflict_directories`）。
3. `task_sync_error_event`（`:72-97`）事件增补 `"errorCode": error.code`、`"serverCode": error.server_code`（`None` 不写）。
4. `report_error`（`:4866-4880`）日志加 `"taskDir"` 与 `"code"` 字段。

`packages/web/src/desktop/LiveSyncControlDialog.tsx`

5. `task_sync_error` 的 grid 增加「错误码」行：`event.errorCode`（有 `event.serverCode` 时拼接 `` `${errorCode} (${serverCode})` ``），空则不渲染。

## 2. 上传按归属分类 + cursor `readonly_task_dirs`

`packages/desktop/src-tauri/src/agent/task_sync.rs`

1. `Cursor`（`:1060-1075`）加 `pub readonly_task_dirs: BTreeMap<String, String>`；`CursorPatch`（`:9195-9210`）加同名 `Option` 字段；序列化/解析处（`cursor_to_value` 一带 `:5254`、`parse_cursor` `:1113-1140`）加 `readonly_task_dirs_to_value` / `parse_readonly_task_dirs`（键=task_dir，值=`FOREIGN_OWNER` / `DOWNLOADED`）。
2. 新增 `mark_readonly_dir(&self, task_space_id, task_dir, reason)`、`clear_readonly_dirs(&self, task_space_id, task_dirs: &[String])`，实现照抄 `mark_conflict_blocked`（`:5539`）/`clear_conflict_blocked`（`:5574`）的 cursor 锁内单次读改写。
3. 上传循环（`:7790-7830`）：`allowed` 构造时排除 `cursor.readonly_task_dirs` 命中的目录，并直接跳过 `fetch_directory`（不再每次探测）。
4. `fetch_directory` 错误分类（同循环内）：
   - `error.status == Some(403)` 或 `error.code == code::TASK_WRITE_FORBIDDEN` → `mark_readonly_dir(..., "FOREIGN_OWNER")` + `crate::logging::warn("跳过他人任务 {task_dir}")` + `continue`。
   - `error.code == code::TASK_ARCHIVED`（或 `server_code == "TASK_ARCHIVED"`）→ 收集进 `server_archived: Vec<String>`，`continue`，交给 §3。
   - 其它 → `return Err(with_task_dir(error, &task_dir))`。
5. 清理时机（`merge_task_controls`/快照处理里已有按 task_id 找 dir 的能力）：控件 `assigneeUserId == agent.userId`（`controls` 中 state ≠ archived）且目录在 `readonly_task_dirs` → 清除该条；本地目录不存在的条目 → 清除。

## 3. 本地残留活跃副本清理

`packages/desktop/src-tauri/src/agent/task_sync.rs`

1. 新增 `async fn archive_copy_exists(&self, binding: &AgentBinding, name: &str) -> AgentResult<bool>`：扫描 `<repo>/.trellis/tasks/archive/<YYYY-MM>/<name>`（`tokio::fs::read_dir` 两层，匹配 `ARCHIVE` 月份目录名正则等价判断 `^\d{4}-\d{2}$`）。
2. 在处理 `state = archived` 控件处（打印 `任务进入 Archived 控制状态` 的循环，`:6700` 附近）：对每个归档名 `name`：
   - `let active = format!(".trellis/tasks/{name}")`；
   - 若 `resolve_task_directory(binding, &active)` 存在、`archive_copy_exists(&name)` 为真、`!dirty.contains(&active)` → `self.remove_task_directory(binding, &active).await?` + `crate::logging::warn("清理残留活跃副本 {active}")`；
   - 否则（有未同步改动）→ `crate::logging::warn("本地残留已归档任务副本 {active}：存在未同步改动，已跳过清理")`，不改目录。
3. `dirty` 直接用本轮已有的 `dirty_dirs`/`local_files` 差集，不新增状态文件。

## 4. 服务端：`assertReadable` 归档行返回 409

`packages/server/team/task-control-service.js:802-833`

1. 在 legacy 回究（`sync_task_space_file`）之前插入归档反解：
   ```js
   const archived = taskSpaceDb.get(...)  // 现有 db 访问方式，见函数内既有查询
   ```
   按 `task_space_id` + `archived = 1` + `relative_dir LIKE '.trellis/tasks/archive/%/' || basename` 查一行；命中 → `throw teamError(409, 'TASK_ARCHIVED', '任务已归档')`（与既有 `row.archived` 分支同码同文案）。
2. 未命中 → 现有 legacy 403 / 404 顺序不变。

`packages/server/test/*.test.js`：新增用例覆盖 (a) 归档任务活跃路径 → 409 `TASK_ARCHIVED`；(b) 完全不存在 → 404；(c) legacy 活文件 → 403 文案不变。

## 5. 服务端：只读任务列表与文件接口

`packages/server/team/task-snapshot-service.js`

1. `listTaskSummaries(db, taskSpaceId)` → `SELECT task_id, relative_dir, title, stage, assignee_user_id, created_by_user_id, updated_at FROM sync_task WHERE task_space_id = ? AND archived = 0 ORDER BY updated_at DESC`，映射 `{taskId, taskDir, title, stage, assigneeUserId, createdByUserId, updatedAt}`（`assigneeDevId` 若已有 dev 映射则带上，无则省略）。
2. `taskFilesById(db, taskSpaceId, taskId)` → 复用现有读取文件行的查询方式，返回 `{taskId, taskDir, files:[{path, sha256, content}]}`；任务不存在或 `archived = 1` → 404 `taskError`。

`packages/server/team/http.js`

3. `GET /api/agent/task-spaces/:id/tasks` → `assertAgentAccess` 后返回 `{tasks: listTaskSummaries(...)}`。
4. `GET /api/agent/task-spaces/:id/tasks/:taskId/files` → `assertAgentAccess` 后 `taskFilesById`，**不走 `assertReadable`**。

## 6. 桌面命令：下载 + 本地状态

`packages/desktop/src-tauri/src/agent/task_sync.rs`

1. `pub(crate) async fn download_task(&self, task_space_id: &str, task_id: &str) -> AgentResult<Value>`：
   - GET `/api/agent/task-spaces/{id}/tasks` 找 `taskId` → 取 `taskDir`；用 `active_task_directory_from_relative(&format!("{taskDir}/task.json"))` 校验。
   - GET `/api/agent/task-spaces/{id}/tasks/{taskId}/files`；构造 `SnapshotGroup { task_dir, files, archived: false, task_branch: None }`，`write_task_directory(binding, &group)`（已存在于 `apply_server_groups` 内使用）。
   - `mark_readonly_dir(task_space_id, &task_dir, "DOWNLOADED")`，返回 `{taskId, taskDir, fileCount}`。
2. `pub(crate) async fn local_task_state(&self, task_space_id: &str) -> AgentResult<Value>`：本地扫描 `.trellis/tasks/*`（目录名）→ `localDirs`；cursor `readonly_task_dirs` → `readonlyDirs`；对 `localDirs` 中在 `.trellis/tasks/archive/**` 有同名副本的 → `archivedResidue`。

`packages/desktop/src-tauri/src/agent_service.rs`

3. `pub async fn live_task_download(app: &AppHandle, task_space_id: &str, task_id: &str) -> Result<Value, String>`（错误用 `e.to_string()`，与 `sync_deferred_tasks` 一致）。
4. `pub async fn live_local_task_state(app: &AppHandle, task_space_id: &str) -> Result<Value, String>`。

`packages/desktop/src-tauri/src/main.rs`

5. `invoke_handler` 注册两个命令（`:991-998` 区段）；如 capabilities 白名单存在则补 `packages/desktop/src-tauri/capabilities/`。

## 7. Web：看板徽标与下载按钮

1. 新增 `packages/web/src/features/board/useLocalTaskState.ts`：`invoke<LocalTaskState>('live_local_task_state', { taskSpaceId })`，监听 `live-control-changed` 与窗口 focus 刷新（复用 `LiveSyncControlDialog` 的事件名），返回 `{ localDirs:Set, readonlyDirs:Set, refresh }`。
2. `packages/web/src/features/board/TaskCard.tsx`：props 增加 `localState?: 'local' | 'readonly' | 'remote'` 与 `onDownload?: () => void`；卡片标题行右侧渲染徽标：`remote` → 「未下载」+ `Download` 图标按钮（`title="下载到本机"`），`readonly` → 「已在本机（只读）」，`local` → 「已在本机」。
3. `packages/web/src/features/board/Kanban.tsx`：接收 `localState` 映射与 `onDownload(task)`，按 `task.relativeDir` 匹配（`task-view.ts:67` 已有 `relativeDir`）。
4. 下载动作放在 `packages/web/src/features/board/BoardPage.tsx`（持有 `taskSpaceId`）：`invoke('live_task_download', { taskSpaceId, taskId: task.id })` → 成功 `toast.success('已下载到本机')` + `refresh()`；失败 `toast.error(message)`。

## 8. 冲突待处理入口

1. `packages/desktop/src-tauri/src/agent/task_sync.rs` 新增 `pub(crate) async fn reopen_conflicts(&self, task_space_id: &str) -> AgentResult<bool>`：`fetch_conflicts`（`:9088`，已过滤 archive-only）后逐条 `fetch_directory` 探活：`Ok` → 构造并 `push` `task_file_conflict` 控制事件（内容复用 `conflict_summary`；缺 `details` 时退化为 `{conflictId, taskDir}`）；`404`/`409 TASK_ARCHIVED`/`409 ARCHIVE_SYNC_SERVER_MANAGED` → `resolve_conflict(task_space_id, conflict_id, &json!({"action":"use-server"}))` + `clear_conflict_blocked`。返回是否有存活冲突。
2. `agent_service.rs` 新增 `live_conflicts_show(app, task_space_id)`：调用上面函数，有 → `publish_control`/`show_pending_control` 返回 true；无 → false。`main.rs` 注册。
3. `packages/web/src/components/layout/ProjectRail.tsx`：`conflictPendingCount > 0` 时把「已关联 · N 个冲突待处理」渲染为行下按钮（独立 `onClick`），`invoke('live_conflicts_show', { taskSpaceId })`；`false` → `toast.info('没有待处理的任务冲突')`。保留现有 basename 明细。

## 9. 服务端：归档收敛冲突

1. `packages/server/team/task-control-service.js` `reconcileProjection` 归档分支（`:960-975`，`revokeLeases` 之后）加：
   ```js
   db.prepare(`UPDATE sync_conflict SET status = 'resolved', resolved_at = ?
       WHERE task_space_id = ? AND status = 'pending'
         AND (task_dir = ? OR task_id = ?)`).run(now, taskSpaceId, existing.relative_dir, existing.task_id);
   ```
2. `packages/server/team/task-snapshot-service.js` `listConflicts`（`:1203-1232`）SQL 追加防御条件：排除命中已归档 `sync_task`（`task_id` 或 `task_dir`）的冲突。
3. 测试：归档后 `sync_conflict.status = 'resolved'`、`listConflicts` 不返回、revision 自增。

## 验证

- 服务端：仓库根 `node --test packages/server/test/*.test.js`（必须在根目录跑，`plugin-docs`/`plugin-events` 按 cwd 解析 `.trellis`）。
- 桌面：`cd packages/desktop/src-tauri && cargo test --bins`（该 crate 无 lib target）。
- Web：`cd packages/web && npx tsc -b && npx vite build`；`npx oxlint src`。
- 格式：仓库根 `npx oxfmt .`（只对改动文件）。
- 端到端：
  1. 重启客户端 → `desktop.log` 不再出现 `任务空间同步失败`；三个 `11-17-*` 活跃重复目录被清理（`git status` 恢复干净）。
  2. 看板对他人/未下载任务显示「未下载」+ 下载按钮；点击后目录出现且后续拉取不覆盖、上传不含该目录。
  3. mdp-backend-web 项目栏冲突按钮可点 → 旧冲突收敛后 `toast.info('没有待处理的任务冲突')`，状态消失。
  4. 新服务端下 `GET /files?taskDir=11-17-fix-archive-filter-listener-dev-id` 返回 409 `TASK_ARCHIVED`。

## E2E 实测（本地隔离服务端 + debug 客户端）

临时环境：`createTeamRuntime` 起 `127.0.0.1:4318`，客户端 `TRELLIS_DESKTOP_HOME` 指向隔离目录，仓库为临时 `git init` 目录，故不影响真实数据。结论：

- 他人负责目录：日志 `跳过他人任务目录（只读镜像）：.trellis/tasks/11-20-foreign-own`，cursor `readonlyTaskDirs` 写入 `FOREIGN_OWNER`，全程 0 条 `任务空间同步失败`。
- 归档残留：有本地改动时安全跳过（`存在未同步改动，已跳过清理`）；内容与归档副本一致后活跃目录被删除。
- 冲突闭环：服务端造冲突 → 弹窗全动作可见 → 重启后弹窗消失但项目栏「1 个冲突待处理 · 点击处理」可重新打开 → 「使用服务端版本」落地并清空 `conflictBlocked`。
- 归属下载：他人任务不自动落地，看板显示「未下载到本机」；下载后 `readonlyTaskDirs` 写入 `DOWNLOADED`、徽标「已在本机（只读）」、本地修改不上传。
- 顺带修复（本次 E2E 才暴露）：`agent/http.rs` 把 403 误判为 `AUTH_REVOKED` 导致整次 pull 失败；新命令缺 `permissions/desktop.toml` + capability 授权返回 `Command not found`；看板徽标在无控制事件时不自刷新（`useLocalTaskState` 加 15s 轮询）。
- 未覆盖：`task_sync_error` 弹窗新增的「错误码」行未截图（旧 403 路径已修复，心跳失败不触发该事件）。
