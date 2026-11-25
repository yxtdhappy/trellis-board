---
mode: inline-self-check
agent: main-session
session: claude_5978a49f-f6ea-4a3b-8404-1c2973f46b7d
base: 2fd7b57666d3e45acb0199ecf8cffd14d7021998
scope: packages/desktop/src-tauri/src/agent/git.rs,packages/desktop/src-tauri/src/agent/git/args.rs,packages/desktop/src-tauri/src/agent/git/query.rs,packages/desktop/src-tauri/src/agent/git/diagnose.rs,packages/desktop/src-tauri/src/agent/git/tests.rs,packages/desktop/src-tauri/src/agent/branch_inspect.rs,packages/desktop/test/desktop-ui-build.test.js,packages/web/src/lib/branch-rebind.js,packages/web/src/lib/branch-rebind.d.ts,packages/web/test/branch-rebind.test.js,packages/web/src/features/board/dialogs/BranchRebindDialog.tsx,packages/web/src/components/layout/project-rail/ProjectEntryBranchActions.tsx
diff: sha256:33a3ac3239a7e8f573024949dc210d8a6394ff6fd68227db435c5eea6e78d469
---
# Check 报告：项目栏已关联分支图标支持重新绑定分支

- commit: 未提交（等待用户确认）

## 已执行并通过的检查

- `node --test packages/web/test/branch-rebind.test.js` → 4 pass / 0 fail
- `node scripts/test.mjs --scope=web` → 135 pass / 0 fail
- `node scripts/test.mjs --scope=desktop` → 39 pass / 0 fail / 1 skipped（既有 POSIX 用例）
- `../../node_modules/.bin/tsc -b --noEmit`（`packages/web`）→ 本任务改动后首次运行通过；并发任务随后新增 `CompanySpecDialog.tsx` 并出现 2 个与本次改动无关的类型错误，最后一次运行仅报该文件，未报本任务文件。
- `node scripts/build.mjs --target=desktop-ui` → 构建成功
- `oxfmt --check`（本次改动的 7 个 Web 文件）→ 通过
- `oxlint`（本次改动的 Web 文件）→ 0 error，仅既有风格警告
- `rg -n '^mod tests \{' packages/desktop/src-tauri/src/agent/git*` → 仅既有其他模块命中，`git.rs` 无内联测试模块

## 未执行 / 待验证

- `cargo test` / `cargo check`：本机 `cargo`、`rustc` 均不在 PATH，未执行；Rust 编译与单测待 CI `windows` 工作流验证。独立静态审查发现并已修复 2 个编译阻断项：`query.rs` 缺少 `parse_status`/`classify_fetch_failure`/`classify_merge_failure` 导入（审查快照后已补）、`git/tests.rs` 缺少 `PathBuf` 导入（已补）。
- 桌面端手工 E2E：未执行（无可运行 Tauri 构建）。
- `node scripts/test.mjs --scope=lint` 全仓检查：失败于 38 个既有文件（含 `trellis-kit`、`company-spec` 等与本任务无关的改动），本次改动文件单独检查通过。该失败不归因于本任务。

## 检查覆盖范围

- 可机器绑定指纹的本任务独占文件：`packages/desktop/src-tauri/src/agent/git.rs`、`agent/git/args.rs`、`agent/git/query.rs`、`agent/git/diagnose.rs`、`agent/git/tests.rs`、`agent/branch_inspect.rs`、`packages/desktop/test/desktop-ui-build.test.js`、`packages/web/src/lib/branch-rebind.js`、`branch-rebind.d.ts`、`packages/web/test/branch-rebind.test.js`、`packages/web/src/features/board/dialogs/BranchRebindDialog.tsx`、`packages/web/src/components/layout/project-rail/ProjectEntryBranchActions.tsx`。任务目录不参与指纹（stamp 自身会改写报告与事件日志）。
- 共享文件（`main.rs`、`agent_service.rs`、`agent/mod.rs`、权限/capability、`ProjectEntry.tsx`、`ProjectRail.tsx`）仍含其他任务未提交改动，无法生成稳定的检查指纹；上述人工检查覆盖了这些文件的本次 hunk，但机器绑定仅覆盖独占文件。

## 风险

- Git 层拆分未本地编译，仅做了行多重集与函数名等价性自查；如 CI 报错，按 `implement.md` 的回滚策略只修 import/可见性，不回退拆分。
- 工作区同时存在其他任务（`11-25-company-spec-bootstrap`）的未提交改动，`agent_service.rs`、`main.rs`、`ProjectEntry.tsx`、`ProjectRail.tsx`、`capabilities/board-local-association.json`、`permissions/desktop.toml` 等文件被并发修改；本任务只改可见性/新增条目，未增加 `agent_service.rs` 净行数。提交时必须按 hunk 选取，不能整文件暂存。`ProjectRail.tsx` 当前 712 行超出 700 守门，其中本任务新增 7 行，其余来自并发任务。
- 工作区存在并发写入，行数统计以本任务实际改动为准；`main.rs` 当前已被其他任务增至 1200 行以上，非本任务造成。