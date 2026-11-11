# 新增项目同步状态排查实施报告

## 根因判断

- 实际桌面运行链路是 `agent/task-snapshot-sync.js` 的 `AgentTaskSnapshotSync`。
  `start()` / `_setBindings()` 只恢复 approved binding 并触发 `pullTaskSpace`，不会统一改写
  `liveSyncStatus`。
- 新增 `mdp-report-service` 后四个项目同时显示“正在同步”，但其后 `config.json` 中既有 binding
  均为 `ready`。现象与已运行 Tauri WebView 继续使用修复前的项目栏 bundle 一致。
- 前序任务 `11-11-fix-project-rail-sync-status-leak` 已在提交 `d77dd1a` 修复前端跨项目状态读取，
  本次不重复修改正确的 sidecar 生产逻辑。

## 实现

- 在 `agent/test/task-snapshot-sync.test.js` 增加启动恢复回归：四个既有 `ready` binding 加一个新的
  `syncing` binding，要求状态原样保留，同时五个 binding 全部触发后台 `pullTaskSpace`。
- 更新 PRD，明确本任务的交付边界是补 sidecar 回归并通过新桌面构建加载已修复前端。
- 更新 `desktop-sidecar-packaging.md`，记录启动状态保持契约、必需测试和旧 WebView bundle 的交付风险。

## 自动验证

- 定向回归：1/1 通过。
- `agent/test/task-snapshot-sync.test.js` 全文件：29/29 通过。
- `agent/test/*.test.js`：64/64 通过。
- `plugins/acp-dispatch/test/index.test.js` 单独复跑：22/22 通过。
- 全量 `npm test`：488 通过、12 跳过、4 失败；失败全部位于未修改的 ACP 并发用例，单文件复跑通过。
- 本次涉及文件 `oxfmt --check`：通过。
- `git diff --check`：通过。

## 待完成

- 通过 GitHub Windows 工作流重新构建客户端/NSIS 安装包。
- 使用新客户端重启或重新登录后复核新增项目同步时其他项目状态不被污染。
