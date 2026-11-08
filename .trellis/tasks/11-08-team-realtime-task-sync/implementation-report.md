# 实时任务同步实施报告

## 实施结果

- `server/watcher.js` 改为 `shared/trellis-watcher.js` 的兼容包装；单机与 sidecar 共用目录过滤、
  递归监听、防抖批次和动态 rebuild。
- 数据库升级到 schema v7，新增 project live revision/file/batch、Agent live cursor 和
  `team_task_index.live_revision`。
- 服务端新增 preflight、实时上报、实时拉取、cursor 和 Board live revision API，并在 Agent SSE
  中发送 `live.changed` 与 `task.live.overridden`。
- 实时任务投影复用 `scanRepository()`、`taskIndex.buildBoard()` 和现有阶段推导；任务列表、任务详情、
  单项目 Board 均优先使用实时覆盖层。
- Git 刷新按文件摘要收敛 overlay；不一致时保留实时版本并重新投影。
- sidecar 监听 approved 非只读项目，支持真实编辑上报、断线 pending 重试、摘要自触发抑制、
  cursor 补拉、冲突备份、原子写回和 suppressed delete。
- 同一项目的 watcher 批次串行上传；服务端按 Agent、项目、文件校验 `clientSequence`，
  乱序或重复序号不会回退内容。整批过期时不增加 revision、不重投影、不广播。
- 实时索引只标记实际变化的 `task_key`；只有 workspace、`.developer` 或无法定位任务的
  项目级覆盖才标记整个项目。
- 控制窗口支持责任人取消/继续/接管、原责任人通知、冲突覆盖提示和一键复原；复原形成新的服务端 revision。
- 原责任人即使没有绑定 Agent，也会生成用户级 `task.live.overridden` 通知；Board 通过实时
  revision 轮询读取并按事件 ID 去重显示警告。
- 普通浏览器直接修改有责任人的任务时，服务端返回 `ASSIGNEE_CONFIRMATION_REQUIRED`，前端复用
  三态确认对话框。“继续”保留责任人并审计；“接管”通过实时覆盖层显式更新 `task.json.assignee`。
- `read_only` binding 可接收并落盘，不启动上传 watcher；服务端也拒绝上传。

## 主要文件

- `shared/trellis-watcher.js`
- `server/team/live-sync.js`
- `agent/live-sync.js`
- `server/database.js`
- `server/team/agent-events.js`
- `server/team/http.js`
- `server/team/board.js`
- `server/team/task-index.js`
- `desktop/sidecar/main.js`
- `desktop/src-tauri/src/main.rs`
- `desktop/src-tauri/src/sidecar.rs`
- `desktop/ui/control.*`
- `web/src/hooks/useBoard.ts`
- `web/src/api/board.ts`
- `web/src/features/board/dialogs/AssigneeWarningDialog.tsx`
- `web/src/features/board/dialogs/TaskDetailDialog.tsx`

## 验证

- 定向回归 `desktop-realtime-apply`、`team-realtime-sync`、`team-core`、`team-events`、`watcher`：
  37 项通过。
- `npx --prefix web tsc -b web/tsconfig.json`：通过。
- `npm --prefix web run lint`：通过，无 error；保留项目既有 warning。
- `node --check` 覆盖服务端实时同步、Agent 实时同步和桌面控制窗口：通过。
- `git diff --check`：通过。
- 最新全量串行测试：363 项中 357 项通过、5 项跳过、1 项失败。唯一失败为既有 workspace
  测试在 Windows 清理 `%TEMP%` 目录时出现 `EPERM`，不涉及断言；该用例隔离复跑通过。
- 新增真实 Agent E2E：两个独立 `AgentLiveSync` 通过实际 HTTP、SSE 和文件 watcher 连续同步
  20 次，来源端保存到服务端 Board 与目标端本地文件均完成更新，本机 P95=562ms、max=572ms。
- `npm run build`：通过，生成 Board、登录页和管理页生产资源。
- `desktop/sidecar/build-sidecar.ps1`：通过，已生成 Windows x64 SEA sidecar；执行 `version`
  返回 `agentVersion=0.1.0`、`protocolVersion=2`。

## 未验证

- 本机没有 Rust、MSVC Build Tools 或 Windows SDK，未执行 `cargo test`、`cargo tauri build`
  和 NSIS 安装包构建。
- Windows WebView2 真实 IPC、控制窗口、Cookie、双客户端 P95 ≤3 秒、网络断开补偿和安装包
  E2E 仍需在 Windows 真机执行。
- 开发过程中按仓库规则未运行最终构建。
