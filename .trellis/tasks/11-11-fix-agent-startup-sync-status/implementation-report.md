# 新增项目同步状态排查实施报告

## 根因判断

- 实际桌面运行链路是 `agent/task-snapshot-sync.js` 的 `AgentTaskSnapshotSync`。
  `start()` / `_setBindings()` 只恢复 approved binding 并触发 `pullTaskSpace`，不会统一改写
  `liveSyncStatus`。
- 新增 `mdp-report-service` 后四个项目同时显示“正在同步”，但其后 `config.json` 中既有 binding
  均为 `ready`。现象与已运行 Tauri WebView 继续使用修复前的项目栏 bundle 一致。
- 前序任务 `11-11-fix-project-rail-sync-status-leak` 已在提交 `d77dd1a` 修复前端跨项目状态读取，
  原实现的多 binding 启动恢复与状态保持逻辑本身正确。
- 新客户端点击“仅同步无冲突项”又暴露独立缺陷：Tauri 向 sidecar 传 `--task-space`，但
  `live-decide`、`live-diff`、`live-initial` 把 CLI 参数注册成 camelCase `taskSpace`，导致参数
  解析在读取配置前返回 `CONFIG_INVALID: 未知参数 --task-space`。

## 实现

- 在 `agent/test/task-snapshot-sync.test.js` 增加启动恢复回归：四个既有 `ready` binding 加一个新的
  `syncing` binding，要求状态原样保留，同时五个 binding 全部触发后台 `pullTaskSpace`。
- 将三条 live CLI 的参数键统一改为 `--task-space`，内部调用业务方法时再映射为
  `taskSpaceId`；`live-restore` 不接收任务空间参数，保持原契约。
- 在 `tests/desktop-package.test.js` 增加隔离 `TRELLIS_AGENT_ROOT` 的参数回归，分别执行
  `live-decide`、`live-diff`、`live-initial`，断言越过参数解析并到达 `CONFIG_MISSING`，不得返回
  “未知参数 --task-space”。
- 更新 PRD，明确本任务的交付边界是补 sidecar 回归并通过新桌面构建加载已修复前端。
- 更新 `desktop-sidecar-packaging.md`，记录启动状态保持、连字符 CLI 参数契约、必需测试和旧
  WebView bundle 的交付风险。

## 自动验证

- 定向回归：1/1 通过。
- `tests/desktop-package.test.js` 全文件：15/15 通过。
- `agent/test/task-snapshot-sync.test.js` 全文件：29/29 通过。
- `agent/test/*.test.js`：64/64 通过。
- 全量 `npm test`：503 通过、12 跳过、1 失败；失败是未修改的 `a2a-intake` 临时目录
  `EPERM` 清理错误，该文件单独复跑 13/13 通过。
- 本次涉及文件 `oxfmt --check`：通过。
- `git diff --check`：通过。

## 桌面验收

- GitHub Windows run `43052058709` 的 `node-tests` 和 `desktop-build` 均成功。
- 安装新的 NSIS 客户端后，以 `mdp-management-web` 的真实新 taskSpace 接入场景复核：新项目为
  `syncing` 时，其余四个既有项目持续保持 `ready`，WebView 分别显示“正在同步已有任务”和
  “同步正常”。
- 该安装包仍早于本次 `--task-space` 参数修复；实机点击“仅同步无冲突项”返回“未知参数
  --task-space”。参数回归已通过，但必须重新构建、安装并用新 sidecar 完成点击复测后，才能勾选
  PRD 最后一项验收。
