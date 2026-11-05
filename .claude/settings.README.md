# 为什么有这些 deny 规则

`.claude/settings.json` 是迁移循环的 guardrail，不是安全边界。它改编自上游 kit 的 `templates/settings.json`，按本项目的 Vue/Vite/TypeScript 流程调整。

## 与上游的差异

上游为“编译型语言移植”设计，禁止 `cargo` / `tsc` / 全量测试。本项目的 `vue-tsc` 和 `vite build` 便宜，允许在切片循环内运行；完整 Playwright E2E 仍然由人工/orchestrator 在 gate 上执行。

| 规则 | 原因 |
|---|---|
| 禁止 mutating git | 多 agent 共享 worktree；一个 `reset`/`checkout` 会毁掉其他人的在途工作。`status`/`diff`/`log` 保留给评审取证 |
| 禁止 `git worktree` | worktree 边界由人工管理，agent 不应再创建嵌套 worktree |
| 禁止 `npm install` / `pnpm add` / `yarn add` | 依赖变更需要人工批准；防止 agent 自行引入 UI 库或工具链 |
| 禁止 `npm run dev` / `npm start` / `node server/index.js` | 长驻进程会占端口；服务和 E2E 由 gate 启动 |
| 禁止全量 `npm test` | 现有测试含旧前端源码断言，迁移期间会大量误伤；按切片跑 targeted tests |
| 禁止 `test:e2e` / `npx playwright` | E2E 重、需要固定服务和 fixture；由 gate 统一跑 |
| 允许 `typecheck` / `build` / `test:unit` | 这三个是切片循环内的廉价裁判 |
| 允许 `node --test` | 纯逻辑测试可 targeted 运行；不要跑整个 `tests/*.test.js` |
| 禁止 `rm -rf` | 防止误删旧前端、fixture 或 worktree |

## 阶段调整

- **实现切片时**：保持当前规则。
- **Gate 跑 E2E 时**：由人工临时移除 `test:e2e` / `npx playwright` 的 deny，或由人工在终端执行。
- **初始化依赖时**：由人工执行 `npm install` / `npm ci`，不要让 agent 做。
- **提交时**：由人工执行 `git add` / `git commit`；agent 只写报告和代码。

## 不要绕过

如果 agent 被 deny 规则挡住，正确行为是：

1. 停止；
2. 说明需要什么命令、为什么；
3. 等人工在 gate 上调整 settings 或代为执行。

不要写 wrapper 脚本绕过 pattern matching。规则不是安全边界，但绕过它会让 gate 失去意义。
