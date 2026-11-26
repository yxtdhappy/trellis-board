---
mode: independent
agent: trellis-check
session: 01a2173d-c075-7b73-97b6-6ec7da1004fc
base: 3ca8c7b11e4d9e8fc8dddf62b91b1e79e925c743
scope: .trellis/spec/backend/http-and-filesystem.md,packages/server,.trellis/tasks/11-26-server-project-removal
diff: sha256:bbd9255090fa42f4f526f13afb12ccca0ef93af11a0d417e1794af7979c67160
---
# 检查报告

## 检查范围

- 对照 `prd.md`、`design.md`、`implement.md` 和 `research/current-project-removal.md` 检查项目删除路由、服务权限、确认校验、备份、事务、审计、级联清理、缓存失效和项目隔离。
- 检查本任务涉及的 8 个服务端/测试文件；未评审或修改工作区里无关的 desktop、web 和其他 Trellis 任务改动。
- IDEA MCP 对外部 hook 文件拒绝访问，并对任务报告读取超时；后续改用源码、`rg` 和本地文件读取完成核对。

## Findings (fixed)

- `packages/server/team/task-space/shared.js`
  - Issue: 删除摘要的 `taskCount` 取派生表 `sync_task_index`，索引尚未物化时会低估真实任务数。
  - Fix: 改为读取权威任务表 `sync_task`。

- `packages/server/team/task-space/lifecycle.js`
  - Issue: `project_purged` 审计没有显式记录项目名称，不满足 R4。
  - Fix: 审计详情加入事务内复核后的 `projectName`。

- `packages/server/test/team-task-spaces.test.js`
  - Issue: 项目删除测试没有覆盖权威任务、租约级联、404 和失败路径不写删除审计。
  - Fix: 增加 `sync_task`/`sync_task_lease` 级联断言、缺失项目 404 断言，以及成功前审计计数为 0 的断言。

- `packages/server/test/team-gitless-http.test.js`
  - Issue: HTTP 层只直接查审计表，没有证明管理审计 API 在项目删除后仍能读到事件。
  - Fix: 增加管理员审计 API 回读，校验 `project_purged.projectName` 和备份名。

- `packages/server/test/team-task-snapshot.test.js`
  - Issue: 原断言只检查数量，没有证明淘汰的是最早文件。
  - Fix: 精确断言最终保留第 3 至第 7 次创建的 5 份备份。

## Findings (not fixed)

- 本机真实 HTTP API E2E 尚未执行；由主会话按任务计划完成 `api-e2e-report.md`。
- 5 份上限当前作用于 `board.sqlite.snapshot.*` 任务快照备份，符合 R9。数据库升级前的 `board.sqlite.pre-v*` 属于另一套低频备份机制，未纳入本任务；如果产品要求 `backups/` 下所有备份类型共用 5 份上限，需要单独确认并扩展。
- 项目没有 lint 或类型检查脚本；本次以 `node --check`、格式化检查和测试作为静态验证。
- 本次是服务端范围，没有浏览器/UI 验证。

## Verification

- Lint: not configured
- TypeCheck: not configured
- Format: pass
  - `yarn oxfmt --check` 检查 8 个本任务改动文件通过。
- Syntax: pass
  - 8 个改动 JS 文件全部通过 `node --check`。
- Whitespace: pass
  - `git diff --check -- packages/server/team packages/server/test` 无输出。
- Targeted tests: pass
  - `team-task-snapshot.test.js`: 23/23。
  - `team-task-spaces.test.js`: 19/19。
  - `team-gitless-http.test.js`: 5/5。
- Full tests: pass
  - `yarn test`: 793 通过、2 跳过、0 失败，共 795 项。

## Conclusion

本任务服务端代码与自动化测试通过独立检查。权限、精确确认、强制备份、5 份轮转、事务审计、关键 cascade、索引版本、SSE 触发路径、脱敏响应和项目隔离均有代码或测试证据。真实 API E2E 与最终 spec 更新仍由主会话完成。