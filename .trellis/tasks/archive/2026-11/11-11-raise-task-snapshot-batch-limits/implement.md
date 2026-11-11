# 提高任务同步批量上限实施计划

## 1. 开始前检查

- [x] 确认当前任务为 `raise-task-snapshot-batch-limits`。
- [x] 用户确认 PRD、设计和技术假设。
- [x] 记录开始提交 `10f72e0`；开始时只有本任务和三个无关任务目录未跟踪。
- [x] 保留本任务之外的任务目录、代码修改和用户文件。
- [x] 确认真实服务端 taskSpace revision `26`；pending 批次为
      `99657071-48db-434e-afb3-a0fd9a295631`、`clientSequence=27`、250 文件、5,648,600 字节。
      未修改真实数据库。

## 2. 核心实现

### 2.1 共享限制

- [x] 更新 `shared/task-snapshot.js`：
  - [x] `TASK_SNAPSHOT_MAX_FILES = 1024`
  - [x] `TASK_SNAPSHOT_MAX_BATCH_BYTES = 64 * 1024 * 1024`
  - [x] 新增 `TASK_SNAPSHOT_MAX_TRANSPORT_BYTES = 96 * 1024 * 1024`
  - [x] 更新超限错误文案并标记容量错误类型
- [x] 搜索并更新所有 64/8 MiB 常量消费者，确保没有独立漂移值。

### 2.2 客户端

- [x] `agent/live-sync.js` 导入共享文件和字节上限，并统一按解码后正文计算批次字节。
- [x] `splitLiveBatches()` 保留按任务分组的串行逻辑，使用新上限切批。
- [x] `agent/api.js`：
  - [x] 快照、任务空间预检、目录响应使用 96 MiB 运输上限。
  - [x] 大批次上传、预检和完整快照请求使用 120 秒超时。
- [x] 确认 `agent/task-snapshot-sync.js` 对已有 pending 批次复用原
      `batchId/clientSequence/files`，不生成替代批次。

### 2.3 服务端

- [x] `server/team/live-sync.js` 改为共享 1024 文件 / 64 MiB 上限。
- [x] `server/team/http.js` 将 Agent 大批次读取上限改为 96 MiB。
- [x] `server/team/task-snapshot-service.js` 使用共享业务上限并通过现有
      `groupTaskSnapshotFiles()` 做整批校验。
- [x] 将共享容量错误统一映射为 413 `BODY_TOO_LARGE`。
- [x] 保持普通 API 的 64 KiB JSON 限制不变。

### 2.4 文档和规范

- [x] 更新 `.trellis/spec/backend/desktop-realtime-sync.md` 的 64/8 MiB 契约。
- [x] 更新 `.trellis/spec/backend/http-and-filesystem.md` 的普通 JSON 和 Agent 大批次边界。
- [x] 更新相关运维说明：反向代理必须允许 96 MiB 运输体。
- [x] 不修改数据库 schema 或 Agent 协议版本。
- [x] 不新增配置项；限制由代码统一管理。

## 3. 自动测试

- [x] `tests/task-snapshot.test.js`
  - [x] 1024 文件通过，1025 文件拒绝。
  - [x] 64 MiB 通过，64 MiB + 1 字节拒绝。
  - [x] 单文件 1 MiB + 1 字节仍拒绝。
- [x] `tests/team-task-snapshot.test.js`
  - [x] 250 文件单任务批次成功。
  - [x] 250 文件 preflight 和覆盖冲突处理成功。
  - [x] 超限批次不增加 revision、文件、索引、audit 或 batch。
  - [x] CAS、幂等、任务目录完整性保持。
- [x] `tests/team-gitless-http.test.js`
  - [x] 10 MiB 合法 Agent 批次超过旧 9 MiB 请求体限制并可写入。
  - [x] 超过 96 MiB 的运输体返回 413。
  - [x] 普通 JSON 仍执行 64 KiB 上限。
- [x] `agent/test/task-snapshot-sync.test.js`
  - [x] 250 文件 pending 使用原 batchId/clientSequence/files 重试成功。
  - [x] 上传不重叠，限流重试和 cursor 推进保持。
- [x] `agent/test/api.test.js`
  - [x] 完整快照/目录响应超过旧 16 MiB 上限时可读取。
- [x] 更新所有仍断言 64/8 MiB 的旧测试。

## 4. 真实 E2E

前置条件：

- 使用当前真实 `mdp-backend-service / dev` taskSpace；
- 服务端数据库先创建可恢复快照；
- 不改写任务文件，不重新绑定项目，不删除 cursor；
- 服务端由执行 Agent 按用户授权启动。

步骤：

1. [x] 启动包含新上限的服务端。
2. [x] 观察当前客户端自动重试 `10-03-e2e-oracle` pending 批次。
3. [x] 核对服务端 revision 从 26 推进，250 个文件存在且摘要与本地一致。
4. [x] 观察其余 110、67 文件任务继续通过。
5. [x] 确认全部 135 个本地任务同步完成，`initialSyncCompleted=true`。
6. [x] 确认 Board 任务数、归档任务和关键任务详情无丢失。
7. [ ] 连续重启客户端。本轮通过运行中的真实客户端、持久化 cursor 和 Board 数据完成验收，
      未执行额外的客户端生命周期重启。

## 5. 质量门禁

- [x] 先运行相关 Node 测试：54/54 通过。
- [x] 全部开发完成后只执行一次完整 `npm test`：501 项，489 通过、12 跳过、0 失败。
- [x] 只执行一次 `npm run build`：TypeScript 和 Vite 生产构建通过。
- [x] 目标 JS 文件 `node --check` 通过。
- [x] 目标 JS 文件 `oxfmt --check` 通过。
- [ ] Windows sidecar/客户端构建通过。
- [ ] GitHub Windows 构建通过。
- [x] 真实 pending 自动恢复 E2E 通过。
- [x] 检查 diff 中没有无关格式、数据库文件、截图或测试临时文件。
- [x] 更新任务检查记录和 E2E 报告。

## 6. 提交与交付

- [ ] 只暂存本任务明确路径。
- [ ] 提交代码、测试和规范。
- [ ] 推送当前任务分支。
- [ ] 用户确认后归档任务并记录 journal。

## 7. 约束

- 不在实施过程中反复构建；只在所有代码完成后执行一次最终构建验证。
- 不使用破坏性 Git 命令，不重置真实服务端数据库。
