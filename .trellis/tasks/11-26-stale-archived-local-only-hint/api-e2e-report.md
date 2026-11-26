# API E2E Report: 11-26-stale-archived-local-only-hint

- **状态**：未执行真实本机服务联调（软性流程记录）
- **说明**：本次改动未修改 HTTP 路由路径或响应结构，仅补齐服务端 `preflight`、`directorySnapshot`（`assertReadable`）与 `applyChanges`（`assertUploadAllowed`）对 `sync_archive_file` 活跃快照的归档判定。相关接口契约与数据库落库逻辑已由 `packages/server/test/team-task-spaces.test.js`、`packages/server/test/team-task-control.test.js` 及 `packages/server/test/team-gitless-http.test.js`（49 项测试）覆盖验证。如需在本机真实服务 + 桌面客户端实机复测，可按 `trellis-board-e2e` 补跑一轮。
