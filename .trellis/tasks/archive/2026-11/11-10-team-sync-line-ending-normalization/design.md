# 实时同步换行规范化设计

## 1. 架构边界

LF 规范化分两层：

1. 服务端是权威层：所有新写入的实时文本按 LF 存储、比较和收敛。
2. 新客户端是体验层：拉取时识别仅换行差异，直接写回规范内容，不制造无意义冲突。

不修改 Trellis Python，也不迁移历史实时行。

## 2. 共享纯函数

新增 `shared/live-text.js`，只包含一个明确规则：

```js
normalizeLiveText(content) {
  return String(content).replaceAll('\r\n', '\n')
}
```

服务端和 Agent 都复用该函数，避免两侧自行实现后规则漂移。

不使用 Unicode normalization、trim、尾随换行补齐或 JSON 序列化比较。

## 3. 服务端写入

`normalizeFiles` 当前先校验：

```text
sha256(客户端原始 content) === file.sha256
```

校验通过后构造规范文件：

```text
content = normalizeLiveText(原始 content)
sha256 = sha256(content)
```

因此：

- 完整性校验仍针对客户端实际发送的字节；
- 存储、请求哈希、任务投影和后续比较都使用 LF 内容；
- 同一 `batchId` 的 CRLF/LF 重试不会产生不同语义哈希。

## 4. 服务端 no-op

`applyChanges` 查询现有实时行时增加 `deleted`、`sha256` 和 `content_text`。

文件按以下规则分类：

- `upsert` 且现有行未删除、SHA 相同：no-op；
- `delete` 且现有行已删除或不存在：no-op；
- 其他情况：进入 appliedFiles。

no-op 不修改内容或 revision。若需要阻止更旧批次回写，可只更新 `source_client_sequence`、来源设备和 `updated_at`。

整批都是 no-op 时沿用现有“零应用文件”分支：只记录批次与审计，不触发重投影和 SSE。

## 5. Git 收敛

`convergeGit` 读取 Git 工作区文本后先 `normalizeLiveText`，再计算 SHA。

新写入的 `project_live_file.sha256` 已经是 LF 内容的 SHA，因此：

```text
CRLF Git 工作区 -> normalize -> LF -> SHA
LF 实时内容 -> SHA
```

两侧一致时删除实时覆盖行。删除状态仍按现有逻辑比较。

## 6. Agent 拉取

`_backupConflicts` 增加文本等价判断：

```text
operation === upsert
local 和 remote 都是规范 UTF-8
normalizeLiveText(local) === normalizeLiveText(remote)
```

满足时：

- 不加入 conflicts；
- 不创建备份；
- 不生成 `remote_overwrite`；
- 后续正常原子写回 remote LF 内容；
- `expectedWrites` 和 suppression 使用 remote 内容 SHA。

不允许用该判断绕过路径、符号链接、文件大小或 UTF-8 校验。

## 7. 数据与兼容

- 不新增数据库列，不提升 schema。
- 不迁移历史 `project_live_file`；部署前提是远端实时内容已全部为 LF。
- 服务端仍会兼容旧客户端上传 CRLF，因为 ingest 会规范化；但不保证旧客户端不显示一次拉取冲突。
- 新客户端是验收基线。

## 8. 风险

- 规范化后远程内容不再保留客户端原始 EOL，这是本任务明确选择。
- 如果某文本故意使用混合 CRLF/LF，服务端会把它统一为 LF；白名单 `.trellis` 文档不允许这种语义差异。
- 若已有非 LF 实时行未迁移，首次规范化比较可能产生一次 revision；用户已确认不处理这一场景。
