# Journal - yhj (Part 1)

> AI development session journal
> Started: 2026-10-30

---



## Session 1: Bootstrap Guidelines 项目规范初始化
<!-- trellis-session: v=2 fp=3b6f08a516e77156 -->

**Date**: 2026-10-30
**Task**: Bootstrap Guidelines 项目规范初始化
**Branch**: `main`

### Summary

重建 backend、frontend 和 guides 三层项目规范，并按当前代码核对 Node 24、SQLite、增量扫描、任务身份和 HTTP 边界。

### Main Changes

- 发布 12 份规范文档及完整任务产物
- 补齐 PRD、research、design、implement、上下文和检查报告

### Git Commits

| Hash | Message |
|------|---------|
| `3d3f164532bb634ef5c82b34182e76abaf53bfe3` | docs(trellis): 初始化项目开发规范 |

### Testing

- [OK] npm test：55/55 通过
- [OK] server/public 全部 JavaScript 文件通过 node --check
- [OK] 规范 12 个 Markdown、90 个相对链接，无缺失或未索引文件

### Status

[OK] **Completed**

### Next Steps

- 单独处理 SQLite 持久化任务的提交和归档


## Session 2: SQLite 持久化迁移
<!-- trellis-session: v=2 fp=5c534e9f4dde0dcf -->

**Date**: 2026-10-30
**Task**: SQLite 持久化迁移
**Branch**: `main`

### Summary

将项目、人工阶段、扫描缓存和看板状态迁移到 Node 内置 SQLite，保留 Trellis 任务文件为事实来源；补充事务、迁移、并发连接与回归测试，完成真实 API、UI、监听和重启验证。

### Git Commits

| Hash | Message |
|------|---------|
| `ddc2287761372f76f5acbc712489e71d065e1609` | feat(board): 将看板持久化迁移到 SQLite |

### Status

[OK] **Completed**


## Session 3: 完成个人计划与注意力执行视图
<!-- trellis-session: v=2 fp=bf5e152395c32ac0 -->

**Date**: 2026-10-30
**Task**: 完成个人计划与注意力执行视图
**Branch**: `codex/personal-plan-attention`

### Summary

交付 SQLite v2 计划字段、标签、保存视图、稳定执行身份和可信事件基线；完成推荐任务、注意力队列、父子层级、短高度弹窗布局及真实 4317 E2E。PRD 14/14、实施清单 44/44 已核对，任务已归档。

### Git Commits

| Hash | Message |
|------|---------|
| `dd9d2cc3a33be43dd610d9dd0d4feb51b488c390` | feat(board): 增加个人计划与注意力执行视图 |
| `943a0534d9d47cf99fe63517a43ff265cb09e560` | docs(spec): 固化执行身份、事件与视图计数契约 |

### Status

[OK] **Completed**


## Session 4: 个人执行：风险与流动
<!-- trellis-session: v=2 fp=f82c5580ee0c3f5d -->

**Date**: 2026-10-31
**Task**: 个人执行：风险与流动
**Branch**: `codex/personal-risk-flow`

### Summary

交付 SQLite v3 依赖阻断、解除历史、固定阻断时长、软 WIP、DoR/DoD，并通过 95/95 测试、隔离迁移、真实 API 和浏览器 E2E。

### Git Commits

| Hash | Message |
|------|---------|
| `98c66b9d5cb75c2dd9e728dcac839187b79d39d2` | feat(board): 增加依赖阻断与执行流动风险 |
| `c1518e8d3a4c28bea48041f938ad03247ee8d6aa` | docs(spec): 固化依赖阻断与风险投影契约 |

### Status

[OK] **Completed**


## Session 5: 个人执行：追溯与复盘
<!-- trellis-session: v=2 fp=b9ea621d1c110ea6 -->

**Date**: 2026-10-31
**Task**: 个人执行：追溯与复盘
**Branch**: `codex/personal-history-insights`

### Summary

交付 append-only 事件时间线、四类操作撤销、after-state 校验、执行指标、局部故障隔离与归档稳定身份，并通过 113/113 测试和隔离真实 E2E。

### Git Commits

| Hash | Message |
|------|---------|
| `8c8ccdca5f62967846fd86eecb12c71f309b3986` | feat(board): 增加执行历史撤销与复盘指标 |
| `62c0a60c19c9d405212e9c4aa3e58b934bf4f0fe` | docs(spec): 固化撤销与执行指标重建契约 |

### Status

[OK] **Completed**


## Session 6: 个人版执行增强集成
<!-- trellis-session: v=2 fp=b2bb30d6f32b377f -->

**Date**: 2026-10-31
**Task**: 个人版执行增强集成
**Branch**: `codex/personal-execution-enhancements`

### Summary

完成三个切片的最终集成验收；修复撤销人工阶段后读取旧 boardCache 的缺陷。npm test 113/113，全量 JS 语法检查、隔离 API/重启/浏览器 E2E 通过；真实 4317 与 data/board.sqlite 未修改。

### Git Commits

| Hash | Message |
|------|---------|
| `a00f9155eeb0ddc8b41ada056fd992004322128f` | fix(board): 刷新撤销后的任务快照 |
| `292281e` | docs(board): 完成个人执行增强集成验收 |

