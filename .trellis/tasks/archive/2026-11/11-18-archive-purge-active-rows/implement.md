# 实施计划：归档后清理活跃行

## 步骤

1. `packages/server/team/task-snapshot-service.js`
   - [x] 新增导出 `purgeArchivedTaskFiles(db, taskSpaceId, { now })`（`withTransaction` 内、契约见 `design.md`），复用已导入的 `snapshotSha256` 与 `teamError`。
   - [x] 在 `applyChangesInternal()` 的 `validateCompleteTaskGroups` 之后加入"已归档任务不接受活跃文件"守卫：批次含任一 `!file.deleted` 且归档行 `task_dir` 反解出的活跃目录命中 `complete.taskDir` → `teamError(409, ARCHIVE_SYNC_SERVER_MANAGED, ...)`。
2. `packages/server/team/archive-git-sync.js`
   - [x] 引入 `purgeArchivedTaskFiles`，在 `snapshot.skipped` 分支计算 `needsIndex` 前调用，把 `purged > 0` 并入 `needsIndex`，日志字段增加 `purgedFiles`。
   - [x] 在 `importSnapshot()` 返回后调用，把 `purged > 0` 并入 `needsIndex` 与"归档 Git 同步完成"日志字段。
3. 测试
   - [x] `packages/server/test/team-task-snapshot.test.js`：活跃行 `.trellis/tasks/<dir>` + 同目录名归档行 `archive/2026-11/<dir>`（`task_id` 故意不同）→ `purgeArchivedTaskFiles` 后 `deleted=1`、`content_text IS NULL`、`sha256=snapshotSha256('')`、`revision` 递增、`sync_file_audit` 新增 delete、full snapshot 不再返回该任务、增量快照下发墓碑；二次调用 `purged=0` 且 revision 不变。
   - [x] `packages/server/test/team-task-snapshot.test.js`：`applyChanges` 对已归档目录名的活跃批次返回 409 `ARCHIVE_SYNC_SERVER_MANAGED`；同目录名的纯删除批次成功。
   - [x] `packages/server/test/archive-git-sync.test.js`：同一个 fake store 先走"无变化"再走"有变化"的 `syncTaskSpace`（两次 `readSnapshot`），断言两条路径都会清理活跃行、`sync_task_space.revision` 各递增一次、`needsIndex` 为真（索引入队一次一条）。

## 验证命令

```bash
node --test packages/server/test/team-task-snapshot.test.js packages/server/test/archive-git-sync.test.js
yarn workspace @trellis-board/server test
npx oxfmt packages/server/team/task-snapshot-service.js packages/server/team/archive-git-sync.js packages/server/test/team-task-snapshot.test.js packages/server/test/archive-git-sync.test.js
```

## 回滚点

- 单步提交范围：服务端两个源文件 + 两个测试文件（可整笔还原，无 schema 变更）。
- 若上线后发现误删活跃行：修复点为 `purgeArchivedTaskFiles` 的 `task_dir` 匹配条件；数据侧可用 `sync_file_audit` 的 `old_sha256` 定位受影响文件，客户端重新上传即可恢复（`deleted=1` 是软删除）。

## 人工验收（需部署到团队服务端后）

1. 在客户端重新接入 `trellis-board`，观察被复活的 `.trellis/tasks/11-17-fix-archive-filter-listener-dev-id/`、`.trellis/tasks/11-17-in-window-task-sync-dialog/` 是否被自动删除。
2. 看板"任务流水线"不再显示这两个任务为规划/实现中；"归档索引"能看到它们。
3. 服务端日志出现 `归档 Git 同步完成` 且 `purgedFiles > 0`，随后日志无新的同步失败。
