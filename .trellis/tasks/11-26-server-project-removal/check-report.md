---
mode: independent
agent: trellis-check
session: 01a217a6-6e3e-7051-94ae-fab16923195d
base: 5101d3a9eea7961f4806a5e334ce8cec2ad9db41
scope: packages/web/src,.trellis/spec/frontend/rendering-and-state.md
diff: sha256:06c5f46b304bef7ddac25d73b0e0b410f9f98bb90c6b567287faf2a580684fd9
---
# 检查报告

## 检查范围

- 对照 `prd.md`、`design.md`、`implement.md` 和调研记录检查最终 fullstack 范围：
  服务端删除链路和系统管理员专用 Web 管理入口。
- 服务端：权限、精确确认、强制备份、5 份轮转、事务审计、级联清理、缓存失效和项目隔离。
- Web：typed API、删除后状态清理与列表刷新、按钮权限、两阶段弹窗、错误保留、无障碍和文案。
- 未评审或修改工作区中无关的 desktop、账号选择器和其他 Trellis 任务改动。

## Findings (fixed)

- `packages/server/team/task-space/shared.js`
  - Issue: 删除摘要的 `taskCount` 取派生表 `sync_task_index`，索引尚未物化时会低估真实任务数。
  - Fix: 改为读取权威任务表 `sync_task`。
- `packages/server/team/task-space/lifecycle.js`
  - Issue: `project_purged` 审计没有显式记录项目名称，不满足 R4。
  - Fix: 审计详情加入事务内复核后的 `projectName`。
- `packages/server/test/team-task-spaces.test.js`
  - Issue: 项目删除测试没有覆盖权威任务、租约级联、404 和失败路径不写删除审计。
  - Fix: 增加 `sync_task`/`sync_task_lease` 级联断言、缺失项目 404 断言和成功前审计计数为 0 的断言。
- `packages/server/test/team-gitless-http.test.js`
  - Issue: HTTP 层没有证明管理审计 API 在项目删除后仍能读到事件。
  - Fix: 增加管理员审计 API 回读，校验 `project_purged.projectName` 和备份名。
- `packages/server/test/team-task-snapshot.test.js`
  - Issue: 原断言只检查数量，没有证明淘汰的是最早文件。
  - Fix: 精确断言最终保留第 3 至第 7 次创建的 5 份备份。

## Web 检查结果

- `ProjectsTab` 的“移除项目”入口同时要求 `systemAdmin` 和已选择项目；团队管理员不会仅凭 `isAdmin` 获得入口。
- `ProjectRemovalDialog` 是两阶段确认，项目名必须逐字匹配；忙碌时关闭入口、Esc/overlay 和提交均被阻断，错误保留输入。
- `useAdminProjects.purgeProject()` 成功后清空项目选择与详细信息、过滤 stale runtime 项目并重新拉取管理列表；失败通过既有错误通道展示并返回给弹窗。
- typed reader 同时兼容 camelCase/snake_case，并在 `admin.ts` 单一导出，没有重复导出或 `any`。
- Dialog 使用统一 `Dialog`/`DialogBody`/`DialogFooter`/`Alert`/`Field`，具备标题、描述、标签和按钮类型。
- 文案明确只删除 Team 服务端数据，不删除真实 Git 仓库或客户端本地 `.trellis/tasks`。
- 本增量未发现需要额外修复的 Web 实现问题。

## Findings (not fixed)

- 真实浏览器 UI 验收仍由主会话执行：管理员/团队管理员可见性、两阶段输入、成功刷新、深浅色和窄屏。
- 5 份上限只覆盖 `board.sqlite.snapshot.*`；低频数据库升级备份 `board.sqlite.pre-v*` 不在 R9 范围。
- Web 删除成功后只清理既有数据库备份文件和服务端快照残留；真实 Git 仓库、客户端本地任务和成员账号按设计保留。
- 实施代理某次全量测试出现过一次 `team-release.test.js` 并发隔离失败；本次独立全量运行 0 失败，未复现。

## Verification

- Lint: pass
  - `yarn workspace @trellis-board/web lint` 退出码 0；只有仓库既有 warning，无 error。
- TypeCheck: pass
  - `yarn build` 包含 `tsc -b`，构建成功。
- Build: pass
  - `yarn build` 成功生成 Web 产物；仅有既有静态脚本和 chunk size warning。
- Format: pass
  - 7 个本增量前端文件通过 `yarn oxfmt --check`。
- Targeted tests: pass
  - `packages/web/test/*.test.js`: 136/136。
  - 服务端删除相关测试：47/47。
- Full tests: pass
  - `yarn test`: 793 通过、2 跳过、0 失败，共 795 项。

## Conclusion

服务端与 Web 删除入口通过独立静态、类型、构建和自动化检查。最终真实浏览器验收与发布仍由主会话完成。