### Status

[OK] **Completed**


## Session 7: 完成看板复制任务名入口
<!-- trellis-session: v=2 fp=02ded2cafbb423b4 -->

**Date**: 2026-10-31
**Task**: 完成看板复制任务名入口
**Branch**: `codex/personal-execution-enhancements`

### Summary

任务卡片和详情增加“复制任务名”，复制 task.dirName；补齐 Clipboard 降级、aria-live 反馈、键盘与窄屏验收。npm test 113/113 通过，真实浏览器验证卡片、详情、归档、fallback、失败提示和 800px 布局。

### Git Commits

| Hash | Message |
|------|---------|
| `2860ef2` | feat(board): 增加复制任务名入口 |
| `9d9dc95` | docs(board): 记录复制任务名验收 |

### Status

[OK] **Completed**


## Session 8: 修复项目删除参数契约并清理团队版活跃任务
<!-- trellis-session: v=2 fp=8633077fc193632d -->

**Date**: 2026-11-07
**Task**: 修复项目删除参数契约并清理团队版活跃任务
**Branch**: `codex/team-board`

### Summary

删除项目改为使用仓库 id，消除缺少项目 ID 错误；同时清理 5 个团队版活跃任务及其 Board 索引，保留归档任务。

### Main Changes

- ProjectManagerDialog、useBoard 和前端 API 的删除参数统一为 id
- 补充删除接口跨层契约规范
- 删除 11-03 团队版父任务和 4 个子任务，清理对应 SQLite 事件索引

### Git Commits

| Hash | Message |
|------|---------|
| `23c493e` | fix(web): 修复项目删除参数契约 |
| `88b068c` | chore(tasks): 删除团队版活跃任务树 |

### Testing

- [OK] npm test：324 通过、5 跳过、0 失败
- [OK] 前端 lint、TypeScript 和 Vite 构建通过
- [OK] 隔离 HTTP 删除验证通过，源目录保留

### Status

[OK] **Completed**


## Session 9: 归档检查阶段看板分栏任务
<!-- trellis-session: v=2 fp=2b1f79abce42ddc6 -->

**Date**: 2026-11-07
**Task**: 归档检查阶段看板分栏任务
**Branch**: `codex/team-board`

### Summary

确认检查阶段分栏与阶段证据门禁已实现并合并，针对性回归测试 33/33 通过，归档历史遗留任务。

### Main Changes

- 核对 derivedStage=check 进入检查/收尾泳道，implement 保持实现泳道
- 核对 in_progress 不再单独作为实施完成证据
- 归档 11-01-check-stage-kanban-lane，保留历史任务记录

### Git Commits

| Hash | Message |
|------|---------|
| `2a993b0` | feat: add team board control plane |

### Testing

- [OK] node --test tests/loader.test.js tests/execution-filter.test.js：33/33 通过

### Status

[OK] **Completed**


## Session 10: 按项目过滤任务委派人
<!-- trellis-session: v=2 fp=f6eb5bfdd0f2dc39 -->

**Date**: 2026-11-07
**Task**: 按项目过滤任务委派人
**Branch**: `codex/team-board`

### Summary

任务详情派发候选改为当前任务所属项目 workspace 成员，并补充严格成员投影、按钮校验与跨层契约。

### Main Changes

- 项目投影新增 workspaceMembers，区分 workspace 成员与历史任务参与人
- 任务详情按 projectId 使用对应项目成员候选
- 当前负责人不在候选时禁用更新派发

### Git Commits

| Hash | Message |
|------|---------|
| `ac142a4` | fix(web): 按项目过滤任务委派人 |

### Testing

- [OK] node --test tests/loader.test.js：28/28 通过
- [OK] 前端 lint、TypeScript 和 Vite 构建通过
- [OK] ego-browser 验证 mdp-report-service 仅 yhj，mdp-backend-web 为 flyfly6/kanyifei/yhj

### Status

[OK] **Completed**


## Session 11: 任务卡片显示真实目录名
<!-- trellis-session: v=2 fp=d553f93ce0ec88b2 -->

**Date**: 2026-11-08
**Task**: 任务卡片显示真实目录名
**Branch**: `codex/team-board`

### Summary

在任务卡片标题下方以淡色小字显示完整 dirName，并验证复制任务名仍复制该目录名；完成 lint、TypeScript、构建和页面验收。

### Git Commits

| Hash | Message |
|------|---------|
| `224d4bb` | fix(web): 在任务卡片显示目录名 |

### Status

[OK] **Completed**


## Session 12: 修复 Markdown 产物预览初始滚动位置
<!-- trellis-session: v=2 fp=a7fe0be310b29482 -->

**Date**: 2026-11-08
**Task**: 修复 Markdown 产物预览初始滚动位置
**Branch**: `codex/team-board`

### Summary

将产物弹层首次焦点移到顶部标题区，修复长 Markdown 打开即滚到底部；完成规范回写、真实浏览器回归、lint、构建与远端推送后归档任务。

### Git Commits

| Hash | Message |
|------|---------|
| `ad8f0c3` | fix(web): 保持 Markdown 产物预览从顶部打开 |

### Status

[OK] **Completed**
