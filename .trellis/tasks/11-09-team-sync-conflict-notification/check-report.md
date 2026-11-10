# 质量检查报告

## Findings (fixed)

- `tests/desktop-realtime-apply.test.js`
  - Issue: 新增用例只覆盖 1 个任务、1 个冲突文件，没有覆盖验收要求的“3 个文件、2 个任务”，也没有验证仅普通空白差异不会被误判为换行差异。
  - Fix: 扩展为 4 个拉取文件，其中 3 个真实冲突、分属 2 个任务，另 1 个任务内容一致；同时加入仅尾随空格差异的文件。
- `.trellis/spec/backend/desktop-realtime-sync.md`
  - Issue: 实时同步规范未记录新增 manifest 字段和 `remote_overwrite.conflicts` 契约。
  - Fix: 补充真实冲突文件归属、文件 revision、`changeType`、旧事件字段兼容和换行分类不改变覆盖顺序的约束。

## Findings (not fixed)

- 真实 Tauri 控制窗口壳层验收未完成。已使用 Chrome 加模拟 Tauri IPC 实际渲染新旧事件，但不能替代 Rust/WebView 壳层与真实 sidecar 命令验收。
- 全仓 `npm test` 已运行：405/415 通过、5 失败、5 跳过。失败来自独立 worktree 缺少 `highlight.js`/固定 Trellis CLI 依赖，以及 3 个 Windows 临时目录 `EPERM` 清理失败，均不在本任务改动范围；本任务相关测试完整通过。
- 全仓格式检查仍受基线已有的 `plugins/scenario-copilot/*` 文件影响；本任务全部改动文件的 oxfmt 检查通过。
- `desktop/README.md`、`docs/team-operations.md` 仍使用旧的实时刷新描述。该文档漂移不属于本任务新增契约，未顺手修改。

## Verification

- Lint: PASS（本任务 6 个改动文件通过 `oxfmt --check`）
- TypeCheck: N/A（纯 JavaScript，无 TypeScript 类型检查入口）；相关文件 `node --check` 通过
- Tests: PASS
  - `tests/desktop-realtime-apply.test.js`：17/17
  - `tests/desktop-package.test.js`：11/11
- Diff: PASS（`git diff --check`）
- UI 渲染：PASS（Chrome + 模拟 Tauri IPC）
  - 新事件显示“2 个任务、3 个文件”、任务目录、文件 r25/r38 和“仅换行差异/内容变化”。
  - 旧事件缺少 `conflicts` 时回退显示 `files` 路径。

## Residual Risk

- 换行分类只针对可严格解码的规范 UTF-8；无法可靠解码时保守标记为实质内容变化。
- 一键复原仍作用于整个备份，不提供单文件恢复或合并。
