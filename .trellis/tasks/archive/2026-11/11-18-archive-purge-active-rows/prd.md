# 归档任务被重新同步为活跃任务

## Goal

服务端在归档同步后清理 `sync_task_space_file` 中属于已归档任务的活跃行，并拒绝向已归档任务推送活跃文件，修复"重新绑定后归档任务被 safe 首同步写回本地复活、看板显示为进行中"的问题。

## Background

2026-11-17 事故（详见 `research/archive-resurrection-trace.md`）：旧绑定解除期间两个任务被归档，删除请求无从上传；服务端只按路径前缀过滤 `.trellis/tasks/archive/`，导致 `sync_task_space_file` 里这两个任务的 `deleted=0` 活跃行长期留存。重新绑定后 safe 首同步（`afterRevision=0`）把这些行当活跃文件下发，客户端写回 `.trellis/tasks/<dir>`，看板显示为规划/实现中的任务。

## Requirements

1. 归档同步（`archive-git-sync` 的"无变化"与"已导入"两条路径）完成后，服务端必须把该任务空间内属于已归档任务的活跃行（`sync_task_space_file` 中 `deleted=0`、非 `archive/` 路径、`task_dir` 命中归档行 `task_dir` 反解出的活跃目录）置为删除态：`deleted=1`、`content_text=NULL`。
   - 反解规则：`.trellis/tasks/archive/<YYYY-MM>/<dir>` → `.trellis/tasks/<dir>`。
   - **不能按 `task_id` 匹配**：`task.json` 的 `id` 是 slug（`task_store.py:529`），同一 slug 在不同日期可重名；目录名 `${MM-DD}-${slug}` 在创建时保证当前与归档中唯一（`task_store.py:463-471`），才是任务身份。
2. 清理必须递增 `sync_task_space.revision` 并留下 `sync_file_audit` 删除记录，使增量客户端能收到 tombstone、索引能重建。
3. 清理有实际改动时必须在归档同步结果中体现 `needsIndex`，触发索引重建（看板随之收敛为归档任务）。
4. 服务端必须拒绝"向已归档任务推送活跃文件"的同步批次（`applyChanges`），返回既有错误码 `ARCHIVE_SYNC_SERVER_MANAGED`（HTTP 409），错误信息中文且说明归档由服务端 Git 索引管理。
5. 删除操作（`deleted:true`）不受第 4 条限制——客户端仍可清理本地残留。
6. 清理必须幂等：无匹配行时不递增 revision、不写审计、不影响 `via` 返回的 `changed`/`archiveRevision` 语义。

## Constraints

- 只改服务端 `packages/server`；不动客户端协议与 `packages/shared` 契约（`ARCHIVE_SYNC_SERVER_MANAGED` 已存在）。
- 归档快照（`sync_archive_file`）仍是归档内容的唯一权威来源，清理不得改动它。
- 不改 `sync_task_index` 表结构，不新增数据库迁移（用现有列即可）。
- 不改 `directorySnapshot` 的归档拒绝行为；`fileRows` 的路径前缀过滤保留（清理后无匹配行，行为不变）。
- 代码风格沿用现有：`withTransaction(db, ...)`、参数化 SQL、中文错误信息；格式化用 `oxfmt`。

## Acceptance Criteria

- [ ] 单测：构造"活跃行 `.trellis/tasks/<dir>` + 同目录名归档行 `.trellis/tasks/archive/2026-11/<dir>`"，跑一次归档同步后活跃行 `deleted=1`、`content_text=NULL`、`sync_task_space.revision` 递增、`sync_file_audit` 新增 `operation='delete'` 记录。
- [ ] 单测：同一场景下 `snapshot(afterRevision=0)` 不再返回该任务任何文件；`preflight` 不再把这些文件判为 ServerOnly。
- [ ] 单测：无归档行、或归档行目录名与活跃行不同时，归档同步不改变 revision、不写审计（幂等）。
- [ ] 单测：`applyChanges` 对目录名已归档的非删除批次返回 409 `ARCHIVE_SYNC_SERVER_MANAGED`；同批目录只含 `deleted:true` 时正常通过。
- [ ] 单测：清理后归档索引不再产生"活跃目录"记录（`sync_task_index` 中该 task 只有归档记录）。
- [ ] `yarn workspace @trellis-board/server test`（或 `node --test packages/server/test/*.test.js`）全绿；`oxfmt --check` 通过。
- [ ] 一次真实链路验证：本机 release 客户端重新接入后，被复活的 `11-17-fix-archive-filter-listener-dev-id/`、`11-17-in-window-task-sync-dialog/` 两个目录被客户端自动删除，看板不再显示为活跃任务（依赖远端服务端部署新版本，作为交付后人工验证项）。

## Out of Scope

- 客户端 `watch_loop` 对 archive 路径直接 `continue` 导致归档移动不上传删除的行为（accepted risk，服务端清理已兜底）。
- 历史已归档任务之外的其他脏数据修复（如 `sync_task_index` 历史残留行的手工清理）。
- 归档任务在客户端的解档（unarchive）流程。
