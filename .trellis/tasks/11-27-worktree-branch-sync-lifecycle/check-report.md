---
mode: inline-self-check
agent: main-session
session: antigravity-faa86e01
commit: ""
base: 95c29a204ec2a84bf17da64be2400acab370e9c6
scope: packages/server,packages/desktop/src-tauri,packages/web
diff: sha256:ec684c4a96ebe1a89c7371906fec9c329f85d1d0a5a5bef674a2772a139266f0
---
# Check Report: Worktree 分支标识与服务端差异化归档同步

## 1. 验收标准核对（AC1–AC9）

- **AC1（新建 worktree 接入）**：PASS — `AttachOptions.is_worktree` 与 `POST /api/agent/task-spaces/attach` `isWorktree` 贯通，`sync_task_space.is_worktree = 1`，`taskSpacePublic` 返回 `isWorktree: true`。
- **AC2（普通分支不受影响）**：PASS — 普通仓库与基线分支恒为 `is_worktree = 0`，既有归档同步、控制面投影与解绑行为不变。
- **AC3（归档同步跳过 worktree）**：PASS — `activeTaskSpaces` 默认过滤 `is_worktree = 0`，全量/定时同步完全跳过；单空间 `runNow` 返回 `409 WORKTREE_ARCHIVE_SYNC_SKIPPED`；`overview()` 返回 `worktree_skipped`。
- **AC4（控制面收敛与解除“等待归档同步”）**：PASS — `reconcileProjection` 对 `isWorktree = true` 且已物化但消失的任务自动收敛 `archived = 1`、释放租约并解决冲突，`/tasks` 归空。
- **AC5（待物化任务保护）**：PASS — `materialization_state IN ('pending', 'claimed')` 不受收敛影响。
- **AC6（存量 worktree 自愈）**：PASS — `WorktreeService::reconcile_inner` 通过 `mark_binding_worktree` 幂等补标（不重置 `initial_sync_completed` 与 `tracked_task_dirs`）；服务端 `attach` 对 `last_success_at IS NULL` 的空间补标为 `1`、重置归档错误、清理退避并触发重索引。
- **AC7（管理端展示）**：PASS — `ArchiveSyncTaskSpaceRow.tsx` 对 worktree 显示中性“Worktree · 免归档同步”，隐藏“立即同步”与无效错误。
- **AC8（数据库迁移）**：PASS — Schema v18 → v19 幂等升级并自动备份，既有 `sync_task_space.is_worktree` 默认 `0`。
- **AC9（删除解绑自动弃用与重建恢复）**：PASS — 最后一个绑定 `detach` 后自动弃用（`retired_reason = 'worktree_deleted'`），同名分支重新 `attach` 自动恢复 `active`。

## 2. 验证命令与结果

| 检查项 | 命令 | 结果 |
| --- | --- | --- |
| 全量 Node 测试（含新增服务端/Web/API E2E 用例） | `npm test` | PASS（808 tests: 801 passed, 0 failed, 7 skipped） |
| Worktree 专项 & API E2E 闭环 | `node --test packages/server/test/worktree-branch-sync-lifecycle.test.js` | PASS（5/5 passed） |
| Desktop Rust 全量单测 | `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` | PASS（457 passed, 0 failed） |
| Web 类型检查与构建 | `npm --workspace @trellis-board/web run build` | PASS（`tsc -b && vite build` 成功） |
| Web Lint | `npm --workspace @trellis-board/web run lint` | PASS（0 errors，66 existing warnings） |
| 代码格式化 | `npx oxfmt <changed-files>` | PASS（已格式化） |
| LF 行尾检查 | `git ls-files --eol \| rg "i/crlf"` | PASS（无 CRLF） |

## 3. Spec 同步评估（Phase 3.3）

本次改动属于 `sync_task_space` 字段扩展及既有 worktree 生命周期收敛修复，已完整记录在任务目录的 `prd.md`、`design.md`、`implement.md`、`api-e2e-report.md` 中；现有 `.trellis/spec/` 无需额外新增或修改规范文档。