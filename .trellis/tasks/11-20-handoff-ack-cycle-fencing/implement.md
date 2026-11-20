# 实施计划：服务端 handoff ACK 轮次 fencing

## 前置

- 任务：`.trellis/tasks/11-20-handoff-ack-cycle-fencing`
- 影响包：`packages/server`（协议与状态机）、`packages/desktop`（ACK 发送与错误处理）、spec 文档。
- 依赖：任务 `11-20-handoff-second-cycle-cleanup` 已提供客户端轮次字段与重置逻辑。

## 执行清单

### 服务端

- [ ] 1. `packages/server/team/task-control/shared.js` `normalizeHandoffAck`：
      - 新增 `materializedAt`（≤24 字符，非空时校验 `YYYY-MM-DDTHH:mm:ss.sssZ`）；
      - 新增可选 `materializedRevision`（安全整数 ≥ 0，区分“未提供”和 0）；
      - 非法输入返回 `400 INVALID_INPUT`。
- [ ] 2. `packages/server/team/task-control/handoff.js`：
      - 新增 `assertHandoffCycle(row, ack)`；
      - 在 `readTask`/ownership 校验之后、`completed` 幂等判断与状态推进之前调用；
      - 不匹配抛 `409 HANDOFF_CYCLE_STALE`，`details` 携带当前 `materializedAt/materializedRevision`；
      - 拒绝路径不写审计；记录一条 warn 日志。
- [ ] 3. `packages/server/test/team-task-control.test.js` 新增覆盖（可复用现有 handoff fixture）：
      - 匹配轮次 ACK 成功；
      - 新一轮 pending 下旧轮次 cleaned/conflict ACK → `HANDOFF_CYCLE_STALE`，状态与审计不变；
      - 新轮次 ACK → `completed`；
      - 已完成终态：匹配轮次幂等、陈旧轮次拒绝；
      - 缺省字段保持兼容成功；
      - 非法 `materializedAt`/revision 返回 `400`。

### 客户端

- [ ] 4. `packages/desktop/src-tauri/src/agent/task_sync/handoff.rs` `handoff_ack_request`：携带 `materializedAt` / `materializedRevision`。
- [ ] 5. `packages/desktop/src-tauri/src/agent/task_sync/control.rs` `attempt_handoff_ack`：
      - 记录轮次为空时，用本地控制（`controls[execution_task_key]`）回填请求副本；
      - 识别 `HANDOFF_CYCLE_STALE`：warn 日志并保持 pending，不标记 done；
      - 不改变 `HANDOFF_LEASE_HELD`、网络失败等现有分支。
- [ ] 6. 客户端测试：
      - `handoff_ack_request` 字段存在/缺省；
      - mock `/handoff-ack` 支持可配置响应（默认 200）；
      - 409 `HANDOFF_CYCLE_STALE` 后 `ackState` 仍为 pending；
      - 旧记录从 control 回填轮次；
      - 状态机级：409 后新控制到达 → 重置 → 清理 → 新 ACK 成功。

### 规范与验证

- [ ] 7. `.trellis/spec/backend/desktop-realtime-sync.md` 更新 ACK 字段、`HANDOFF_CYCLE_STALE`、校验顺序、兼容/升级矩阵和测试要求。
- [ ] 8. 运行验证：
      - `yarn test`（或 `node --test packages/server/test/team-task-control.test.js`）
      - `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`
      - CI：推送 `main` 后 `gh workflow run windows.yml --ref main`，确认 `Rust unit tests` 与 Node 测试全绿。
- [ ] 9. E2E（真实客户端 + 真实服务端，禁止模拟服务端）：
      1. 准备一个处于新一轮 `source_cleanup_pending` 的测试任务；
      2. 在本机 `task-control-state.json` 注入旧轮次 `pending/cleaned` ACK（带过期 `materializedAt`），启动新构建客户端；
      3. 断言：服务端日志出现 `HANDOFF_CYCLE_STALE` 拒绝；服务端状态不被旧 ACK 推进；
      4. 断言：客户端随后按新控制重置并完成清理，服务端 `completed`，Board 卡片显示“认领与清理已完成”；
      5. 保存服务端日志、数据库/审计查询和 UI 截图到任务目录。
- [ ] 10. 发布顺序确认：先服务端、后客户端；回滚时先回滚客户端或保持字段兼容。

## 验证命令

```bash
yarn test
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
gh workflow run windows.yml --ref main
```

本机无 Rust 工具链时，`cargo test` 通过 CI 执行；E2E 使用 CI 构建产物。

## 风险与回滚点

| 风险 | 缓解 |
| --- | --- |
| 旧客户端不发送轮次，仍可触发竞态 | 兼容路径 + 文档记录；后续可要求最小 Agent 版本 |
| 轮次字段格式/时钟问题导致误拒 | 只做字符串精确比较，不解析时间语义；控制面与 ACK 使用同一服务端写入值 |
| 拒绝后客户端一直 pending 重试 | 下一次控制同步按轮次重置；测试覆盖 409 后收敛 |
| 已完成终态的重复 ACK 被误判陈旧 | 先 fencing 后幂等；匹配轮次的重复 ACK 保持幂等 |
| 服务端/客户端版本错配 | 先服务端后客户端；旧服务端忽略未知字段 |

## 完成定义

- PRD AC1-AC5 全部可验证。
- `yarn test` 与 Rust 测试（本地或 CI）全绿。
- 真实客户端 E2E 通过并留证。
- spec 已更新。