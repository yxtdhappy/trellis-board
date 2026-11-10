# Agent 目录识别与锁定检查报告

## Findings (fixed)

- File: `tests/trellis-agent-tools.test.js`
  - Issue: 测试标题包含“探测目录唯一”，但原断言只检查了单个 Agent 内部的路径去重，没有验证所有 Agent 的 `presencePaths` 全局唯一。
  - Fix: 增加全局 `presencePaths` 去重断言，与共享注册表设计契约一致。

- File: `.trellis/spec/backend/http-and-filesystem.md`
  - Issue: 规格仍声明远端探测只执行 `git ls-remote` 且不创建工作副本，与本次分支 tree 探测实现冲突。
  - Fix: 同步为 `git ls-remote --symref` 加临时 partial clone、受限 `ls-tree`、临时目录清理，以及增量初始化、临时检出和 Agent 并集持久化契约。

- File: `.trellis/spec/frontend/rendering-and-state.md`
  - Issue: 规格缺少按目标分支重新探测、已有 Agent 锁定和“全部团队”提示的新前端契约。
  - Fix: 补充分支切换重探测、锁定项不可取消、提交完整 Agent 并集、具体团队 active 用户加载等规则。

- File: `.trellis/spec/backend/quality-guidelines.md`
  - Issue: `git-manager.js` 的测试覆盖说明仍只描述远端探测和分支解析，没有反映分支 tree 与增量初始化职责。
  - Fix: 更新模块覆盖说明。

## Findings (not fixed)

- 无任务范围内未修复的功能或规格问题。
- `npm --prefix web run lint` 返回 0，但仓库现有 25 条 warning，主要涉及 Fast Refresh、effect 内同步 setState、渲染期 ref/Date 等既有模式。未为本次任务扩大范围修改这些无关警告。
- 实测填写负责人 developer ID 时，浏览器会报告现有 `pattern` 属性在 `v` 正则模式下包含未转义连字符；该提示不影响本次接入和工具链审批，但会出现在旧控制台记录中。该属性不是本次新增逻辑，未扩大范围修改。

## Verification

- `node --test tests/trellis-agent-tools.test.js tests/team-core.test.js tests/team-sparse-onboarding.test.js`: pass，28/28。
- `npm run format:check`: pass。
- `npm --prefix web run lint`: pass，0 error，25 existing warnings。
- `node web/node_modules/typescript/bin/tsc -b web --pretty false`: pass。
- `npm --prefix web run build`: pass；`tsc -b` TypeScript 检查通过，Vite production build 成功。
- `git diff --check`: pass；仅有 `.trellis/tasks/11-08-team-realtime-collaboration/task.json` 的既有 CRLF 转换 warning，该文件不属于本任务。

## 真实环境验收

- 仅验收 `mdp-backend-web` 的 `dev` 分支，使用 `yhj_trellis` 凭据完成页面探测、接入和工具链批准。
- 目标分支锁定了 `Codex`、`Pi`、`Oh My Pi`，下拉展开正常，没有页面重定向或 Base UI 崩溃。
- 接入后 `dev` HEAD 保持 `cdc56bab76ba672015152da1a18fe52d982ba2a7`，最近 push 为“从未”。
- 项目状态为 `current`，`agent_tools_json` 为 `["codex","pi","omp"]`。
- 工作副本只有 `.git` 和 `.trellis`，Git 状态为干净的 `dev...origin/dev`。
- 完整证据见 `e2e-report.md`。

## Review conclusion

- `presencePaths` 已与本地 `@mindfoldhq/trellis@0.6.17` 的 `AI_TOOLS` 配置对照一致。
- 分支级探测、临时 partial clone 清理、服务端重新探测、缺失 Agent 增量初始化、无缺失时跳过初始化、已有文件保护、Agent 并集持久化和审计字段均有对应实现与测试。
- `MultiSelectField` 的锁定值保持选中且禁用，`OnboardingTab` 在分支变化后重探测并重置未提交选择，具体团队用户为空时加载 active 用户；构建验证通过。
- 已执行真实 SSH 远端接入和浏览器 E2E，仅覆盖 `dev` 分支。
- 未提交、未推送、未修改无关任务文件。
