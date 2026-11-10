# 实施计划：实时同步阻塞主线程与误弹窗

## 0. 开始前检查

- [x] 确认当前任务为 `11-10-live-sync-main-thread-stall` 且状态已切换为 `in_progress`。
- [x] 读取 `trellis-before-dev` 并按 `implement.jsonl` 注入后端、桌面实时同步和质量规范。
- [x] 检查工作区已有改动，不覆盖或回滚无关文件。
- [x] 与 `11-10-team-sync-line-ending-normalization` 的改动范围交叉检查，避免同一段 `agent/live-sync.js` 冲突。

## 1. Agent dirty 过滤与 pending 清理

- [x] 在 `agent/live-sync.js` 增加按项目一次计算的 dirty path 过滤，watcher 路径仅保留 Git diff 中的 tracked 修改、untracked 文件和 `.trellis/.developer`。
- [x] Git 已收敛路径不读取正文、不写 pending、不调用 preflight。
- [x] `_emitPendingDecisions()` 和 `_retryPendingUploads()` 在展示或上传前清理全部已收敛的 decision/upload。
- [x] Git 状态检查失败时保留 pending 并记录可诊断 warning，不能静默丢弃。
- [x] 增加测试：HEAD 等值写回不上传、真实未提交修改仍上传、旧 pending 自动清理、Git 失败保留 pending。

验证：

```powershell
node --test tests/desktop-realtime-apply.test.js
```

## 2. Agent 超时错误区分

- [x] 修改 `agent/api.js`，用独立 `TimeoutError` 表示内部请求超时。
- [x] 显式 signal 取消仍映射为“Agent 请求已取消”。
- [x] 超时映射为“Agent 服务请求超时”，保留 `NETWORK_ERROR`、`retryable=true` 和 cause。
- [x] 增加不响应 HTTP 假服务的超时测试和 AbortController 显式取消测试。

验证：

```powershell
node --test tests/desktop-realtime-apply.test.js
```

## 3. Worker 实时物化扫描

- [x] 扩展 `server/team/scan-worker.js`，增加 `live-materialize` 消息。
- [x] Worker 在系统临时目录复制 `.trellis/tasks`、`.trellis/workspace`、`.trellis/.developer`，应用实时 rows，调用 `scanRepository()`，计算 taskVersion，并始终清理临时树。
- [x] 扩展 `server/team/task-index.js`，提供 `materializeLiveProject(project, rows)`，沿用 worker 单飞、180 秒超时、崩溃拒绝和 `close()` 生命周期。
- [x] 增加 worker 测试：有效 rows 覆盖磁盘内容、扫描结果正确、临时目录删除、路径/符号链接拒绝和 worker 错误传播。

验证：

```powershell
node --test tests/team-realtime-sync.test.js
```

## 4. 服务端项目级重投影队列

- [x] 将 `server/team/live-sync.js` 的同步 `reapplyProject()` 改为每项目串行、按最新 revision 合并的异步调度。
- [x] `applyChanges()`、幂等重放、接管、`onProjectIndexed()`、`ensureProject()` 改为调度，不在 HTTP 请求栈等待全量扫描。
- [x] Worker 返回后比较当前 revision；旧结果丢弃并重新扫描最新快照。
- [x] 最新结果在主线程仅执行 `buildBoard()`、`replaceProjectIndex({ skipLiveHook: true })`、小型 SQLite 更新和事件发布。
- [x] 成功后才发布 `live.changed`；失败保留上一份 Board 与 revision，并按 1/2/4/最大 30 秒退避。
- [x] 服务关闭时终止 worker，停止定时重试，不产生未处理 Promise。
- [x] 增加注入式测试：请求先返回、多个 revision 合并、旧结果不回退、失败重试、成功事件只发布最新 revision。

验证：

```powershell
node --test tests/team-realtime-sync.test.js
node --test tests/team-events.test.js
```

## 5. 主线程延迟验收测试

- [x] 使用测试注入的 deferred live scanner，模拟长时间重投影。
- [x] 在扫描未完成时请求 `/api/health`，断言 200 且最大延迟 <1 秒。
- [x] 在至少 300 个任务的本地夹具上执行一次真实 worker 重投影，记录总耗时；该测试只断言主线程健康响应，不把文件系统绝对耗时设为 CI 硬门槛。
- [x] 复测当前真实项目基准，确认 `reapplyProject` 的复制、扫描、删除不再运行于 Board 主线程。

