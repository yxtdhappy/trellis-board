# Implementation Report: Worktree 分支标识与服务端差异化归档同步

## Summary

实现客户端 worktree 分支显式打标、服务端 Schema v19 持久化与差异化归档同步、worktree 控制面 `sync_task` 自动归档收敛、删除解绑自动弃用与同名重建恢复，以及管理端展示适配。

## Changed Files

- **Server DB v19**: `packages/server/database-sql/v19.js`, `packages/server/database-sql/index.js`, `packages/server/database-migrations.js`, `packages/server/database.js`
- **Server Team & Control**: `packages/server/team/task-space/{shared,attach,bindings,view}.js`, `packages/server/team/task-space-service.js`, `packages/server/team/http.js`, `packages/server/team/http/routes/agent.js`, `packages/server/team/archive-git-sync.js`, `packages/server/team/task-index/index-write.js`, `packages/server/team/task-control/projection.js`
- **Desktop Rust Agent**: `packages/desktop/src-tauri/src/agent/{store,onboarding,association}.rs`, `packages/desktop/src-tauri/src/agent/worktree/mod.rs` 及对应测试结构体
- **Web Admin UI**: `packages/web/src/api/admin/{types,readers}.ts`, `packages/web/src/features/admin/{archive-sync-format.ts,ArchiveSyncTaskSpaceRow.tsx}`
- **Tests & Reports**: `packages/server/test/worktree-branch-sync-lifecycle.test.js`, `packages/web/test/archive-sync-worktree.test.js`, DB 迁移测试断言更新, `api-e2e-report.md`, `check-report.md`, `e2e-report.md`

## Verification

- `npm test`: 808 tests (801 passed, 0 failed, 7 skipped)
- `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`: 457 passed, 0 failed
- `npm --workspace @trellis-board/web run build`: PASS (`tsc -b && vite build`)
- `npm --workspace @trellis-board/web run lint`: PASS (0 errors)
- 实机 L2+L3 E2E（真实服务端 4467 + 真实 Tauri 客户端 WebView2 CDP 9367 + 真实 Git worktree）：PASS（见 `e2e-report.md`）

## Risks

- 无未解决风险；旧客户端缺省 `isWorktree` 视为 `false`，新客户端连旧服务端通过 `#[serde(default)]` 向后兼容。
