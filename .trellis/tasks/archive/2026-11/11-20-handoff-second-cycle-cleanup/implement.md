# 实施计划：handoff ACK 状态按物化轮次隔离

## 前置

- 任务：`.trellis/tasks/11-20-handoff-second-cycle-cleanup`
- 影响包：`packages/desktop`（Rust Agent 状态机），无服务端 / 前端改动（除 spec 文档）。
- 关键文件：
  - `packages/desktop/src-tauri/src/agent/task_control.rs`
  - `packages/desktop/src-tauri/src/agent/task_control/tests.rs`
  - `packages/desktop/src-tauri/src/agent/task_sync/handoff.rs`
  - `packages/desktop/src-tauri/src/agent/task_sync/tests/handoff_and_errors.rs`
  - `packages/desktop/src-tauri/src/agent/task_sync/tests/support.rs`（如需扩展 mock `/handoff-ack`）
  - `.trellis/spec/backend/desktop-realtime-sync.md`

## 执行清单

- [ ] 1. 数据模型：`StoredTaskHandoff` 增加 `materialized_at: Option<String>`、`materialized_revision: Option<u64>`（均 `#[serde(default)]`），并在 `from_control` 中从 `TaskControl` 填充。
- [ ] 2. 同步更新所有 `StoredTaskHandoff` 字面量构造（`handoff_and_errors.rs` 三处），保证编译。
- [ ] 3. 合并逻辑：新增 `same_materialization_cycle`（规则见 `design.md` §4），修改 `upsert_handoff_control`：
      - 同轮：保留现有字段继承 + `source_cleanup_conflict` 兜底；
      - 新轮：不继承 ACK 字段，使用 `from_control` 默认值（含清空 `notified_state`）。
- [ ] 4. 单元测试（`task_control/tests.rs`）：
      - `same_cycle_preserves_done_handoff_ack`
      - `new_materialization_cycle_resets_stale_handoff_ack`（断言 pending、空 outcome、备份字段清空）
      - `legacy_handoff_without_cycle_epoch_resets_on_new_control`
      - 需要给测试 helper `control()` 增加轮次字段设置入口（直接改字段即可）。
- [ ] 5. 状态机级回归测试（`handoff_and_errors.rs`）：
      - 构造真实 Git 仓库 + 任务目录 + cursor baseline（参考 `handoff_source_fails_closed_on_baseline_or_git_uncertainty`）；
      - 预置上一轮 `ack_state=done/outcome=cleaned` 的 handoff 记录与对应控制；
      - 用新 `materializedAt`/`materializedRevision` 调用 `upsert_task_handoff_control` + `process_handoff_control`；
      - 断言目录被删除、`live-backups/<space>/handoff-*` 新备份生成、ACK 请求出现；
      - 如 mock server 缺少 `/handoff-ack` 路由，在 `support.rs` 增加 `POST .../handoff-ack` → `200 OK {}`，并断言 `requests` 中出现该路径。
- [ ] 6. 保持 `TASK_CONTROL_STATE_VERSION = 1` 不变；确认旧状态文件（当前本机 `task-control-state.json`）可被解析。
- [ ] 7. 运行验证：
      - `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`
      - 如环境允许，`cargo build --manifest-path packages/desktop/src-tauri/Cargo.toml`
- [ ] 8. 回归有效性：临时 stash 第 1-3 步实现，确认新增测试失败，再恢复。
- [ ] 9. 规范更新：`.trellis/spec/backend/desktop-realtime-sync.md` 的 handoff 契约补充：
      - 本地 `ackState/outcome/backup` 属于单个物化轮次；
      - `materializedAt`/`materializedRevision` 变化必须重置为 pending 并重新清理；
      - 同轮次才允许 pending 重试与 done 幂等；
      - 旧记录缺少轮次标识时按新一轮自愈。
- [ ] 10. 自查数据修复路径：说明升级后 `test1` 如何自动收敛（见 `design.md` §7），不写入任何手工修复脚本。

## 验证命令

```bash
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
```

CI 同命令见 `.github/workflows/windows.yml:161`。本任务不涉及 Node / Web 测试。

## 风险与回滚点

| 风险 | 缓解 |
| --- | --- |
| 误判同轮为新一轮，导致重复清理 | 轮次比较优先使用 `materializedAt`，同轮内由服务端保证稳定；补充同轮保留测试 |
| 误判新一轮为同轮，继续卡住 | legacy 缺失轮次按新轮处理；真实 `test1` 数据作为验收场景 |
| 状态文件兼容 | 新字段全部 `serde(default)`；不升 schemaVersion；旧客户端忽略未知字段 |
| 通知重复 | 前端 localStorage 去重键未变；仅持久页内提示会随新轮状态更新 |
| 回滚 | 纯客户端改动，回滚代码即可；状态文件仍可读 |

## 完成定义

- 全部验收标准（`prd.md` AC1-AC5）可验证通过。
- `cargo test` 全绿。
- spec 已更新。
- 当前 `test1` 的收敛路径有明确说明（或已在真实客户端验证）。