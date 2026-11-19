# Journal - kyf (Part 1)

> AI development session journal
> Started: 2026-11-04

---


## Session 1: 插件机制（子进程 JSON-RPC）
<!-- trellis-session: v=2 fp=2c23a350c0cc300c -->

**Date**: 2026-11-05
**Task**: 插件机制（子进程 JSON-RPC）
**Branch**: `codex/team-board`

### Summary

完成插件运行时、ACP/A2A 参考插件、前端插件页、测试规范与任务归档。

### Main Changes

- 新增子进程 JSON-RPC 插件运行时、SDK、权限、事件、存储与 secrets 解析
- 新增 acp-dispatch 与 a2a-intake 两个参考插件及插件测试分层
- 新增前端插件页、插件 API 与示例配置
- 补充 plugin-runtime / plugin-testing 规范并归档任务

### Git Commits

| Hash | Message |
|------|---------|
| `22b5c57` | feat(plugins): add subprocess JSON-RPC plugin runtime |
| `a5d63f7` | docs(spec): document plugin runtime and testing guidelines |
| `c6469ae` | docs(task): record plugin architecture planning and session |
| `7aeb4b1` | chore(task): archive 11-04-plugin-architecture |

### Testing

- [OK] npm test：276 tests / 275 pass / 1 skipped / 0 fail
- [OK] node --check 与 JSON 解析检查通过

### Status

[OK] **Completed**

### Next Steps

- 后续真实平台联调按需启用私有插件与真实 ACP agent 测试


## Session 2: WitOps 运行测试：大纲关联、生成与回归预检
<!-- trellis-session: v=2 fp=6ce2d36ea1c96ed1 -->

**Date**: 2026-11-19
**Task**: WitOps 运行测试：大纲关联、生成与回归预检
**Package**: server
**Branch**: `main`

### Summary

修复运行测试弹窗横向滚动；为 scenario-copilot 增加 manifest 关联、分级解析、生成大纲与回归预检；工作台接入来源提示、生成闭环和异步 job。

### Main Changes

- 弹窗宽度与表单最小宽度收敛，1006/360px 无横向滚动
- scenario-copilot 新增 outlines.manifest.json、resolve/associate/preflight，删除默认大纲静默兜底
- witops-workbench 接入 resolve、生成预览/保存 202 job、回归缺失阻止

### Git Commits

| Hash | Message |
|------|---------|
| `ea03931` | feat(scenario): 支持测试大纲关联、生成与回归预检 |
| `362b747` | docs(spec): 补充测试大纲契约与插件运行时陷阱 |

### Testing

- [OK] yarn test:plugins：108 tests，107 pass，1 skip
- [OK] Playwright 1006/360px；R35627 需求与任务解析同一大纲；R35499 回归缺失提示

### Status

[OK] **Completed**

### Next Steps

- 将 gitignored 的 plugins/witops-workbench/** 同步到目标部署位置
- 有测试账号后补真实业务运行与保存大纲 UI E2E


## Session 3: WitOps Trellis 任务测试与插件降级
<!-- trellis-session: v=2 fp=d1e7e778c4da58f0 -->

**Date**: 2026-11-19
**Task**: WitOps Trellis 任务测试与插件降级
**Package**: server
**Branch**: `main`

### Summary

完成并归档 11-19-witops-trellis-task-test：工作台 Trellis 任务视图、纯 taskKey 发起、任务级大纲生成与结果归属；补充 task-only 大纲解析测试；仅安装 witops-workbench 时通过 /features 隐藏缺失依赖入口并保留 Trellis 任务视图；全量 4403 与隔离 4405 验证通过，yarn test:plugins 114/113/1。

### Git Commits

| Hash | Message |
|------|---------|
| `d1808e06` | docs(task): record witops workbench dependency fallback |
| `2db2b09a` | test(scenario): cover task-only outline resolution |

### Status

[OK] **Completed**


## Session 4: WitOps 任务面板增强
<!-- trellis-session: v=2 fp=59ad6aef2ec4bda8 -->

**Date**: 2026-11-19
**Task**: WitOps 任务面板增强
**Package**: server
**Branch**: `main`

### Summary

witops-core 支持任务/需求/缺陷/工单四类数据源与筛选、本地分支选择、预览与二次确认、task.md 契约、需求父子任务；同步修复下游 prd.md 消费者。

### Main Changes

- witops-core 面板：四类筛选、类型徽标、分支下拉、task.md 预览、重复任务回退 prd.md、无 ready 项隐藏创建按钮
- 宿主：trellis.projects.branches、task.py --parent、loader task.md 产物、TaskDetailDialog WitOps 原文
- 下游：workbench 读 task.md、acp-dispatch prompt、DoR 占位 PRD 判定

### Git Commits

| Hash | Message |
|------|---------|
| `74df282d` | feat(witops): 增强任务面板筛选、分支选择与父子任务下发 |
| `cea1a177` | docs(task): 记录 WitOps 任务面板增强 |

### Testing

- [OK] yarn test 659/659
- [OK] yarn test:plugins 113 pass / 1 skip
- [OK] 4403 实测 /mine?categories=1 返回 200，重复任务预览返回 task.md/prd.md 内容

### Status

[OK] **Completed**
