# 排查新增项目后全部项目显示同步中并重建客户端

## Goal

确认新增项目后其他项目同样显示同步中的根因，补齐 sidecar 启动状态保持回归，并通过重新构建的
桌面客户端加载已修复的 Web 前端，确保项目状态只反映自身 taskSpace。

## Requirements

- 保持现有 sidecar 启动语义：冷启动、重启或新增项目后恢复 binding 时，已完成首次同步的
  binding 各自保留 `ready`，新增 binding 保持自身 `syncing`，不得由启动过程统一改成同步中。
- `AgentTaskSnapshotSync.start()` 必须继续为所有 approved binding 启动后台拉取，但状态字段只表达
  每个 binding 自身的工作状态。
- 首次完整同步、首次接入 review/bootstrap、read-only binding 和真实错误的现有语义保持不变。
- Tauri 调用的 `live-decide`、`live-diff`、`live-initial` 必须统一接受 `--task-space` 参数；
  sidecar 不能混用 camelCase `taskSpace` 导致首次同步按钮在参数解析阶段失败。
- 前端 `ProjectRail` 已按项目自身 taskSpace 展示状态；本任务不得回退或重新引入全局
  `currentTaskSpace` 回退。
- 不迁移现有 `config.json`、cursor、binding 或服务端数据。
- 除修复 live-control CLI 参数契约外，本任务不扩大 sidecar 同步状态逻辑；交付需要同时重建
  sidecar 与桌面客户端，让 Tauri WebView 加载修复后的前后端实现。

## Acceptance Criteria

- [x] 回归测试直接覆盖四个 `ready` binding 加一个 `syncing` 新 binding 的 sidecar 启动场景。
- [x] 启动后五个 binding 的 `liveSyncStatus` 依次保持 `ready`、`ready`、`ready`、`ready`、
      `syncing`。
- [x] 五个 approved binding 仍全部触发后台 `pullTaskSpace`，不能为保持状态而跳过增量追赶。
- [x] 前端隔离修复和 sidecar 状态保持均有自动化测试，不再依赖当前选中 taskSpace。
- [x] GitHub Windows 工作流重新构建成功并生成新的客户端/NSIS 安装包。
- [x] 新客户端重新启动或重新登录后，WebView 加载修复后的前端 bundle，新增项目同步时其他项目
      不再显示为同步中。
- [x] 自动化回归覆盖 `live-decide`、`live-diff`、`live-initial` 的 `--task-space` 参数解析，
      不再返回“未知参数 --task-space”。
- [x] 新客户端点击“仅同步无冲突项”能够继续首次同步，不出现 CLI 参数错误。
      （2026-11-12 新安装客户端：`mdp-management-web` 变为 `ready` 且
      `initialSyncCompleted=true`，其他四个项目保持 `ready`）

## Notes

- 现象来源：2026-11-11 新增 `mdp-report-service` 后，截图显示四个项目同时“正在同步”；约 39 秒后
  `config.json` 中四个 binding 均已恢复 `ready`。
- 当前真实 desktop runtime 使用 `AgentTaskSnapshotSync`，不是 `AgentLiveSync`；已安装 sidecar
  可执行文件也包含 `AgentTaskSnapshotSync` 和 `task_sync_error`。
- `AgentTaskSnapshotSync.start()` 只恢复 binding 并触发拉取，不改写 `liveSyncStatus`。用四个
  `ready` 加一个 `syncing` 的临时运行验证后，结果仍为四个 `ready` 和一个 `syncing`。
- 已安装客户端进程启动于前端修复部署前，Tauri WebView 未重新加载；截图中所有项目同值更符合
  修复前 `ProjectRail` 复用当前 taskSpace 状态的旧 bundle。
- 原同步状态逻辑不再扩大修改；仅修复实机暴露的 live-control CLI 参数契约缺陷，并补启动状态保持
  与参数解析回归，重建客户端后通过新 WebView 实机复核。
- 前端隔离修复已由归档任务 `11-11-fix-project-rail-sync-status-leak` 完成并验证，本任务只处理
  live-control 参数契约、最终客户端重建与旧 WebView 缓存排除。
- 实机点击“仅同步无冲突项”发现 Tauri 已传 `--task-space`，但 sidecar 三条 live CLI 均注册成
  camelCase `taskSpace`；这是独立参数契约缺陷，已在同任务内纳入最小修复。
