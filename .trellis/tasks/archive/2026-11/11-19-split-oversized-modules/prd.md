# 拆分 server/web 过大代码文件

## Goal

把 `packages/server` 与 `packages/web` 中单文件行数过大的源码降到可审阅规模（单文件 ≤800 行），
拆分只移动代码、不改行为，从而降低阅读、review 和后续改动的成本。

## Background（已核实事实）

统计口径：`packages/server`、`packages/web` 下 `.js/.ts/.tsx/.css/.html`，排除 `node_modules/dist/build`，行数为物理行（含注释空行）。

- server 源码 86 文件 44,809 行；测试 74 文件 27,284 行。
- web 源码 161 文件 25,220 行；测试 15 文件 1,852 行。
- 超过 800 行的源码文件：server 19 个（26,525 行，占 server 源码 59%），web 7 个（6,602 行，占 web 源码 26%）。
- 超过 800 行的测试文件另有 8 个（最大 `packages/server/test/team-gitless-http.test.js` 1,588 行）。

### 超过 800 行的文件清单

server：

| 行数 | 文件 | 备注 |
| --- | --- | --- |
| 2,170 | `packages/server/plugins/supervisor.js` | 插件子进程宿主，单类 |
| 2,122 | `packages/server/team/http.js` | team 路由 + 运行时装配 |
| 2,057 | `packages/server/database.js` | schema SQL + 迁移 + 旧数据导入 |
| 2,004 | `packages/server/team/task-space-index.js` | 投影/索引/查询 |
| 1,775 | `packages/server/team/git-manager.js` | **无生产引用** |
| 1,662 | `packages/server/team/task-space-service.js` | 任务空间服务 |
| 1,462 | `packages/server/team/task-snapshot-service.js` | 快照/CAS |
| 1,397 | `packages/server/team/live-sync.js` | **无生产引用** |
| 1,372 | `packages/server/loader.js` | 扫描与阶段推导 |
| 1,259 | `packages/server/team/agents.js` | **无生产引用**（被 `sync-agent-service.js` 取代） |
| 1,235 | `packages/server/team/task-control-service.js` | 租约/handoff/上传 |
| 1,091 | `packages/server/team/projects.js` | **仅测试引用** |
| 1,055 | `packages/server/team/archive-git-sync.js` | 归档同步 |
| 1,025 | `packages/server/index.js` | standalone 装配 |
| 1,009 | `packages/server/team/board.js` | **无引用** |
| 993 | `packages/server/execution-store.js` | 执行面读写 |
| 983 | `packages/server/team/agent-events.js` | Agent 事件 |
| 960 | `packages/server/team/task-writes.js` | **无引用** |
| 894 | `packages/server/team/gitless-board-service.js` | 任务看板服务 |

web：

| 行数 | 文件 |
| --- | --- |
| 1,295 | `packages/web/src/components/layout/ProjectRail.tsx` |
| 1,024 | `packages/web/src/api/admin.ts` |
| 891 | `packages/web/src/features/board/dialogs/TaskDetailDialog.tsx` |
| 866 | `packages/web/src/features/board/dialogs/ProjectOnboardingDialog.tsx` |
| 861 | `packages/web/src/hooks/useBoard.ts` |
| 837 | `packages/web/src/desktop/LiveSyncControlDialog.tsx` |
| 828 | `packages/web/src/lib/team-client.js` |

### 已核实的死代码

以下 7 个文件共 8,048 行，除本组内部互相引用外没有生产引用（全仓 `rg` 确认，无动态 `import()`）：

- `packages/server/team/board.js`（1,009）— 已被 `gitless-board-service.js` 取代
- `packages/server/team/task-writes.js`（960）— 同上，依赖已退役的 Git 栈
- `packages/server/team/live-sync.js`（1,397）
- `packages/server/team/agents.js`（1,259）— 被 `sync-agent-service.js`（协议 v3）取代
- `packages/server/team/git-manager.js`（1,775）
- `packages/server/team/git-credentials.js`（557）
- `packages/server/team/projects.js`（1,091）

仅 3 个测试引用它们：`packages/server/test/team-credentials.test.js`、`team-sparse-onboarding.test.js`、`team-error-diagnostics.test.js`。
`.trellis/spec/backend/architecture-and-runtime.md` 说明 team 运行时不再装配旧 Git 栈，与上述结论一致。

