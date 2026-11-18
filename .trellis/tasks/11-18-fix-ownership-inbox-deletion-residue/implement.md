# 实施计划

## 当前状态

- 服务端、客户端、Rust 回归测试和规范回写已完成。
- 服务端聚焦测试、Trellis validate、IDEA 静态检查通过。
- Rust 编译/测试和真实 Windows 客户端 E2E 尚待具备 Rust 工具链及新桌面包的环境执行。

## 前置门禁

- [ ] 用户明确批准最终规划摘要。
- [ ] 执行 `python ./.trellis/scripts/task.py start 11-18-fix-ownership-inbox-deletion-residue`。
- [ ] 确认当前活动任务切换为目标任务，保留其他未提交改动不动。

## 实施步骤

### 1. 服务端删除契约

- [ ] 修改 `packages/server/team/task-ownership-inbox.js`：
  - [ ] `normalizeDelete()` 允许省略 `taskId`，保留 `taskDir` 必填校验；
  - [ ] inbox 删除语句按 `project_id + source_task_space_id + source_agent_id + task_dir` 精确匹配；
  - [ ] 保持旧 `taskId + taskDir` 请求兼容。
- [ ] 扩展 `packages/server/test/task-ownership-inbox.test.js`：
  - [ ] 无 `taskId` 的删除成功；
  - [ ] `taskId` 与目录 basename 不一致仍按 taskDir 删除；
  - [ ] 两个 Agent 来源隔离；
  - [ ] 重复删除幂等；
  - [ ] 缺少或非法 taskDir 整批拒绝。

### 2. 客户端删除请求

- [ ] 修改 `packages/desktop/src-tauri/src/agent/task_sync/ownership_inbox.rs`：
  - [ ] `sync_ownership_inbox()` 的 deletes 只发送 `taskDir`；
  - [ ] 删除 `read_ownership_inbox_task_id()` 与 basename fallback；
  - [ ] 不改变 upsert 的稳定 taskId、fingerprint 和 title 逻辑。

### 3. 客户端安全清理流程

- [ ] 增加候选目录并集：
  - [ ] `ownership_pending.keys()`；
  - [ ] `pending_rejected.keys()`；
  - [ ] 过滤归档路径并去重。
- [ ] 增加具体目录缺失判定：
  - [ ] 父目录 `.trellis`、`.trellis/tasks` 正常时才继续；
  - [ ] 复用 `protocol::resolve_task_dir_under()`；
  - [ ] 只把逐项 `NotFound` 视为删除；
  - [ ] 根缺失、不可读、symlink、异常 IO 全部失败关闭。
- [ ] 增加统一收敛：
  - [ ] 先 `PUT ownership-inbox` 删除；
  - [ ] 超过 200 项时复用现有批次上限分批，全部批次成功后才改 cursor；
  - [ ] 成功或旧服务端 404/405 后，用一个 `write_cursor` patch 同时清理两份状态；
  - [ ] 网络/5xx/branch 失败不写 cursor；
  - [ ] 重复调用无变化时不落盘、不发无效状态事件。

### 4. 接入现有触发链

- [ ] `watch_loop()`：
  - [ ] 在初始同步完成且持有 taskSpace 锁时，先清理本次明确删除目录的摘要；
  - [ ] 随后仍调用原 `upload_dirty()`；
  - [ ] 摘要清理失败不阻断普通墓碑上传。
- [ ] `validate_ownership_binding()`：
  - [ ] 在 ownership 索引刷新成功后，用 `cursor candidates - localDirs` 清理；
  - [ ] 失败只告警，后续 watcher/重启继续重试。
- [ ] `list_task_ownership()`：
  - [ ] 先执行缺失摘要清理；
  - [ ] 再处理剩余本地任务；
  - [ ] 不得先清 cursor 再发 delete。

### 5. Rust 回归测试

- [ ] `pending_rejected` 清理存在但 `ownership_pending` 已丢失时仍能收敛。
- [ ] 目录存在时不清摘要。
- [ ] `.trellis/tasks` 缺失时不清摘要、不发请求。
- [ ] 目标路径是 symlink 或异常类型时失败关闭。
- [ ] 服务端请求失败时 cursor 两份状态保持不变。
- [ ] 删除成功后两种状态在同一个 cursor 更新中移除。
- [ ] mock server 捕获的 delete 只有 `taskDir`，不含猜测 taskId。
- [ ] watcher 删除、启动校验、打开归属界面三条路径都复用同一行为。

### 6. 规范同步

- [ ] 更新 `.trellis/spec/backend/task-ownership-and-conflict-idempotency.md`：
  - [ ] 明确 inbox delete 以 `taskDir` 为目录身份；
  - [ ] 明确明确删除、父目录不可读和网络失败的矩阵。
- [ ] 更新 `.trellis/spec/backend/desktop-realtime-sync.md`：
  - [ ] 明确 cursor 两份状态作为删除重试账本；
  - [ ] 明确只有远端确认或旧服务端无能力后才清本地状态。

## 最终验证

按项目约束，所有开发完成前不反复编译；完成全部代码后只执行一次最终验证批次。

- [ ] `node --test packages/server/test/task-ownership-inbox.test.js`
- [ ] `node --test packages/server/test/team-gitless-http.test.js`
- [ ] `cargo fmt --manifest-path packages/desktop/src-tauri/Cargo.toml --check`
- [ ] `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`
- [ ] `python ./.trellis/scripts/task.py validate 11-18-fix-ownership-inbox-deletion-residue`
- [ ] `git diff --check`

## 真实 E2E

使用实际运行的 server 和 Windows desktop：

1. 创建目录名与 taskId 不同的空分支任务。
2. 确认 `/api/ownership-inbox` 返回 1，ProjectRail 显示待归属。
3. 直接删除本地任务目录，不点击归属处理。
4. 在 5 秒内核对：
   - `sync_task_index` 对应该任务为 0；
   - `sync_task_ownership_inbox` 对应来源行为 0；
   - `/api/team/status.ownershipInboxCount=0`；
   - cursor 不再包含 `ownershipPending/pendingRejected`；
   - ProjectRail 不再显示待归属或服务端拒绝。
5. 退出并重开客户端，再次确认没有复活。
6. 临时停止服务端后删除另一探针，确认 cursor 保留；恢复服务端后自动重试并归零。
7. 临时让 `.trellis/tasks` 不可读，确认其他待归属摘要不会被批量清除。
8. 记录命令、API 响应、SQLite 查询、日志和重启结果到任务 E2E 报告。

## 风险点

- watcher 删除事件与目录移动事件可能相邻发生；必须依赖逐任务 `stat`，不能把空扫描结果当全删除。
- 服务端必须先升级，否则新客户端的无 taskId 删除仍会被旧服务端拒绝。
- `pendingRejected` 也可能来自非待归属拒绝；只能对“目录明确不存在”的任务清理，不能按原因粗删。
