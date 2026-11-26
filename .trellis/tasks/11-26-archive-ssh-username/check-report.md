---
mode: inline-self-check
agent: main-session
session: 01a21668-d87b-74c1-9b24-b0e8bff77ebe
commit: ""
base: 09aceaf06681d450eb1c5428c77d6ea1dc6d574e
scope: packages/server/team/archive-git-credentials.js,packages/server/test/archive-git-credentials.test.js,packages/web/src/features/admin/ArchiveSyncTab.tsx,packages/web/src/features/admin/archive-sync-format.ts,docs/team-operations.md,.trellis/spec/backend/architecture-and-runtime.md,.trellis/spec/backend/http-and-filesystem.md,.trellis/spec/frontend/rendering-and-state.md
diff: sha256:b766cb5ab223e728a48ef48a0d8d29e865a551e6f3cd7a97c582cf600e674c58
---
# Check Report: 归档 SSH 用户名持久化

## 检查范围与结论

- SSH 用户名复用现有凭据列，创建默认 `git`、自定义值（含 `+`/`@`）持久化、存量空值运行时回落 `git`。
- 临时 SSH wrapper 明确使用安全引用的 `-o User=<username>`，未改变私钥临时文件、来源隔离和归档只读边界。
- 管理页新增 SSH 用户名输入，新建默认与编辑回填均为 `git`；HTTPS 用户名行为保持兼容。
- API E2E 已验证请求、响应、审计和 SQLite 落库；浏览器已验证表单默认值、编辑回填且无 Console 错误。
- 定向测试 3/3、最终构建、git diff whitespace check 和本次改动文件的 oxfmt 检查通过。

## 失败与未验证

- 两次全量 `yarn test` 各有一个不同的 Windows 并发临时文件失败，分别是 `plugin-real-task.test.js` 的 `EPERM` 和 `team-release.test.js`；两者单独复跑均通过，归档凭据测试在两次全量中均通过。
- 仓库级 `yarn format:check` 报告 32 个不在本次改动范围内的既有格式问题；未修改这些文件。
- 生产容器重建后的真实 SSH 测试未执行，需发布后使用现有凭据验收且不得创建 `/root/.ssh/config`。

## 跨层检查

- 写入链路：管理页 -> `ArchiveCredentialInput.username` -> credential API -> SQLite `username` -> resolve -> wrapper `User`。
- 读取链路：SQLite -> credential response -> 管理页编辑回填。
- 不可解密、来源唯一冲突和私钥格式校验路径未放宽。