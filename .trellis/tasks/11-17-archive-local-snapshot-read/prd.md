# 归档附件本地快照与只读访问

## Goal

让服务端在归档同步阶段完整保存每个 TaskSpace 分支的 `.trellis/tasks/archive/**` 文件到不可变本地快照。同步完成后的任务详情、搜索、附件列表和下载只能读取本地快照与 SQLite 索引，不得启动 Git、读取 Git 凭据或访问远端仓库。

## Background

- 当前归档导入使用 bare partial clone，并在同步时读取 blob 正文，见 `packages/server/team/archive-git-store.js`。
- 当前 `sync_archive_file.content_text` 以文本形式保存正文，见 `packages/server/database.js`。
- 真实分支的归档目录包含 `.png`、`.xlsx`、`.class`、`.ps1`、`.java`、`.log`、`.pen` 等附件，不是只有任务 Markdown。
- 当前五个归档分支的已测量基线为 5,056 个文件、约 34.45 MiB，其中非文本附件 272 个、约 12.47 MiB。该数据用于容量验证，不作为永久常量。
- Trellis 归档使用整目录移动，任务执行过程中产生的截图、脚本、日志和分析数据会随任务进入 `archive/**`。

## Requirements

### R1. 同步与读取边界

- 只有归档同步阶段允许执行远端 Git fetch、读取归档 Git 凭据和访问网络。
- 同步成功后，任务详情、任务列表、搜索、附件列表和附件下载不得执行 Git 子进程。
- 读取阶段不得因为本地文件缺失而回源远端；缺失时返回明确的本地数据不可用错误，并保留上一份完整快照。

### R2. 完整本地快照

- 同步应保存归档 Git tree 中的全部普通文件，不再因文件扩展名跳过附件。
- 符号链接、子模块、目录越界和非法路径继续拒绝。
- 文件正文不得写入 SQLite 的 `content_text`；正文保存到服务端数据目录中的不可变本地快照。
- SQLite 只保存任务索引、文件元数据、SHA-256、Git blob OID、大小、MIME、来源 HEAD、本地存储键和必要的文本搜索投影。

### R3. 原子发布与一致性

- 新快照先写入临时 staging 目录，完整校验后才发布。
- 文件写入、SQLite 元数据、Board/task index、归档 revision 和 `archive_indexed_revision` 必须收敛到同一次成功发布。
- 任一步失败不得覆盖上一份可读快照，也不得让 Board 看到半份文件。
- 同一 TaskSpace 的同步仍保持串行，不同 TaskSpace 可按现有并发限制执行。

### R4. 只读访问

- 归档任务详情返回附件元数据列表，不直接嵌入大文件正文。
- 新增受权限保护的附件下载接口，只允许当前有任务空间查看权限的登录用户读取。
- 文本文件可继续参与任务详情和搜索投影；图片、Excel、压缩包等二进制文件以下载为主。
- 下载响应必须固定 `Content-Type`、`Content-Length`、`Content-Disposition`、`X-Content-Type-Options: nosniff`，不得以内联 HTML、SVG 或脚本执行。

### R5. 保留、清理与迁移

- 成功发布后清理不再被任何当前快照或 staging 引用的旧文件。
- 服务重启后能够从 SQLite 元数据和本地快照恢复读取，不要求重新访问 Git。
- 从 schema v14 升级时保留现有文本归档作为 legacy 可读数据；下一次成功同步后切换为该 TaskSpace 的本地完整快照。
- 数据库备份、TaskSpace 删除和项目删除必须同步维护本地快照引用，不能遗留无法追踪的敏感文件。

## Acceptance Criteria

- [ ] 对包含 `.png/.ps1/.java/.log/.xlsx/.pen` 的真实归档分支执行同步后，文件数、路径、大小和 SHA-256 与 Git tree 一致。
- [ ] 同步完成后停止远端网络并禁用 Git 执行，任务详情、附件列表和附件下载仍可正常完成。
- [ ] 读取请求前后不产生新的 Git 子进程、远端连接或凭据读取。
- [ ] `sync_archive_file` 不再保存文件正文；SQLite 只保留元数据和文本搜索投影。
- [ ] 同一 TaskSpace 并发触发同步时仍为 single-flight，不出现重叠发布。
- [ ] 新快照发布失败时，上一份归档 revision、Board 索引和下载结果保持完整可读。
- [ ] 服务重启后，不触发全量远端 Git fetch即可读取上一份完整快照。
- [ ] 普通成员无权访问其他 TaskSpace 的附件；未登录请求返回 401，无权限请求返回 403。
- [ ] 非法路径、符号链接、子模块和伪造下载 ID 被拒绝，不暴露服务端绝对路径或 Git cache 路径。
- [ ] 五个现有 TaskSpace 至少完成一次真实同步和页面/API 验证，并记录文件数、字节数、耗时和失败恢复结果。

## Out of Scope

- 不向桌面 Agent 下发归档文件；桌面端仍只同步活动任务。
- 不允许编辑、删除、提交或推送归档文件。
- 不提供任意文件的服务端执行、脚本运行或 Office 文档服务端转换。
- 不在本任务中改变 Trellis `task.py archive` 的整目录归档语义。

## Dependencies

- 依赖 `.trellis/tasks/11-17-optimize-client-task-sync-performance` 完成当前归档导入、凭据和任务索引收口。
- 本任务完成并通过评审前保持 `planning`，不得进入实施。

## Risks

- 本地快照会增加磁盘占用，需要原子发布和可靠清理。
- 二进制附件存在恶意文件和内容嗅探风险，必须只下载、不内联执行。
- 大文件、大量小文件和 Git LFS/promisor 对象需要明确上限与失败策略。
- 迁移期间同时存在 legacy SQLite 正文和新本地快照，读取层必须有明确优先级。
