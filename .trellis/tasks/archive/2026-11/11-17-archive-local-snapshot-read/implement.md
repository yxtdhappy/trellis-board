# 归档附件本地快照与只读访问实施计划

## 1. 前置门禁

- [x] 先完成 `.trellis/tasks/11-17-optimize-client-task-sync-performance`，确认 GitLab 四个分支和 GitHub HTTPS 分支均可完成归档同步。
- [x] 读取 `prd.md`、`design.md`、backend specs 和 shared guides。
- [x] 由用户确认本 PRD、设计、容量限制和下载范围后才运行 `task.py start`。

## 2. Schema 与元数据

- [x] schema 升级到 v15，新增 snapshot 表、active/candidate 指针、不可变文件历史、文件
  大小/MIME/storageKey 和必要索引。
- [x] `sync_archive_file.content_text` 停止写入，legacy 数据继续可读。
- [x] 编写 v14 -> v15 幂等迁移、备份、回滚和重复迁移测试。
- [x] TaskSpace 删除和备份清理中的快照引用测试；Team 当前没有项目物理删除入口。

## 3. 同步与本地快照

- [x] 在归档 Git store 中流式读取所有普通 blob，不再按扩展名跳过。
- [x] 写入 staging，计算 SHA-256和大小，生成 MIME 与 storageKey。
- [x] 拒绝符号链接、子模块、非法路径、超限文件和总量超限。
- [x] manifest 完整后同卷原子发布。
- [x] 导入只写候选；SQLite active 切换、Board 索引和 revision 在同一索引事务中收敛。
- [x] 候选索引失败保留上一份 active 快照、revision、fileId 下载和 Board。
- [x] staging 崩溃恢复和旧快照清理。

## 4. 只读 API

- [x] 任务详情增加附件元数据列表。
- [x] 新增受 Session 权限保护的
  `/api/archive-files/:fileId?taskSpaceId=<taskSpaceId>` 下载接口；先授权再按空间查询
  当前/历史 fileId。
- [x] 禁止读取阶段导入 `archive-git-store`、执行 Git、读取凭据或访问远端。
- [x] 增加 `Content-Type`、`Content-Length`、`Content-Disposition`、`nosniff` 和安全文件名处理。
- [x] 未登录/无权限/缺失文件/非法 fileId 的错误矩阵。
- [x] 只记录脱敏错误，不返回服务端绝对路径。

## 5. UI

- [x] 归档任务详情显示附件名称、类型、大小和下载按钮。
- [x] 文本文件继续提供现有正文/摘要体验。
- [x] 二进制文件不内联渲染 HTML/SVG/JS，只触发下载。
- [x] 下载失败显示本地快照不可用提示，不自动触发 Git 同步。

## 6. 验证

### 聚焦测试

- [x] Git tree 中普通文件全部导入，含 `.png/.ps1/.xlsx/.class/.pen`。
- [x] `sync_archive_file` 不写正文，快照文件哈希与 Git blob 一致。
- [x] staging 写入失败、数据库提交失败、索引失败、重启恢复和清理失败。
- [x] 候选导入不退役 active；连续索引失败时旧 fileId 仍下载旧字节，只保留最新候选；
  重试成功后再切新 fileId。
- [x] 读取阶段 mock Git 子进程为抛错，详情和下载仍成功。
- [x] 未登录、普通成员、跨 TaskSpace、路径伪造和文件缺失测试。
- [x] 无权限空间真实/伪造 fileId 响应一致；可访问空间伪造、跨空间、当前/历史映射和
  带 `taskSpaceId` 的前端下载 URL 均有回归。

### 完整验证

```text
node --test <focused tests>
yarn test
yarn build
```

桌面 Rust 不涉及本任务；如共享 API 字段影响桌面协议，再补对应检查。

### 真实 E2E

- [x] 五个真实 TaskSpace 同步并核对文件数/字节数。
- [x] 关闭网络、禁用凭据后打开归档详情并下载 `.png/.xlsx/.ps1`。
- [x] 记录读取前后 Git 子进程数和远端连接数为 0。
- [x] 服务重启后直接读取快照。
- [x] 人为制造同步失败，旧快照和 Board 仍完整可读。
- [x] TaskSpace 删除/恢复和旧快照清理验证。

## 7. Spec 更新

- [x] 更新 architecture-and-runtime：同步/读取边界、taskSpace snapshot 生命周期。
- [x] 更新 scanning-and-persistence：schema v15、元数据表、本地文件存储。
- [x] 更新 http-and-filesystem：附件下载 API、权限、头安全和大小限制。
- [x] 新增归档快照运维/清理说明。

## 8. 风险文件

- `packages/server/database.js`
- `packages/server/team/archive-git-store.js`
- `packages/server/team/archive-git-sync.js`
- `packages/server/team/task-space-index.js`
- `packages/server/team/http.js`
- `packages/web/src` 中归档详情和下载入口
- 对应 v15 migration、store、sync、HTTP、UI 测试

## 9. 回滚点

1. 停止完整附件同步 scheduler。
2. 保留 v15 快照和 legacy SQLite 正文。
3. 关闭附件列表和下载入口。
4. 回退索引读取到 legacy 文本。
5. 不删除 snapshot 文件，等待清理工具或人工恢复。
