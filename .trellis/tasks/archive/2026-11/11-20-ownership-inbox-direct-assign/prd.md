# 待归属任务支持从看板直接指定分支归属

## 背景

服务端「待归属任务」（`/api/ownership-inbox`，`TASK_OWNERSHIP_REQUIRED`）目前在看板里只有展示能力：

- 顶部黄色面板（`OwnershipInboxPanel`）只展示标题、任务目录、原因、来源分支与来源客户端；
- 左侧「待归属任务 N」只负责展开/收起该面板；
- 真正能写分支归属的「待处理 N」按钮只读取**客户端本地** `ownershipPendingCount` / `ownershipPausedCount`（`ProjectEntry.tsx:367-381`），并打开 `TaskOwnershipDialog`。

当本地 `ownership_pending` 已清空、服务端 inbox 仍有记录时，界面上没有任何入口可以完成归属。

### 本次复现（2026-11-20）

- 任务：`.trellis/tasks/11-20-onboarding-push-gitignore-developer`
- 现象：服务端 inbox 有 1 条，来源分支 `main`；本地客户端无「待处理」按钮。
- 直接原因：任务 `task.json` 的 `branch: null`（用 CLI `task.py create --no-start` 创建，没有经过客户端创建流程写分支）。
- 本地过滤：客户端 `retain_owned_groups()`（`ownership_filter.rs`）按 `.trellis/.developer` 的 `name` 过滤；本机为 `yuhaojie`，任务 `assignee/creator` 为 `yhj`，任务被当作「他人任务」丢弃。
- 结论：这条任务当前不属于本机负责人，本机不应该操作它的归属。正确做法是由任务负责人 `yhj` 先把任务改派给 `yuhaojie`，派发落地后由本机完成归属。

## 已确认的产品规则

- **权限**：只有任务的当前负责人（assignee）可以执行归属。
- **派发不变**：任务派给某人时，按现有机制应已落地到该负责人的本机；负责人本机应存在该任务目录。
- **身份不统一**：本机 `.trellis/.developer` 保持 `yuhaojie`，不改成 `yhj`；不自动修改任务 assignee 或项目成员映射。
- **提交策略**：归属只改工作区，不自动 Git commit。
- **跨端**：本机没有任务副本时不做跨客户端派发，只禁用操作并提示。

## 功能需求

- FR1：`OwnershipInboxPanel` 的每条待归属任务提供「归属」操作，可选择该项目下有效的任务空间分支。
- FR2：写回本地任务 `task.json` 的 `branch` 字段，并触发一次该任务目录的上传/同步。
- FR3：写回与上传成功后刷新待归属列表；该条记录在客户端下一次 ownership synchronize 后从服务端 inbox 消失。
- FR4：仅任务 assignee 可见/可用。非负责人（包括本机 developer 与任务 assignee 不一致的情况）显示禁用态或「仅任务负责人可操作」，不得写入任何文件。
- FR5：失败时给出可操作提示且不产生半写入：
  - 本机没有该任务目录；
  - 当前关联只读 / 分支不匹配 / 离线；
  - 选择的分支不属于该项目任务空间；
  - 并发提交同一任务。
- FR6：同一任务的归属请求在途时禁用重复提交。

## 非目标

- 不在本机没有任务副本时远程指挥来源客户端执行归属（跨客户端命令派发）。
- 不改变服务端 `TASK_OWNERSHIP_REQUIRED` 等错误码和现有拒绝语义。
- 不自动修改 developer id、任务 assignee 或项目成员映射。
- 不处理「改派 / 创建操作」面板里的历史失败操作（另议）。

## 验收标准

- [ ] AC1：任务负责人本机（本地 developer 与 assignee 一致）、本地 pending 为空、服务端 inbox 有记录时，可从列表选择分支并成功归属。
- [ ] AC2：归属后 `task.json.branch` 正确，客户端上传成功，服务端 inbox 对应记录消失。
- [ ] AC3：非负责人（本机 developer 与任务 assignee 不一致）时操作不可用，不写文件、不上传。
- [ ] AC4：本机无任务目录时操作被明确拒绝，不产生半同步。
- [ ] AC5：只读关联、非法分支、离线场景返回明确错误，界面可恢复操作。
- [ ] AC6：现有 `TaskOwnershipDialog` / `set_task_ownership` 行为与测试不回归。
- [ ] AC7：补充前端组件测试与 Rust 侧归属写入测试，覆盖成功与上述失败场景。

## 依赖 / 前置

- 服务端 inbox 条目需要暴露 `assigneeUserId` / `assigneeDevId`（或等价的负责人判定字段），否则前端无法区分「负责人」与「旁观者」。
- 负责人本机归属写入复用现有 `task.py set-branch` 与 `set_task_ownership` 的上传链路。

## 参考

- `.trellis/spec/backend/task-ownership-and-conflict-idempotency.md`
- `.trellis/spec/backend/desktop-realtime-sync.md`
- `.trellis/spec/desktop/tauri-commands/index.md`
- `packages/web/src/features/board/OwnershipInboxPanel.tsx`
- `packages/desktop/src-tauri/src/agent/task_sync/ownership_inbox.rs`
- `packages/desktop/src-tauri/src/agent/task_sync/sync_api.rs`
- `packages/desktop/src-tauri/src/agent/task_sync/ownership_filter.rs`
