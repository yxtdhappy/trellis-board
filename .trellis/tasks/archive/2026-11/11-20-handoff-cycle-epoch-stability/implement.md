# 实施计划：稳定 handoff 物化轮次标识

## 前置

- 任务：`.trellis/tasks/11-20-handoff-cycle-epoch-stability`
- 影响包：`packages/server`（任务控制语句、fencing、测试）、spec。
- 客户端无需改动；本机已安装 CI 新构建（含 fencing 客户端逻辑）。

## 执行清单

### 服务端

- [x] 1. `packages/server/team/task-control/shared.js` `updateTaskAssignee`：
      改派时清空 `materialized_at`、`materialized_revision`、`materialized_manifest_sha256`、
      `materialized_by_agent_id`，保留 `materialization_state='pending'` 和 handoff_state 规则。
- [x] 2. `shared.js` `updateTaskFromUpload`：
      `materialized_at` 仅在“目标写入者 + 当前为空”时写入；后续上传不改写。
      检查 `packages/server/team/task-control/uploads.js` 的参数绑定顺序并同步调整。
- [x] 3. `shared.js` `updateTaskCommandComplete`：
      `materialized_at = COALESCE(materialized_at, ?)`、
      `materialized_by_agent_id = COALESCE(materialized_by_agent_id, ?)`，revision 继续写入。
- [x] 4. `packages/server/team/task-control/handoff.js` `assertHandoffCycle`：
      `materializedAt` 优先且忽略 revision 差异；仅 at 缺失时比较 revision；两者缺失走兼容。
- [x] 5. `packages/server/test/team-task-control.test.js`：
      - 同轮多次上传后 at 稳定；
      - at 匹配 + revision 不同 → ACK 成功；
      - 改派清空并重新生成 at；旧 at → `HANDOFF_CYCLE_STALE`；
      - 无上传的 assign_task 由 completeCommand 补写 at；
      - 缺省字段兼容；
      - 检查并调整受影响的现有断言（例如原先期望上传/命令推进 materialized_at 的用例）。

### 规范

- [x] 6. `.trellis/spec/backend/desktop-realtime-sync.md`：
      - 定义 `materialized_at` 为“本轮首次物化时间”；
      - 改派清空、首次上传写入、completeCommand 只补写；
      - fencing 以 at 为主、revision 仅在 at 缺失时兜底；
      - 测试要求补充同轮稳定性用例。

### 验证

- [x] 7. 目标测试（必须）：
      `node --test packages/server/test/team-task-control.test.js`
- [x] 8. 全量 Node 测试（如允许）：`yarn test`。
- [x] 9. 客户端编译/测试：本机无 Rust 工具链，本次客户端无代码改动；由 v0.4.50 CI 构建验证。
- [x] 10. 重启本地服务端加载修复（`node packages/server/index.js`），确认端口 4317。
- [x] 11. 真实 E2E A（正常流程）：
      - 当前测试任务 `handoff-manual-e2e-114216` 处于 conflict/missing；
      - 保持新客户端运行，`handoff-test.py delegate handoff-manual-e2e-114216 yhj` 重新物化来源副本；
      - 再 `delegate ... kyf`，等待清理；
      - 断言：服务端 `completed`、本机目录删除、审计一条 cleaned、**无** `HANDOFF_CYCLE_STALE` 拒绝日志。
- [x] 12. 真实 E2E B（陈旧 ACK）：
      - 带回 yhj → 停止客户端 → 委派 kyf → `inject-stale` → 启动客户端；
      - 断言：服务端拒绝日志出现、旧 ACK 不写审计、新轮次完成、UI 绿色完成。
- [x] 13. 更新任务记录与 E2E 报告（`e2e-report.md`、`e2e-board-after.png`），归档。

## 验证命令

```bash
node --test packages/server/test/team-task-control.test.js
# 可选：
yarn test
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
```

## 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 改派清空 at 影响其他依赖它的功能 | 全仓搜索 `materialized_at` 使用点；测试覆盖控制面/handoff/备份 |
| 同轮 revision 更新被 fencing 忽略导致跨轮误放行 | at 在改派时清空并重新生成，跨轮 at 必变；revision 仅兜底 |
| 旧数据 at 语义变化 | 无迁移；下一次改派重建；历史 completed 任务不受影响 |
| 服务端重启影响客户端 | 客户端自动重连；E2E 前确认端口与日志 |
| 回滚 | 纯服务端语句/比较逻辑改动，回滚代码即可；无 schema 变更 |

## 完成定义

- PRD AC1-AC5 可验证。
- 目标 Node 测试通过（如允许执行）。
- 真实 E2E A/B 通过并留证。
- spec 更新，任务归档。