# 本地快照契约调研

## 现状事实

- `archive-git-store.js` 使用 `git init --bare` 和 `blob:none` partial clone。
- 同步阶段通过 `prefetchBlobs()` 和 `git cat-file --batch` 读取对象。
- `archive-git-sync.js` 将正文写入 `sync_archive_file.content_text`。
- `task-space-index.js` 从 `sync_archive_file.content_text` 读取归档正文并生成任务索引。
- SQLite 的 `sync_archive_file` 当前没有大小、MIME 或本地文件键字段。

## 容量基线（2026-11-17）

| 分支 | 全部文件 | 全部大小 | 非文本附件 | 附件大小 |
| --- | ---: | ---: | ---: | ---: |
| mdp-backend-service/dev | 1741 | 16.94 MiB | 163 | 5.53 MiB |
| mdp-backend-web/dev | 603 | 5.03 MiB | 23 | 2.00 MiB |
| mdp-management-web/release/3.0.0/dev | 1613 | 3.54 MiB | 4 | 0.36 MiB |
| mdp-report-service/release/3.0.0/dev | 316 | 2.32 MiB | 51 | 0.27 MiB |
| trellis-board/main | 783 | 6.62 MiB | 31 | 4.31 MiB |
| 合计 | 5056 | 34.45 MiB | 272 | 12.47 MiB |

## 结论

- 当前容量适合本地快照，但不应把二进制正文写入 SQLite。
- 推荐同步时物化本地内容寻址文件，SQLite 仅保留索引和元数据。
- 读取阶段禁止调用 Git，以彻底避免 partial clone 隐式回源远端。
- 旧的 SQLite 文本保留为迁移回退，不能在同一阶段删除。

## 待评审设计默认值

- 单文件上限 16 MiB。
- 单 TaskSpace 快照上限 512 MiB。
- staging 24 小时未发布自动清理。
- 当前只保留可读快照和最近一次数据库备份可能引用的快照。
