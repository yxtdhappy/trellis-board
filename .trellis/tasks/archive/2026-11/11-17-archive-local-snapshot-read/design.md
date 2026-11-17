# 归档附件本地快照与只读访问设计

## 1. 架构边界

```text
同步阶段（唯一允许远端 Git 的阶段）
  远端 archive tree
    -> Git fetch/blob read
    -> staging 目录
    -> 哈希/大小/MIME 校验
    -> 原子发布目录
    -> SQLite 元数据 + archive revision
    -> Board/task index 投影

读取阶段（禁止 Git 和远端）
  Session/Agent 权限校验
    -> SQLite 文件元数据
    -> 本地快照文件
    -> 文本预览或下载响应
```

本任务不复用 HTTP 请求时的 `git cat-file`。Git blob 只在同步任务内读取，发布后所有产品读取都依赖本地文件。

## 2. 本地存储

建议目录：

```text
<dataDir>/
  archive-snapshots/
    <taskSpaceId>/
      staging/<attemptId>/
      heads/<sourceHead>/
        manifest.json
        files/<sha256>
```

- `files/<sha256>` 以文件内容 SHA-256 命名，允许同一快照内去重。
- `manifest.json` 记录相对路径、storageKey、sha256、Git OID、大小、MIME 和发布状态。
- staging 完成后先 `fsync` 文件与目录，再通过同卷 rename 发布 `heads/<sourceHead>`。
- SQLite 事务只引用已完整发布的 snapshot；清理任务只删除没有被 active/candidate 指针、
  当前历史 fileId 或 `sync_archive_snapshot` 引用的目录。
- 删除 TaskSpace 时先标记快照 retired，再由清理任务删除文件；数据库回滚期间不得提前删文件。

## 3. 数据模型

目标 schema v15：

```text
sync_archive_snapshot
  task_space_id
  source_head
  status
  active
  storage_root
  file_count
  byte_count
  manifest_sha256
  published_at

sync_archive_file
  id
  task_space_id
  snapshot_id
  relative_path
  blob_oid
  sha256
  size_bytes
  mime_type
  storage_key
  task_id
  task_dir
  source_head
  text_excerpt
  updated_at

sync_archive_file_history
  id
  task_space_id
  snapshot_id
  relative_path
  sha256
  size_bytes
  mime_type
  storage_key
  content_text        # 仅保留 legacy 回退
```

- `storage_key` 是相对 `archive-snapshots` 的受控键，不接受绝对路径。
- `text_excerpt` 只用于轻量搜索/详情提示，不作为文件正文事实源。
- `sync_task_space.archive_snapshot_id` 指向当前 active 快照，
  `archive_candidate_snapshot_id` 指向等待索引激活的候选快照。
- 同一路径内容变化时生成新 fileId；旧 active fileId 复制到不可变 history，供索引失败期间的旧
  Board 和下载继续使用。
- v14 的 `content_text` 保留为 legacy 字段但停止写入；读取层在无本地快照时才回退 legacy 文本。
- 首次完成完整快照的 TaskSpace 使用本地快照；后续同步失败继续保持上一个已发布 head。

## 4. 同步与发布

1. 获取 TaskSpace 锁和当前已发布 head。
2. fetch 指定分支，读取归档 tree；拒绝符号链接、子模块和越界路径。
3. 对每个 blob：
   - 执行大小上限校验；
   - 流式读取到 staging；
   - 计算 SHA-256；
   - 识别 MIME；
   - 生成受控 storageKey。
4. 写入并校验 `manifest.json`。
5. `BEGIN IMMEDIATE` 导入候选：
   - 把当前 active fileId 复制到不可变 history；
   - 写入 `active=0` 的候选 snapshot、当前文件映射和 candidate 指针；
   - 内容变化时推进归档 revision，但不得退役当前 active；
   - 触发索引投影。