## Requirements

R1. 对超过 800 行的源码文件做等价拆分：只移动代码与调整 import，不改变导出符号、HTTP 路由、SQL、schema 版本、错误码和事件协议。
R2. 拆分必须保留原模块路径的导出契约（`packages/server/test/*` 与 `packages/web/test/*` 通过原路径 import），不新增第二套入口。
R3. 分层拆分，按批交付、每批独立可验证；单批失败可只回滚该批。
R4. 死代码按用户决策处理：删除则同时清理其测试；不删除则保持原样，不进入拆分。
R5. web 拆分遵守 `.trellis/spec/frontend/` 的目录与分层约定；`packages/desktop/test/desktop-ui-build.test.js` 的文本断言允许在同一提交内改写为指向拆分后的真实文件，但每处断言必须继续验证同一个可观察行为（10s 轮询、禁止 3s/750ms 轮询、ETag 使用、`all` 空间过滤），不得删除或弱化为空断言。
R6. 不引入新依赖、不新增构建步骤、不改变 `yarn test` 的覆盖范围。
R7. 把文件行数上限固化为项目规则与自动守卫，防止后续新增功能再次产生过大文件：新增 `.trellis/spec/guides/module-size-guide.md` 并在 `.trellis/spec/guides/index.md` 建立入口，新增 `packages/server/test/module-size.test.js` 遍历 `packages/server`（排除 `test/`）与 `packages/web/src` 的源码，超限即让 `yarn test` 失败；例外只能登记在守卫的 `EXCEPTIONS` 表且只减不增。

## Acceptance Criteria

- [ ] 每个被处理文件拆分后，自身与新增模块均 ≤800 行（`http.js` 组装层 ≤600 行，web 组件 ≤700 行）。
- [ ] 每批完成后 `yarn test` 通过；涉及 `plugins/supervisor.js` 的批次额外 `yarn test:plugins` 通过；全量结束后 `yarn test:all` 通过一次。
- [ ] web 侧每批完成后 `yarn workspace @trellis-board/web build`（`tsc -b && vite build`）通过；`yarn workspace @trellis-board/web lint` 无新增告警。
- [ ] `packages/server/test/team-static.test.js` 对 `team/http.js`、`team/task-space-service.js` 的文本断言在该批同一提交内按新的真实结构更新，不通过保留字符串来"骗过"断言。
- [ ] `packages/desktop/test/desktop-ui-build.test.js` 的断言在改写的批次内继续覆盖原有可观察行为；`BoardPage.tsx` 的 4 个标记未涉及拆分，仍断言原文件。
- [ ] 拆分前后对外行为一致：`git diff` 中除 import/export 与模块边界外，无 SQL、路由字符串、协议字段、错误码改动。
- [ ] 若执行死代码删除：删除后 `yarn test` 通过，且仓库内不存在指向这些文件的 import 或注释引用。
- [ ] `packages/server/test/module-size.test.js` 存在并通过；人为把任一源文件改到超限能让它失败（实测一次后还原）。
- [ ] `.trellis/spec/guides/module-size-guide.md` 记录上限值、拆分顺序、例外规则，并被 `.trellis/spec/guides/index.md` 引用。

## Out of Scope

- 超过 800 行的测试文件（8 个，最大 1,588 行）。
- 低于阈值的文件：`packages/web/src/features/admin/ArchiveSyncTab.tsx`（790）、`pages/board/BoardPage.tsx`（590）等。
- 任何功能变更、性能优化、schema 迁移、协议升级。
- `.trellis/spec/backend` 中 "schema v16" 与代码 v17 的文案漂移（另行修正）。
- 除 R5 允许的 4 处 text 断言改写外，不修改其他测试的断言内容。
- 测试文件自身的行数上限（8 个 >800 行测试文件不在本次守卫范围内）。

## Open Questions

无。D2 已确认（允许改写 `packages/desktop/test/desktop-ui-build.test.js` 断言）；D1（删除 8,048 行死代码）与 D3（server ≤800 / `http.js` ≤600 / web ≤700）按 design.md 推荐执行，用户未提出异议。
