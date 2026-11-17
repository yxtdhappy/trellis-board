# 归档本地快照运维

适用范围：`packages/server/team/archive-local-snapshot.js`、归档 Git 同步、TaskSpace 删除和
`board.sqlite` 数据库备份。目标是保证任务详情、搜索和附件下载只读取本地文件与 SQLite。

## 存储布局

```text
<dataDir>/archive-snapshots/
  <taskSpaceId>/
    staging/<attemptId>/
      manifest.json
      files/<sha256>
    heads/<sourceHead>/
      manifest.json
      files/<sha256>
```

- `files/<sha256>` 是 Git blob 原始字节的 SHA-256 内容地址；同一快照内相同内容只写一次。
- `manifest.json` 记录来源 HEAD、相对路径、Git OID、SHA-256、大小、MIME 和受控 `storageKey`。
- SQLite `sync_archive_file.storage_key` 是相对 `archive-snapshots/` 的安全键，不是绝对路径。
- `sync_task_space.archive_snapshot_id` 指向当前 Board 已激活快照，
  `archive_candidate_snapshot_id` 指向等待索引提交的候选快照；同一时刻最多一个候选。
- `sync_archive_file`/`sync_archive_file_history.snapshot_id` 和 taskSpace 的 active/candidate
  指针受外键约束；`sync_archive_snapshot_one_active` 部分唯一索引保证每个 taskSpace 最多一个 active。
- `sync_archive_file` 保存当前候选或已激活快照的路径映射；被替换但仍可能被旧 Board
  访问的 fileId 复制到不可变 `sync_archive_file_history`。
- 单文件上限 16 MiB，单 TaskSpace 快照上限 512 MiB。超限时整次同步失败。
- 所有普通文件都导入；符号链接、子模块、非法任务目录和路径越界仍拒绝。

## 发布契约

1. 同步阶段把全部 blob 写入本次 attempt 的 `staging`。
2. 校验大小、SHA-256、相对路径和 manifest 后，同卷 rename 到 `heads/<sourceHead>`。
3. 导入事务先把当前 active fileId 复制到 `sync_archive_file_history`，再写入
   `active=0` 的候选快照和新的 `sync_archive_file` 映射；旧 active 快照不得在本事务退役。
4. 内容变化才推进 `archive_revision`；相同内容仅更换 HEAD 时只切换候选指针、来源、
   `storage_key` 和快照元数据。
5. Board/任务索引事务重新校验候选指针，在同一个 `BEGIN IMMEDIATE` 中退役旧 active、
   激活候选、写入 Board/索引并推进 `archive_indexed_revision`。
6. 索引失败或事务回滚时，active 指针、旧 Board、旧 revision 和旧 fileId 全部保持可用；
   候选指针与候选目录保留，供下一次同步或重试收敛。
7. 只有索引成功提交后才执行清理，删除不再被 active、候选或当前历史 fileId 引用的旧快照。

`sync_archive_file.content_text` 从 v15 起不写新正文。v14 及更早的 `blob_oid='legacy'` 行继续回退读取
`content_text`，直到该 TaskSpace 下一次成功完整同步。

## 清理算法

`createArchiveSnapshotStore().cleanup()` 在服务启动、同步导入后、索引成功后、同步失败和 TaskSpace
物理删除后执行：

- staging 仅删除超过 24 小时的 attempt。
- 同一进程内进行中的 staging 和已发布但尚未写入 SQLite 的 head 受保护，其他 TaskSpace 的并发清理
  不能删除它们。
- 当前数据库始终保留 active 指针和 candidate 指针引用的快照行；失败期间两者同时存在。
- 历史 fileId 继续引用旧快照时保留对应目录；索引成功激活新快照后清理旧候选和旧历史引用。
- 文件目录同时保留当前数据库和受管 `board.sqlite.snapshot.*` 备份中的全部 `storage_root` 引用。
- 数据库备份只读取 `sync_archive_snapshot`；没有该表的旧备份不影响 v15 表结构。
- 任一受管备份无法读取或无法校验引用时，fail closed，整个清理停止并保留文件和快照行。
- 备份轮换后，下一次服务启动或归档同步清理会释放不再被当前数据库和任何备份引用的目录。

物理删除 TaskSpace 前必须先完成强制数据库备份。该备份会暂时保留对应快照，供数据库恢复使用；
不能在备份仍存在时手工删除 `archive-snapshots/<taskSpaceId>`。

## 日志和错误

- 清理失败只记录 `taskSpaceId` 和稳定 `errorCode`，不记录绝对路径、正文或底层错误消息。
- 本地文件缺失或哈希不匹配对读取方返回 `503 ARCHIVE_LOCAL_FILE_UNAVAILABLE`；不得回源 Git。
- 备份引用扫描失败返回 `ARCHIVE_SNAPSHOT_BACKUP_SCAN_FAILED`，本次不删除任何快照文件。
- 下载并发上限为 4，读取超时 30 秒；超限和超时分别返回 `ARCHIVE_DOWNLOAD_BUSY`、
  `ARCHIVE_DOWNLOAD_TIMEOUT`。

## 恢复与回滚

- 服务重启只读取 SQLite 元数据和本地 manifest，不运行 Git，也不要求归档凭据。
- 已发布快照目录缺失、manifest 不完整或文件不存在时，下一次后台归档同步会重新获取 HEAD；
  同步完成前，请求不得自行启动 Git。
- 回滚到 v14 代码时不得删除 v15 快照或新增列；旧代码只读取 legacy `content_text`。
- 恢复数据库备份时，先停止同步和写请求，恢复 `board.sqlite` 后重新打开服务并执行启动清理。

## 只读检查

排障时优先检查数据库状态、日志中的 `errorCode` 和 manifest，不修改 `storage_key`：

```sql
SELECT task_space_id, source_head, status, active, file_count, byte_count, published_at
FROM sync_archive_snapshot
ORDER BY task_space_id, published_at DESC;
```

```sql
SELECT task_space_id, archive_snapshot_id, archive_candidate_snapshot_id
FROM sync_task_space;
```

```sql
SELECT relative_path, snapshot_id, sha256, size_bytes, mime_type, storage_key, source_head
FROM sync_archive_file
WHERE task_space_id = ?
ORDER BY relative_path;
```

需要人工释放磁盘时，先确认当前数据库和全部受管备份都不再引用目标 `storage_root`；否则保留目录并等待
正常清理。不要删除整个 `archive-snapshots/` 根目录。

## 验证

- `archive-local-snapshot.test.js`：内容寻址、限额、重启、损坏、备份引用和 TaskSpace 删除。
- `archive-git-store.test.js`：全部普通文件、路径安全、fetch/cat-file 边界。
- `archive-git-sync.test.js`：候选导入不退役 active、索引失败保留旧 fileId 下载、重试成功原子切换、
  新 HEAD 元数据刷新和事务失败回滚。
- `team-gitless-http.test.js`：401/403/404、下载头、nosniff、本地文件缺失。
