# 实施清单

> 分支：`main`（base_branch `team-board`）。用户已 review 并批准实施；不自动 commit/push。
> 2026-11-24 执行记录：E1–E5 完成；E6 因本机无 Rust 工具链未执行，交 CI；E7/E8 待用户验收与确认提交。

## E1 基线确认
- [x] `git status --short` 记录工作区已有改动，保持原状不碰（本次只改 task_sync 下 3 个已有文件 + 1 个新测试文件）。
- [x] 行号确认：旧 WARN 在 `control.rs:600-604`；`inactive_control_dirs` 在 `initial_sync.rs:1087`（实施后为 `:1087-1095`）。
- [x] `is_archive_task_dir` 在 `initial_sync.rs:1012/:1035/:1053` 已在用，无需新增导入。
- [x] `grep -rn "任务进入" packages/ --include=*.rs --include=*.ts --include=*.tsx` 只剩无关文案（`loader-groups.js`、`AssignmentsDialog.tsx`）与构建产物，无日志解析依赖。

## E2 日志点下移（`control.rs:592-638`）
- [x] WARN 整段移到 `let Some(lease)` 之后；无租约直接 `continue`，并加注释说明。
- [x] 改为 `crate::logging::info("释放失效任务租约：{relative_dir}（{state}）")`。
- [x] 四类幂等错误分支保持静默；`:622-628` 释放失败、`:630-635` 删除失败两条 warn 原样保留。

## E3 `inactive_control_dirs` 过滤归档（`initial_sync.rs:1087-1095`）
- [x] 追加 `.filter(|control| !is_archive_task_dir(&control.relative_dir))`。
- [x] 未改 `upload.rs:66-79`（输入已在 `upload.rs:82` 过滤 archive，PRD R2 已按此修订）与 `cleanup_archived_controls`。

## E4 测试（`tests/inactive_controls.rs` + `tests/mod.rs`）
- [x] `mod inactive_controls;` 按字母序注册。
- [x] `inactive_control_dirs_skips_archive_controls`：archive/handoff/reassigned 入集合为负，archived 活跃路径与 handoff 为正。
- [x] `release_inactive_leases_ignores_controls_without_lease`：断言无 `/release` 请求、无租约。
- [x] `release_inactive_leases_releases_stored_lease_for_archived_task`：先 `claim_remote_task` 造租约，再以**真实 archive 路径**的 archived control 调用，断言 `/release` 恰 1 次且租约被移除。
- [x] `cleanup_archived_controls_removes_active_residue`：归档副本与活跃副本内容一致时活跃目录被删、归档目录保留。
- [x] 测试不依赖真实时钟；临时目录 `let _ = remove_dir_all`。

## E5 静态与行数检查
- [x] `control.rs` 675 行、`initial_sync.rs` 1101 行、`tests/inactive_controls.rs` 180 行，均 ≤1200。
- [x] 新增文件 LF（`od -c` 确认 `\n`，无 `\r`）；`git ls-files --eol | grep -c 'i/crlf'` 为 0。
- [x] `git diff --stat` 只含 `control.rs`、`initial_sync.rs`、`tests/mod.rs`，外加未跟踪的 `tests/inactive_controls.rs`。

## E6 编译与测试（全任务仅此一次）
- [ ] `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` —— **本机无 cargo/rustc，未执行**；CI（`.github/workflows/windows.yml:159-161` → `scripts/test.mjs:138-139`）会跑。
- [ ] CI `cargo fmt --check` / `cargo clippy`：仓库未配置该门禁（审查确认），不需要。
- [x] Node 侧无改动，未跑 Node 测试（无需）。

## E7 手工验收（待用户）
- [ ] 连接含 100+ 归档任务的测试空间，触发一次同步：`desktop.log` 新增行不含 `任务进入 Archived 控制状态`。
- [ ] 制造一次真实释放（认领后服务端归档/改派），确认出现一条 `释放失效任务租约：…`，且本地不再上传该目录。
- [ ] 前后日志片段贴进 `research/verification.md`。

## E8 交付（待用户确认）
- [ ] `git add` 必须包含未跟踪的 `packages/desktop/src-tauri/src/agent/task_sync/tests/inactive_controls.rs`，否则 CI 报 `file not found for module inactive_controls`。
- [ ] 汇总 `git diff` 请用户确认后提交（建议 `fix(desktop): log lease release instead of every archived control`）。
- [ ] 回滚点：E2/E3 各自独立可回退，回退后行为等于改动前。
