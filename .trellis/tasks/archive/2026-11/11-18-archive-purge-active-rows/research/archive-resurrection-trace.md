# 归档任务复活事故追踪（2026-11-17，trellis-board / task space a8d34d0e）

## 现象

客户端 release 0.4.32 重新接入 `trellis-board` 后，看板出现两个**早已归档**的任务，并指派给 flyfly6：

- `11-17-fix-archive-filter-listener-dev-id`（规划列，23%）
- `11-17-in-window-task-sync-dialog`（实现列，46%）

本地 `.trellis/tasks/` 下同时出现这两个目录（git 全部未跟踪，创建时间 2026-11-17 17:41:55–56），内容为**旧快照**（`prd.md`/`design.md` 早于提交 `8f948d1`，归档目录里是新版）。

## 时间线（本地 UTC+8）

| 时间 | 事件 | 证据 |
| --- | --- | --- |
| 11-13 起 | 旧绑定存在，多次同步（task space revision 累计到 528） | `desktop.log` 中 a8d34d0e 共 562 行；taskDirs 107/116/117 |
| 11-17 11:16:34 | 旧绑定解除（"本地任务空间关联已停用或正在解除"，a8d34d0e 命中 108 行） | `desktop.log` |
| 11-17 11:50:45 | 本地归档 `11-17-in-window-task-sync-dialog`（提交 `5aefa07`） | git log |
| 11-17 14:34:56 | 本地归档 `11-17-fix-archive-filter-listener-dev-id`（提交 `d60500f`） | git log |
| 11-17 17:41:54 | 重新接入：新 binding `51d4c8a7`、新 localId `291caf81`，`initialSyncMode=safe` | `config.json`、`ownership-index.json` |
| 17:41:55–56 | safe 首同步把 3 个任务目录写回本地（含两个已归档任务） | `live-cursors.json` baselines 19 条 sha256 与本地文件逐一全等 |

关键：**归档发生在没有有效绑定的窗口内**，因此客户端无从上传 `deleted:true`；服务端 `sync_task_space_file` 中这两个任务的活跃行（`deleted=0`）从未被清理。

`067d5b5`（release 0.4.32）是 `5aefa07` / `d60500f` 的祖先，`git ls-tree 067d5b5 .trellis/tasks/` 只有 `archive/` → 排除"服务端按 lastHead 重新扫描出活跃任务"。

## 服务端缺陷链（逐行确认）

1. `packages/server/team/task-snapshot-service.js:187-206` `fileRows(taskSpaceId, afterRevision)`：`WHERE ... task_dir NOT LIKE '.trellis/tasks/archive/%' AND relative_path NOT LIKE '.trellis/tasks/archive/%'` —— 只按**路径前缀**过滤，不问任务是否已归档。
2. 同文件 `snapshot()`：`rows.filter((row) => afterRevision > 0 || !row.deleted)` —— 全量拉取（`afterRevision=0`）把所有 `deleted=0` 行当活跃文件下发；safe 首同步正是 `afterRevision=0`。
3. `packages/server/team/archive-git-sync.js` `importSnapshot()`（约 223-333）：只写/删 `sync_archive_file`、`archive_revision + 1`，**从不触碰 `sync_task_space_file`**；`snapshot.skipped` 分支（约 543-578）直接 return。两者都不会清理活跃行。
4. `packages/server/team/task-space-index.js:682-703` `readFileMetadata()`/`readContentRows()`：UNION `sync_task_space_file`(active) + `sync_archive_file`(archive) → 同一任务同时落盘"活跃目录 + 归档目录"，loader 扫描出两条 task 记录；`sync_task_index` 主键 `(task_space_id, task_key)`，`indexRowForTask()` 对同一 `task_key` 互相 upsert 覆盖。
5. `packages/server/database.js`（ensureV14Schema）的历史迁移只搬 `archive/` 路径行，不处理"归档任务的活跃路径行" → 旧脏数据原样留存。

## 客户端侧（为什么本机也没自愈）

- `packages/desktop/src-tauri/src/agent/task_sync.rs` `watch_loop()`：`active_task_directory_from_relative(&relative_path).is_none()` 直接 `continue` → archive 路径的文件事件被忽略，归档移动不会进 dirty 队列。
- `upload_directories()` 过滤 archive task_dir；`build_directory_files()` 只在目录被列入 dirty 时生成删除项。
- 结果：归档移动的删除永远不上传；服务端只能靠客户端显式 `deleted:true` 收敛（`packages/server` 内无 `deleted = 1` 写入点）。

修复后自愈路径（已确认）：服务端 purge 把行置 `deleted=1` 并递增 `sync_task_space.revision` → 客户端增量拉取拿到 tombstone，`deleted_dirs` → `fetch_directory` 返回空组（`directorySnapshot` 只取 `deleted = 0`）→ `apply_server_groups()` 中 `group.files.is_empty() && mode == "incremental"` → `remove_task_directory()` 删掉本地复活目录。

## 身份对位：目录名，而不是 task.json 的 id

- `task.json.id` 是 slug（`task_store.py:529` `"id": slug`），同一 slug 在不同日期可重复使用 → **id 不唯一**。
- 目录名 `${MM-DD}-${slug}`（`task_store.py:463`）在创建时校验当前目录不存在且归档中不存在同名目录（`task_store.py:463-471` `_find_archived_task_by_dir_name`），因此**目录名唯一**，这才是任务身份。
- `sync_archive_file.task_id` 只在 `task.json` 行有值（`archive-git-store.js:710-716`），其余行为 `NULL` → 用它做匹配还会漏行。
- 结论：反解 `.trellis/tasks/archive/<YYYY-MM>/<dir>` → `.trellis/tasks/<dir>`，按目录名对位。

## 复现要点（写测试时用）

- 造一个空间：`sync_task_space_file` 有 `.trellis/tasks/<dir>` 的活跃行；`sync_archive_file` 有 `.trellis/tasks/archive/2026-11/<dir>` 的同名目录归档行（`task_id` 故意写成不同值，验证匹配走目录名而不是 `task_id`）。
- 断言：归档同步后活跃行 `deleted=1`、`sync_task_space.revision` 递增、`snapshot(afterRevision=0)` 不再返回该任务、`preflight` 不再把该目录当 ServerOnly。