验证：

```powershell
node --test tests/team-realtime-sync.test.js
node --test tests/team-core.test.js
```

## 6. 桌面控制窗口焦点、去重与关闭

- [x] 扩充 `desktop/src-tauri/src/sidecar.rs` 状态：首次自动聚焦消费标记、用户关闭后的 focus suppressed。
- [x] 每个控制事件计算稳定 key；同任务同责任人 warning 原位替换，不追加重复项。
- [x] `publish_control()` 只有进程首次事件可以自动 `show/unminimize/set_focus`。
- [x] `pop_control()` 不再主动聚焦或重建隐藏窗口。
- [x] 对 `assignment_warning` 的 dismiss 改为 hide + 抑制聚焦，保留 pending 文件。
- [x] `desktop/ui/control.js` 为责任人确认增加始终可用的“稍后处理”，busy 时也不锁死窗口关闭能力。
- [x] `desktop/src-tauri/src/main.rs` 增加托盘“处理实时确认”，并让 `live-control` 的 CloseRequested 进入 hide + suppress 流程。
- [x] 扩展 `tests/desktop-package.test.js` 和 Rust 单元测试，覆盖首次聚焦、关闭后不聚焦、托盘恢复、去重和 pending 保留。

验证：

```powershell
node --test tests/desktop-package.test.js
cargo test --manifest-path desktop/src-tauri/Cargo.toml
```

`desktop-package` 通过；`cargo test` 因本机没有 Cargo/Rust 工具链未能执行。

## 7. Windows 真实 E2E

- [ ] 启动团队 Board、两个桌面客户端和一个 300+ 任务项目。
- [ ] 执行只改变已有任务文件、最终与 Git HEAD 一致的 merge/fast-forward，确认不产生责任人窗口。
- [ ] 对他人负责的任务制造真实未提交修改，确认仍出现一次责任人确认。
- [ ] 连续制造同任务多文件变化，确认桌面只保留一个可操作项。
- [ ] 首次事件后关闭窗口，继续制造变化，确认不自动显示或抢焦点。
- [ ] 从托盘“处理实时确认”恢复窗口，完成继续或接管。
- [ ] 停掉 Board 服务后点击“稍后处理”和系统 X，确认窗口立即退出且 pending 文件仍在。
- [ ] 重启服务，从托盘恢复并完成取消、继续或接管。
- [ ] 重投影期间连续采样 `/api/health`，记录最大延迟。
- [ ] 保存 Windows E2E 证据到任务目录的 `evidence/`。

## 8. 回归与文档

- [x] 跑完整 `npm test`。
- [ ] 执行一次最终桌面编译验证，不在中途重复构建（已尝试，Cargo 不在 PATH）。
- [x] 更新 `.trellis/spec/backend/desktop-realtime-sync.md`，记录 dirty 过滤、异步重投影、合并和失败语义。
- [x] 更新 `.trellis/spec/backend/architecture-and-runtime.md`，明确实时物化扫描不得位于 HTTP 主线程。
- [x] 更新桌面文档，记录首次提示、稍后处理、托盘恢复和 pending 保留行为。
- [x] 生成 `implementation-report.md`、`check-report.md`、`e2e-report.md`。
- [x] 更新 PRD 验收勾选与实施证据，再进入 commit/archive。

## 风险文件

- `agent/live-sync.js`
- `agent/api.js`
- `server/team/live-sync.js`
- `server/team/task-index.js`
- `server/team/scan-worker.js`
- `desktop/src-tauri/src/sidecar.rs`
- `desktop/src-tauri/src/main.rs`
- `desktop/ui/control.js`
- `tests/desktop-realtime-apply.test.js`
- `tests/team-realtime-sync.test.js`
- `tests/desktop-package.test.js`

## 回滚点

- Agent 过滤、服务端异步重投影、桌面窗口行为分为三个可独立回滚提交。
- 不包含 SQLite schema 变更，回滚代码后 `project_live_*` 数据仍可用。
- 如异步重投影出现一致性问题，先恢复同步读取当前投影，但不得恢复 HTTP 请求内同步全量扫描。
