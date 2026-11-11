# 任务同步批量上限代码检查报告

## 1. 检查范围

- PRD、设计和实施计划中的 1024 文件 / 64 MiB 业务上限。
- 96 MiB Agent JSON 运输上限；普通 JSON 仍为 64 KiB。
- 客户端大响应、上传与预检 120 秒超时。
- 250 文件 pending 原 batchId/clientSequence/files 重试。
- 单文件 1 MiB、CAS、整任务目录、归档移动、幂等、限流。
- 并行任务目录和无关文件隔离。

## 2. 检查结论

实现级检查和提交前边界复核均已完成。产品已确认 96 MiB 是硬运输上限，见第 7 节。
实现使用 `shared/task-snapshot.js` 作为业务容量和运输容量的单一所有者，
`agent/live-sync.js` 与 `server/team/live-sync.js` 已移除独立的 64/8 MiB 常量。

服务端容量错误会映射为 413 `BODY_TOO_LARGE`，并在写入事务开始前失败；超限回归断言
taskSpace revision、文件和索引均不变化。

`agent/task-snapshot-sync.js` 未改动 pending 数据格式。250 文件失败批次恢复时复用原
`batchId=99657071-48db-434e-afb3-a0fd9a295631`、`clientSequence=27` 和完整 files 数组。

## 3. 自动验证

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 聚焦测试 | `node --test tests/task-snapshot.test.js tests/team-gitless-http.test.js tests/team-task-snapshot.test.js agent/test/api.test.js agent/test/task-snapshot-sync.test.js` | 54/54 通过 |
| 全量测试 | `npm test` | 501 项：489 通过、12 跳过、0 失败 |
| 语法 | 目标 JS 文件 `node --check` | 全部通过 |
| 格式 | 目标 JS 文件 `oxfmt --check` | 全部通过 |
| Web 构建 | `npm run build` | TypeScript + Vite 通过 |
| 空白错误 | `git diff --check` | 通过 |

Web 构建仅有既存的大 chunk 警告，不影响构建成功。

## 4. 代码检查关注点

- 业务上限：1024 文件 / 64 MiB。
- 运输上限：96 MiB。
- 单文件上限：1 MiB。
- pending 迁移：无。
- 数据库 schema 变化：无。
- Agent 协议版本变化：无。
- 真实服务重启：已由执行 Agent 启动 team 服务 PID `34124`。
- 真实 AppData 数据库：真实客户端按正常同步协议推进到 revision `135`；E2E 前已创建并校验备份。

## 5. 尚未完成

- Windows sidecar、Tauri 和 GitHub Windows 构建。

## 6. 真实 E2E

- [x] 原 `99657071-48db-434e-afb3-a0fd9a295631`、`clientSequence=27` pending 批次
      在 revision `27` 自动恢复，写入 `250` 个文件、`5,648,600` 字节。
- [x] taskSpace 最终 revision 和 indexed revision 均为 `135`，135 个任务索引、1518 个活跃文件，
      `last_error=null`。
- [x] 本地与服务端 1518 个任务文件逐项对照，路径、SHA-256 和正文差异均为 `0`。
- [x] 客户端显示 `mdp-backend-service 已关联 · 同步正常`、分支 `dev`，Agent binding
      `initialSyncCompleted=true`、`liveSyncStatus=ready`。
- [x] 归档索引可搜索到 `10-03-e2e-oracle`，Oracle 任务 250 文件与服务端完全一致。
- [x] 服务端和 Agent 在本次测试窗口内 `ERROR=0`；一次瞬时 ETIMEDOUT 后自动恢复。
- [x] 完整证据记录见 `e2e-report.md`；现场截图在验收后已清理。

## 7. 提交前边界复核

提交前独立实测了一个 64 文件、正文合计 64 MiB 的请求：

| 正文内容 | JSON 请求体 |
| --- | --- |
| 普通 ASCII | 67,113,836 字节 |
| 全部反斜杠 | 134,222,700 字节 |
| 全部 `0x01` 控制字符 | 402,658,156 字节 |

后两种都会先被 96 MiB 运输上限拒绝。产品已确认采用以下口径：

- 64 MiB 是正常文本任务的业务目标；
- 96 MiB 是编码后 JSON 的硬运输上限；
- 超过 96 MiB 时返回 `413 BODY_TOO_LARGE`，即使解码后正文不超过 64 MiB；
- 不把运输上限提高到数百 MiB，优先限制单请求内存和拒绝服务风险。

该口径已同步到 PRD、设计、后端规范和运维文档；现有自动测试已覆盖超过 96 MiB 返回 413
以及普通 JSON 仍限制为 64 KiB。E2E 临时文件已清理，不纳入提交。
