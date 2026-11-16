# 修复补 Agent 时误生成 backend spec

## Goal

已有 `.trellis/tasks` 的项目补 Agent 时，只写所选 Agent 配置，不再执行完整的
`trellis init`，避免前端仓库被误生成 `backend` spec。

## 背景与事实

- 桌面端 `initialize_project` 在 `tools_missing` 为真时仍调用完整
  `trellis init`：[onboarding.rs](/D:/wit/trellis-board/apps/desktop/src-tauri/src/agent/onboarding.rs:274)。
- 实际命令固定为 `trellis init -y --skip-existing -u <developer> <agent flags>`：
  [trellis_cli.rs](/D:/wit/trellis-board/apps/desktop/src-tauri/src/agent/trellis_cli.rs:191)。
- 当前 Trellis CLI 0.6.17 没有项目类型覆盖参数；它将 `vue` 识别为 frontend，
  又将 `devDependencies.express` 识别为 backend，最终判定为 fullstack：
  [project-detector.js](/C:/Users/yuhaojie/AppData/Roaming/npm/node_modules/@mindfoldhq/trellis/dist/utils/project-detector.js:133)。
- fullstack 会写入 frontend 和 backend spec；`--skip-existing` 只跳过已有文件，
  不阻止新增 `backend/`：[workflow.js](/C:/Users/yuhaojie/AppData/Roaming/npm/node_modules/@mindfoldhq/trellis/dist/configurators/workflow.js:165)。
- 目标 `mdp-management-web` 当前已有 `.trellis/tasks`，且 backend spec 已被清理；
  这次问题不是首次项目初始化。
- `@mindfoldhq/trellis` 包导出 `configurePlatform`，临时目录验证显示只配置
  `cursor`、`codex`、`claude-code` 时会写 Agent 文件和 `.template-hashes.json`，
  不生成 `.trellis/spec/`。
- 对照验证：完整 `trellis init --cursor --claude --codex` 与 Agent-only 配置对
  `.cursor`、`.claude`、`.codex` 及共享 `.agents` 文件逐字节一致，平台文件
  差异为 0；`.template-hashes.json` 的平台文件键均为 112 个且完全一致。
- 所有平台一次性配置时，`pi` 仍可能触发已知 EXDEV；需要保留现有 Pi 错误语义。

## Requirements

- 已有 `.trellis` 和 `.trellis/tasks` 时，新增缺失 Agent 不得创建、删除或改写
  `.trellis/spec/**`。
- 已有项目补 Agent 仍应支持当前 22 个 Agent 选择，不改变远程 Board 只提交
  `taskSpaceId`、developer ID 和 Agent ID 的边界。
- Agent-only 写入必须沿用 Trellis 模板、占位符和 `.template-hashes.json` 语义，
  不能复制或手写各平台模板。
- 只有缺少 `.trellis` 或 `.trellis/tasks` 时才允许执行完整 `trellis init`。
- 不支持 Agent-only 的 Trellis 运行时必须失败关闭并给出明确错误，不能静默退回
  会产生 spec 副作用的完整初始化。
- 不修改目标项目的 `package.json`、`express` 依赖或其他无关文件。

## Acceptance Criteria

- [ ] 模拟已有 `.trellis/tasks` 的项目选择缺失 Agent 后，目录中没有新增
  `.trellis/spec/backend/`，已有 frontend spec 字节不变。
- [ ] 选择 `cursor`、`codex` 或 `claude-code` 时，相应 Agent 文件被写入，
  `.template-hashes.json` 包含实际写入文件。
- [ ] Agent-only 与完整 `trellis init` 的所选 Agent 文件集合、文件内容和
  平台相关 manifest 键一致。
- [ ] 完整初始化路径仍可创建 `.trellis`、任务树和正确类型的 spec。
- [ ] Agent-only 配置失败时返回可诊断错误，不留下半写入的临时 helper 文件。
- [ ] 现有 Rust 单元测试、前端测试和桌面静态契约通过；最后只执行一次构建验证。

## Notes

- 已选择方案一：在 Trellis Board 客户端内增加 Agent-only 路径，保留一键补
  Agent；Trellis CLI 的公开 Agent-only 命令作为后续上游改进，不纳入本次范围。
- 不从目标前端仓库删除 `express`；它用于 Rsbuild 的 Monaco 静态资源中间件。
- 不通过“完整 init 后删除新增文件”修补；该做法会引入部分写入和误删风险。
