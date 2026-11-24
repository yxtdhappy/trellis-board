## Self-Check Complete

> 审查方式：主会话完成后，另起独立只读 sub-agent 对未提交 diff 做源码级核对（本机无 cargo/rustc，无法编译）。本报告整理该审查结论与主会话的修复；编译验证留待 CI。

### Files Checked
- `packages/desktop/src-tauri/src/agent/task_sync/control.rs`（`:592-638`）
- `packages/desktop/src-tauri/src/agent/task_sync/initial_sync.rs`（`:1087-1095`）
- `packages/desktop/src-tauri/src/agent/task_sync/tests/inactive_controls.rs`（新增）
- `packages/desktop/src-tauri/src/agent/task_sync/tests/mod.rs`
- `.trellis/tasks/11-24-archive-control-log-noise/{prd.md,design.md,implement.md}`

### Issues Found and Fixed
1. `tests/inactive_controls.rs:126-131` — 「有租约释放」用例用了 `state=archived` + 活跃路径 `.trellis/tasks/task-a`，与现场归档 control 形状不符，将来若有人给该函数加 archive 短路过滤，测试仍会通过 → 改为真实归档路径 `.trellis/tasks/archive/2026-11/task-a`，并注释说明释放逻辑只认 `execution_task_key`。
2. `tests/inactive_controls.rs:31-40` — `Reassigned` 状态未覆盖 → 增加 `reassigned-task` 用例与断言。
3. `prd.md:41`（R2）— 原文要求 `upload.rs:66-79` 的等价集合也加过滤，与 design §3.3「不改」矛盾 → R2 改为「`upload.rs` 输入已在 `upload.rs:82` 过滤 archive，本次不改」，与实现一致。
4. `prd.md:45`（R5）、`prd.md:52-54`（验收）— 「无租约不打印」「与实际释放次数一致」无法按字面断言：`logging::LOG_FILE` 是进程级 `OnceLock`，测试进程无法稳定捕获日志；`info` 打在释放尝试前，失败路径也会留一行 → 措辞改为「无租约不发起释放，日志点位于租约分支内故不输出」「与实际进入释放流程次数一致」。
5. `design.md:150` — 行数预估过时 → 更新为 `control.rs` 675、`initial_sync.rs` 1101、新测试 180。

### Issues Not Fixed
- `tests/inactive_controls.rs:82-90` — 没有断言「无租约时不产生日志」，只断言「无 `/release` 请求」。原因：`crate::logging` 的 `LOG_FILE` 为进程级 `OnceLock`（`packages/desktop/src-tauri/src/logging.rs:12-16`），其他测试可能已抢先 `init`，无法稳定重定向；改造 logging 注入超出本任务范围。当前由日志位置（`control.rs:600-608` 位于 `Some(lease)` 分支内）保证。
- `pull`/`upload` 集合不变的断言 — 未新增直接断言；源码路径可证 archive 不会进入 dirty/deferred（`local_files.rs:594-596`、`cursor.rs:194-203`），由现有测试覆盖。
- 手工验收（真实客户端 + 100+ 归档空间）与 CI `cargo test` 未执行 — 前者待用户，后者本机无工具链。

### Verification Results
- TypeCheck: skipped — 本机无 cargo/rustc；CI `windows.yml:159-161` → `scripts/test.mjs:138-139` 执行 `cargo test`。
- Lint: skipped — 仓库未配置 cargo fmt/clippy 门禁。
- 行数/LF：pass（675/1101/180 行；`i/crlf` 计数 0；新文件 LF）。
- 符号与签名核对：pass（`TaskControl` 13 字段、`mock_api_server` 四元组、`claim_remote_task`/`release_remote_task` 响应解析、`cleanup_archived_residue` 的 active/archive 推导、`is_archive_task_dir` 作用域等均已逐条核对，未发现编译阻断项）。

### Summary
Checked 4 个代码文件 + 3 个任务产物，发现 5 处问题，修复 5 处，3 项开放（日志断言、集合断言、手工/CI 验证），0 个已知编译阻断项。
