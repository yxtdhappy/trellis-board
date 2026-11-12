# 验证跨分支任务同步隔离 E2E

## Goal

对已归档的 `11-12-branch-aware-task-sync-isolation` 做真实闭环验收，补齐代码级检查未覆盖的
Tauri 页面、实际 Agent watcher、HTTP/SSE、临时 Git 分支切换和绑定替换证据。

## Background

- 原任务代码级门禁通过，但明确没有重启 4317、没有做真实 Tauri/WebView2 验收。
- 当前已安装桌面客户端仍在历史双绑定配置上运行，项目栏存在一个暂停分支和一个正常分支。
- 直接切换当前工作仓库风险过高，同步行为使用隔离 Team 服务、隔离 Agent 配置和临时双分支仓库验证。

## Requirements

### R1 真实桌面状态

- 重启 4317，使其运行当前 `main` 源码，记录新 PID、启动时间和健康检查结果。
- 在已安装 Tauri 客户端验证：选中整个项目时只汇总暂停分支；暂停分支单独显示红色“已暂停”；
  正常分支仍显示正常同步。
- 每次页面操作都必须有对应 Board/Agent 日志或接口证据，不能只看截图。

### R2 隔离同步闭环

- 使用独立 Team 数据库、独立 Agent 配置根目录和临时 Git 仓库，不污染现有 Agent 绑定或项目数据。
- 临时仓库同时包含 `main` 和 `feature/e2e-branch`，绑定 `main` 后启动实际 Agent 进程。
- 使用本地转发代理记录同一请求进入最新 Team 服务的路径、状态和 `x-request-id`。

### R3 正向、反向与恢复

- `main` 上的任务变更应携带 `observedBranchName=main` 上传，并推进服务端 revision。
- 切换到 `feature/e2e-branch` 后，watcher 上传和事件拉取都必须失败关闭：不上传、不写本地任务、
  不推进 cursor，并在 Agent 状态中记录 `BRANCH_MISMATCH`。
- 服务端在错分支期间新增任务，切回 `main` 后应恢复拉取；恢复前不得写入错误分支。
- 同一 `localRepoKey` 重新关联 feature 分支后，旧 main binding 应变为 revoked，本地只保留一个
  approved binding，旧 taskSpace 和任务数据保留。

### R4 服务端第二道防线

- 缺失 `observedBranchName` 返回 `BRANCH_OBSERVATION_REQUIRED`。
- 与 taskSpace 或 binding 分支不一致返回 `BRANCH_TASK_SPACE_MISMATCH`。

### R5 证据与清理

- 留存桌面截图、代理请求日志、Agent 日志、服务端日志、数据库统计和验收报告。
- 测试结束停止临时服务、代理和 Agent，删除临时数据库、仓库、配置与日志；真实 4317 保持最新代码运行。

## Acceptance Criteria

- [x] 4317 重启后 PID 和启动时间更新，`/api/health` 返回成功，当前源码已生效。
      真机：PID `33208`，启动时间 `2026-11-12T13:48:56.457Z`，健康检查返回 `status=ok`、
      `mode=team`。
- [x] 整个项目选择的汇总状态、暂停分支红色状态、正常分支状态均与真实 association 一致。
      真机：整个项目显示“`1/2` 个分支已暂停”；暂停分支显示“分支不一致，已暂停同步”及实际分支
      `main`、绑定分支 `codex/server-gitless-task-sync`；`main` 分支显示“同步正常”。
- [x] `main` 本地任务上传成功，代理记录请求，服务端 revision 与任务索引同步变化。
      隔离 E2E：代理记录 `POST .../changes -> 200`，revision 从 `0` 变为 `1`，服务端文件数为 `2`。
- [x] feature 分支本地任务不上传，服务端 revision、任务列表和 cursor 均不变化，Agent 日志包含
      `BRANCH_MISMATCH`。
      隔离 E2E：`lastErrorCode=BRANCH_MISMATCH`，revision 保持 `1`，cursor 保持
      `sequence=1/revision=1`，服务端无错分支任务文件。
- [x] feature 分支期间服务端新增任务不写入本地，切回 `main` 后恢复拉取。
      隔离 E2E：错分支期间 revision 增至 `2` 但本地文件未写入、cursor 未推进；切回 `main` 后
      server-only 任务落盘，本地与服务端 cursor 均到 `3`，绑定恢复 `ready`。
- [x] 重新关联 feature 后同仓库只有一个 approved binding，旧 binding 为 revoked，旧 main
      taskSpace 数据未删除。
      隔离 E2E：本机 binding 数为 `1`；服务端 feature 为 `approved`、main 为 `revoked`；
      main taskSpace 保持 revision `3`、文件数 `4`。
- [x] 缺失或错误 `observedBranchName` 的 HTTP 反向用例返回预期业务码，不是 500。
      隔离 E2E：缺失字段返回 `400 BRANCH_OBSERVATION_REQUIRED`；错误字段返回
      `400 BRANCH_TASK_SPACE_MISMATCH`。
- [x] 临时测试数据和进程已清理并核对，E2E 报告逐项附带操作、请求/日志和结论。
      4318/4319 均已停止，临时目录不存在，遗留测试 `git` 子进程已清理；
      详见 [e2e-report.md](./e2e-report.md)。

## Out of Scope

- 不执行真实库重复任务 `--apply`。
- 不清理现有 6 个历史绑定或删除真实项目任务。
- 不自动切换当前 `D:\wit\trellis-board` 工作仓库的分支。
