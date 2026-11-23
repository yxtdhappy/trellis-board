# 任务认领状态面板支持手动关闭

## Goal

给桌面端 Board 右上角「任务认领状态」常驻提示增加手动关闭入口：用户关闭后当前轮次的提示不再显示，刷新/重启客户端仍保持关闭；新任务或同一任务的新一轮 handoff 冲突仍会重新出现。关闭只影响展示，不改变服务端 handoff 状态和本地副本保留策略。

## Background & Confirmed Facts

- 固定面板只过滤 `outcome === 'cleaned'`，冲突项与处理中项会一直渲染；面板没有关闭按钮（`packages/web/src/desktop/HandoffNotice.tsx:113`、`:184-226`）。
- 规范当前明确要求「冲突状态持续显示非模态页内提示；固定页内状态只展示冲突和处理中项」（`.trellis/spec/backend/desktop-realtime-sync.md:441`），本次需求要把它调整为「持续可见但允许用户手动关闭，按轮次重新显示」。
- 截图中的 4 条是真实冲突而非残留：`D:\wit\mdp-backend-web` 的任务目录已被 Git 跟踪且 `task.json` 有修改，清理按安全策略返回 `conflict/git_modified`（`packages/desktop/src-tauri/src/agent/task_sync/handoff.rs:781-803`）。
- 冲突不会自愈：客户端遇到 `source_cleanup_conflict` 或非空 outcome 直接 early return（`handoff.rs:847`），服务端 conflict 状态只接受幂等 conflict ACK（`packages/server/team/task-control/handoff.js:55-90`）。本地记录仅在控制面离开 `handoff_materialized + source_cleanup_pending|source_cleanup_conflict` 时被清理（`packages/desktop/src-tauri/src/agent/task_control.rs:417-433`）。
- 本地 handoff 记录已保存轮次 `materialized_at`（`task_control.rs:273`、`:306`），但返回给前端的 `HandoffNotice` 结构没有该字段（`task_control.rs:342-351`），前端无法区分「同一冲突」与「再次委派后的新冲突」。
- 前端现有 toast 去重键为 `executionTaskKey:handoffState:outcome`，持久化在 `trellis.handoff-notice-notified.v1`（`HandoffNotice.tsx:17`、`:49-51`）；规范同样记录该键（`.trellis/spec/backend/desktop-realtime-sync.md:437-439`）。
- 已有可复用的「按 id 持久化关闭」先例：`packages/web/src/lib/operation-visibility.js`。
- Web 纯逻辑测试用 `node --test "packages/*/test/*.test.js"`（根 `package.json`），现有测试从 `packages/web/src/lib/*.js` 直接导入；`HandoffNotice` 目前没有测试。
- 已排查其他提示：ProjectRail 的同步/worktree 告警、看板与插件加载错误横幅都属于条件驱动、条件消失后自动消失，不属于「永久驻留且无法关闭」；任务操作列表本身已支持关闭。本次不改它们。

## Requirements

### R1 关闭入口

- 在「任务认领状态」面板标题行提供关闭按钮（可点击、可键盘聚焦、有 `aria-label`）。
- 点击后立即隐藏面板当前全部条目，包括「另有 N 个任务」的折叠计数；不要求逐条关闭。
- 关闭动作不得发送 handoff ACK、不得删除或改写 `task-control-state.json` 记录、不得改变本地任务副本。
- 关闭后如出现未关闭的新通知（新任务，或同一任务的新轮次），面板重新出现并只展示未关闭项。

### R2 关闭状态持久化

- 关闭状态写入 `localStorage`，客户端刷新或重启后仍保持关闭。
- 关闭键必须包含轮次标识：`executionTaskKey + handoffState + outcome + materializedAt`（缺失时用占位值），确保同一任务再次委派产生新冲突时重新显示。
- 关闭时同步把对应 toast 去重键标记为已提示，避免关闭后因 visibilitychange 再次弹出同一 toast。
- `localStorage` 不可用、内容损坏或写入失败时降级为进程内关闭状态，面板仍可正常渲染和关闭，不抛异常。
- 存储条目需要去重并设上限，避免无限增长。

### R3 轮次标识贯通

- `handoff_notice_pending` 返回的每条通知新增 `materializedAt`（camelCase），值来自本地 handoff 记录的 `materialized_at`；缺失时返回 `null`。
- Web 端归一化必须容忍旧客户端缺少该字段；缺失时行为稳定（同一记录保持同一关闭键）。
- 新增字段对旧前端是向后兼容的附加字段；旧客户端缺少字段时新前端不得报错或丢弃通知。

### R4 回归测试

- Web 纯逻辑测试覆盖：归一化（含缺失 `materializedAt`）、关闭键随轮次变化、已关闭项过滤、`cleaned` 不进入固定面板、存储损坏时降级。
- Rust 测试覆盖：`notice()` 携带 `materialized_at`，序列化为 `materializedAt`；缺失时为 `null`。

## Key Decisions

- 采用「面板级关闭 + 按通知键记住关闭」：一次点击关闭当前全部条目，但持久化粒度是单条通知键，保证之后只显示新增项。
- 轮次标识使用 `materializedAt`（缺失回退为空），与既有「ACK 状态属于单次物化轮次」的判定口径一致（`task_control.rs:357-371`、`desktop-realtime-sync.md:425-430`）。
- 不新增服务端接口，不改 conflict 收敛策略；关闭是纯展示层行为。
- 纯逻辑抽到 `packages/web/src/lib/handoff-notice.js`，沿用 `sync-notice.js` / `operation-visibility.js` 的可测试模式。

## Out of Scope

- 服务端增加「确认保留本地副本 / 重试清理」的冲突收敛接口。
- 修改「Git 已跟踪目录」的清理语义或自动删除 tracked/modified 副本。
- 给 ProjectRail 同步告警、看板/插件加载错误横幅等其他提示增加关闭按钮。
- 修改桌面原生通知（Windows Toast）行为或通知权限策略。

## Acceptance Criteria

- [ ] AC1：存在 `conflict` 通知时，点击面板关闭按钮后面板立即消失；重启客户端后同一轮次仍不显示。
- [ ] AC2：同一任务再次委派产生新的 `materializedAt` 后，即使上一轮已关闭，面板也会重新显示该新轮次通知。
- [ ] AC3：关闭旧通知后出现新任务通知时，面板只显示新通知，不恢复已关闭项。
- [ ] AC4：关闭前后 `task-control-state.json` 中 handoff 记录（`outcome/reason/ackState`）不变，且没有新增 handoff-ack 请求。
- [ ] AC5：`localStorage` 不可用或内容损坏时，面板正常渲染，关闭按钮在当前会话内生效且不报错。
- [ ] AC6：`yarn test`、`yarn build`、`cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` 全部通过；不引入新依赖。

## Notes

- 验收需要桌面客户端重新构建后手工确认 AC1–AC4；AC5/AC6 由自动化测试与构建覆盖。
- 2026-11-23 验证记录：`yarn test` 通过（695 tests，693 pass，2 skip，0 fail），`yarn build` 通过（`tsc -b` + vite）。
- `cargo test` 未执行：本机未找到 `cargo`/`rustc`（`Get-Command`、用户与机器 `PATH` 均无 Rust 工具链）。
  Rust 侧改动仅为 DTO 字段与 `notice()` 赋值，并新增两条单测；需在有 Rust 工具链的环境补跑 AC6 的
  `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`。
- 未提交：按全局规则，提交需用户明确要求。