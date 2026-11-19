# 分支不一致提醒降噪与非模态提示

## Goal

本地切换到非绑定分支后，客户端只在“进入暂停状态”时提醒一次，且以非模态消息呈现；不再每 15 秒重复弹出“任务同步失败”模态框，也不抢焦点。同时用可验证的方式确认：分支不一致且没有可匹配的绑定分支时，该任务空间确实暂停同步。

## Background / Confirmed Facts

- 复现条件：项目 `trellis-board` 绑定分支 `main`，本地切到 `fix/offline-assign-materialize` 后，弹窗反复出现；关闭后约 15 秒再次出现并打断当前操作。
- 心跳间隔 15 秒：`packages/desktop/src-tauri/src/agent/runtime.rs:21`、`runtime.rs:142-146`。
- 心跳每轮执行 `update_bindings → prepare_bindings`；分支不匹配时 `branch_state_matches=false`，不会短路，继续执行 `select_bindings`：`packages/desktop/src-tauri/src/agent/task_sync/bindings.rs:269-296`。
- `select_bindings` 对分支不匹配的绑定调用 `report_binding_error`；该函数**无条件**发出 `task_sync_error` 控制事件：`bindings.rs:384-386`、`bindings.rs:406-409`、`bindings.rs:441-448`。
- `ControlHub` 按 `taskSpaceId` 去重，只对“仍在队列中”的事件去重；用户点“关闭”会 `dismiss` 掉队首，下一轮心跳重新入队并触发 `live-control-changed`，前端因此再次弹窗：`packages/desktop/src-tauri/src/agent/control.rs:79-98`、`packages/desktop/src-tauri/src/agent_service.rs:305-321`、`packages/web/src/desktop/LiveSyncControlDialog.tsx:493-546`。
- 当前 `main` 已把首次控制提醒从 `focus_main_window` 改为 `notify_control` 系统通知（`agent_service.rs:288-294`、`agent_service.rs:349-374`）；用户实际使用的旧版本仍会抢焦点。无论哪种方式，反复弹出的模态框本身仍是打断来源。
- 暂停语义已从代码路径确认：不匹配的绑定不会进入 `selected`，`prepare_bindings` 只把 `selected` 写入运行集合（`bindings.rs:296-314`）；`sync_task_spaces` 为空时直接返回（`bindings.rs:118-121`）；watcher 只为 `selected` 重建（`bindings.rs:349`、`task_sync/watch.rs:19-38`）；事件拉取遇到未运行绑定返回 `BINDING_INACTIVE` 跳过（`task_sync/pull.rs:291-300`）；本地任务目录写入只发生在 pull 路径且 pull 前有分支守卫（`task_sync/pull.rs:353`、`task_sync/local_files.rs:393`）。
- 项目栏已能显示该分支“已暂停 / 分支不一致”状态：`packages/web/src/components/layout/ProjectRail.tsx:304-305`、`packages/web/src/lib/project-rail-association.js:70-71`。

## Requirements

- R1：分支守卫类错误（`BRANCH_MISMATCH`、`BRANCH_INVALID`、`DETACHED_HEAD`、`GIT_FAILED`、`NOT_GIT_REPOSITORY`、`REPO_NOT_FOUND`、`REPO_PATH_INVALID`）不得再进入模态控制事件队列，不得弹窗、不得调用 `focus_main_window`。
- R2：进入暂停状态的**状态变化**发生时，显示一次非模态消息（客户端内消息提示，非模态、不阻塞、不抢焦点），包含项目名、绑定分支和失败原因；消息不要求用户点击确认。
- R3：暂停状态保持不变期间（心跳重复检查、事件重连、从一个非绑定分支切到另一个非绑定分支）不重复提醒；客户端启动或窗口重载时，若配置中已是暂停状态也不再提醒（项目栏持续展示红色“已暂停”）；同一本地仓库存在多个不匹配绑定时，同一轮最多提醒一次。
- R4：切回绑定分支后同步自动恢复，项目栏状态恢复；之后再次进入不匹配状态时允许重新提醒一次。
- R5：暂停期间必须保持现有失败关闭语义：不拉取、不上传、不写本地任务目录、不监听任务文件，心跳不把该任务空间上报为在线监听。
- R6：现有非分支守卫的 `task_sync_error`（如网络错误、路径错误、服务端错误）行为不变，仍走原模态控制事件。

## Acceptance Criteria

- [ ] 本地切到非绑定分支后，只出现一次非模态消息，不出现“任务同步失败”模态框；消息内容含项目名/绑定分支/原因。
- [ ] 关闭消息后等待至少 3 个心跳周期（≥45 秒），不再出现同类消息或弹窗；切换窗口焦点、最小化再恢复也不重复提醒。
- [ ] 在已暂停状态下重启客户端或重载窗口，不出现启动提醒；项目栏仍显示“已暂停”。
- [ ] 同一仓库多绑定、多任务空间同时不匹配时，一轮只出现一条消息。
- [ ] 从一个非绑定分支切到另一个非绑定分支（始终未回到绑定分支）时不新增消息。
- [ ] 切回绑定分支后项目栏恢复“同步正常”；再次切走时重新出现一次消息。
- [ ] 暂停期间不产生该任务空间的 pull/upload/本地写入；该任务空间不在心跳的在线监听列表中（单元测试覆盖）。
- [ ] 非分支守卫的 `task_sync_error` 仍按原方式弹窗，回归测试通过。
- [ ] 桌面 Rust 相关模块 `cargo test` 与根目录 `yarn test` 通过。

## Out of Scope

- 不重构 `initial_sync_review` / `task_file_conflict` / `task_ownership_review` 三类模态确认流程。
- 不改变项目栏“分支不一致，已暂停”的展示样式与文案。
- 不引入系统级（Windows 通知中心）通知；仅使用客户端内消息。
- 不处理服务端绑定分支配置错误的自动修复。
