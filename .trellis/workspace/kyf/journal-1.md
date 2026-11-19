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
