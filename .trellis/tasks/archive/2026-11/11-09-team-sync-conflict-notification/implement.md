# 实时同步冲突覆盖提示实施计划

## 1. Agent 元数据

- [x] 在 `agent/live-sync.js` 增加 UTF-8 换行差异分类辅助函数。
- [x] 扩展 `_backupConflicts` 生成的文件明细：`taskKey`、`revision`、`changeType`。
- [x] 将 `manifest.taskKeys` 改为从真实冲突文件计算。
- [x] 在 `remote_overwrite` 事件新增 `conflicts`，保留现有 `files` 和 `fileCount`。
- [x] 不修改备份顺序、原子写、cursor 推进和一键复原上传流程。

验证：

```powershell
node --test tests/desktop-realtime-apply.test.js
```

## 2. 控制窗口

- [x] 在 `desktop/ui/control.js` 格式化任务键，避免展示项目 UUID 前缀。
- [x] 显示任务数、文件数、全局同步版本、任务目录和文件明细。
- [x] 文件明细显示文件版本与变化类型；旧事件回退显示路径。
- [x] 更新一键复原文案，明确恢复全部冲突文件并广播。
- [x] 只在 `desktop/ui/control.css` 增加必要的长文本换行样式。

验证：

- 静态检查 `desktop-package.test.js` 仍能找到控制窗口命令和文件。
- 在 Windows 真实控制窗口分别验证旧事件、内容变化和仅换行差异。

## 3. 自动化测试

- [x] 混合拉取中同时包含冲突文件和非冲突文件时，只记录真实冲突任务。
- [x] `manifest.taskKeys` 与 `remote_overwrite.taskKeys` 一致。
- [x] manifest 和事件包含正确文件 revision、taskKey 和 `changeType`。
- [x] `LF` 与 `CRLF` 仅换行差异标记为 `line-endings`。
- [x] 字段、空白或字符变化标记为 `content`。
- [x] 旧事件缺少 `conflicts` 时仍可被控制窗口渲染。

验证：

```powershell
node --test tests/desktop-realtime-apply.test.js
node --test tests/desktop-package.test.js
npm run format:check
npm test
```

## 4. 风险文件

- `agent/live-sync.js`：冲突备份与恢复主链路，禁止改变写盘顺序。
- `desktop/ui/control.js`：只做展示，不新增自动恢复行为。
- `desktop/ui/control.css`：只做换行和列表可读性调整。

## 5. 回滚点

- 若测试发现冲突任务归属错误，保留旧 `files`/`taskKeys` 行为并撤回新增字段。
- 若真实窗口布局异常，保留 Agent 事件字段，回退 UI 到原有单行展示。
- 已生成备份无需迁移或删除。
