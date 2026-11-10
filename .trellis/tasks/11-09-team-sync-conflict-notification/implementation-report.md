# 实施报告

## 变更

- `agent/live-sync.js`
  - 新增冲突变化分类：规范 UTF-8 且仅 `LF/CRLF` 不同时标记为 `line-endings`，其他情况标记为 `content`。
  - 备份 manifest 文件明细新增 `taskKey`、文件 `revision` 和 `changeType`。
  - manifest 的任务列表只从真实冲突文件计算。
  - `remote_overwrite` 事件新增 `conflicts`，保留原有 `files`、`taskKeys` 和 `fileCount`。
- `desktop/ui/control.js`
  - 展示任务数、文件数、任务目录、文件路径、文件版本和变化类型。
  - 缺少新冲突明细时回退使用旧 `files` 字符串数组。
  - 一键复原文案明确会恢复本次全部冲突文件并广播。
- `desktop/ui/control.css`
  - 保留冲突文件明细中的换行，长路径继续自动换行。
- `tests/desktop-realtime-apply.test.js`
  - 增加 3 个冲突文件/2 个任务的混合拉取、非冲突任务排除、任务去重、文件 revision、仅换行差异和普通空白差异测试。
- `tests/desktop-package.test.js`
  - 增加控制窗口任务/文件摘要、文件版本、仅换行差异和旧事件回退的静态契约断言。
- `.trellis/spec/backend/desktop-realtime-sync.md`
  - 记录冲突 manifest 和控制事件的新增字段、兼容边界及仅换行分类约束。

## 验证

- `node --test tests/desktop-realtime-apply.test.js`：17/17 通过。
- `node --test tests/desktop-package.test.js`：11/11 通过。
- `node --check`：`agent/live-sync.js`、`desktop/ui/control.js` 和两个测试文件通过。
- `git diff --check`：通过。
- 定向格式检查：本任务改动的 6 个文件全部符合 `oxfmt`。
- Chrome + 模拟 Tauri IPC：新事件和旧事件回退均实际渲染通过。

## 未完成或受限验证

- 全仓 `npm run format:check` 仍失败，失败项为基线已有的 `plugins/scenario-copilot/*` 5 个文件，与本任务无关。
- 全仓 `npm test`：405/415 通过、5 失败、5 跳过。失败来自当前 worktree 缺少 `highlight.js`/固定 Trellis CLI 依赖和 Windows 临时目录 `EPERM` 清理，均与本任务改动无关。
- 真实 Tauri 控制窗口壳层未在本轮启动；已用 Chrome + 模拟 Tauri IPC 完成控制页面视觉验证。

## 风险

- 换行分类只处理可严格解码为 UTF-8 的文本；其他文件保守标记为 `content`。
- 一键复原仍恢复整个备份，不在本次范围内增加单文件恢复。