6. 索引事务重新校验 candidate 指针，在同一个 `BEGIN IMMEDIATE` 中退役旧 active、激活候选、
   写 Board/任务索引并推进 `archive_indexed_revision`。
7. 索引成功后清理旧候选和历史引用；索引失败时 active 与 candidate 同时保留。

任何浏览器请求、Board 查询或详情请求都不能进入上述同步函数。

## 5. 读取契约

### 任务详情

在现有任务详情响应中增加附件元数据：

```json
{
  "files": [
    {
      "id": "stable-file-id",
      "path": ".trellis/tasks/archive/2026-11/example/evidence/one.png",
      "name": "one.png",
      "sizeBytes": 12345,
      "mimeType": "image/png",
      "downloadUrl": "/api/archive-files/stable-file-id?taskSpaceId=<taskSpaceId>"
    }
  ]
}
```

不返回 storageKey、Git OID、绝对路径或凭据信息。

### 下载

建议接口：

```text
GET /api/archive-files/:fileId?taskSpaceId=<taskSpaceId>
```

- `taskSpaceId` 是服务端生成、前端不可省略的下载作用域；HTTP 入口解析并校验后传入服务层。
- 以当前 Session 用户先对 `taskSpaceId` 执行 `authorizeTaskSpace(..., 'view')`；授权通过后才校验和
  查询 fileId。
- 查询必须同时匹配 `task_space_id + id`：先查 `sync_archive_file`，找不到再查
  `sync_archive_file_history`；再从历史或当前本地快照读取。
- 禁止用户传任意 storageKey 或路径。
- 成功响应使用固定长度和下载头；HTML/SVG/JS 强制 `attachment`。
- 文件已不存在或校验失败返回 503 `ARCHIVE_LOCAL_FILE_UNAVAILABLE`，并留本地错误日志。

## 6. 文件类型和限制

- 接受所有普通文件，不按扩展名过滤附件。
- 单文件建议上限 16 MiB，单 TaskSpace 快照建议上限 512 MiB；超出时整个发布失败并保留上一份快照。
- MIME 只使用服务端扩展名映射和有限二进制探测，不接受客户端声明。
- 文本预览继续受 40,000 字符投影限制；下载不受该限制。
- 不在服务端打开、解析或执行 Office、脚本、类文件。

## 7. 重启、恢复与清理

- 启动时扫描 `archive-snapshots/**/staging`，删除超过 24 小时且无活动 attempt 的 staging。
- SQLite 有已发布 snapshot 时，服务启动不运行 Git，也不要求归档凭据。
- 清理采用引用计数/可达性检查：
  - 当前 active 与 candidate 指针；
  - 当前 `sync_archive_file_history` 的旧 fileId 引用；
  - 最近一次完整数据库备份仍可能引用的快照；
  - 正在执行的同步 attempt。
- TaskSpace 删除、项目删除、schema 回滚和数据库恢复必须保留“清理失败可重试”的状态，不把文件删除放在业务事务内。

## 8. 兼容与回滚

- v14 legacy 文本继续可读，避免升级后归档页面立即空白。
- 新代码回滚到 v14 时不得删除 v15 本地快照；旧代码只读 legacy 字段。
- 关闭“完整附件快照”功能时停止新同步，继续读取上一个完整快照和 legacy 文本。
- 清理任务必须能在服务重启后恢复。

## 9. 安全

- 所有读路径先做授权，再做 fileId 查询和本地路径解析。
- storageKey 和相对路径都必须使用固定的安全拼接函数，禁止客户端拼接。
- 本地快照不得包含密钥、凭据或 known_hosts 文件。
- 日志只记录 fileId、相对路径和错误码，不记录正文或绝对路径。
- 下载限制并发和超时，避免大文件拖住 HTTP 主线程。

## 10. 不做

- 不在请求时执行 `git cat-file`。
- 不把附件 base64 塞入 SQLite。
- 不建立项目工作副本。
- 不提供归档写回、commit、push 或脚本执行。
