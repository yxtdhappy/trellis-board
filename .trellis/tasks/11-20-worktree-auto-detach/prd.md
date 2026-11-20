# worktree 删除后自动解绑

## Goal

已自动接入的 Git worktree 被删除或 prune 后，客户端自动完成该分支的本地解绑：调用服务端 detach、
删除本地 binding 与同步游标、清理 worktree 注册表条目；不再在 ProjectRail 显示"worktree 已删除，
可解绑"提示。删除即解绑，无需用户确认，也不保留可点击的提示。

## Background

- `11-19-worktree-auto-attach` 的当前实现：worktree 路径消失时只把注册表条目标记为
  `status=stale`、`visibility=hidden_missing`，把 binding 从 `TaskSync` 剔除但保留，并在
  ProjectRail 提示"worktree 已删除，可解绑"（PRD R6 原文"不自动解绑"）。
- 该提示在用户点"解绑"后仍无法消失：注册表条目没有删除路径，`worktree-registry.json` 持久化后
  重启仍在；binding 已删导致提示按钮退化为无意义的"重试"。
- 本次用户确认改为：检测到 worktree 删除后自动解绑，不提示。

## Confirmed Decisions

- worktree 删除（路径不存在或 `git worktree list` 不再列出）后自动解绑，不弹确认、不显示提示。
- 解绑语义复用现有 `detach_local_association`：服务端 detach 本设备 binding + 删除本地 binding +
  删除同步游标；不删除服务端 taskSpace、任务、冲突、审计，也不影响其他设备。
- 只处理自动接入（`autoManaged=true`）的 worktree；手工接入的 binding 保持现有行为（分支守卫报错，
  用户自行解绑）。
- 解绑成功后删除注册表条目（持久化）；无 binding 的条目（含仅发现未接入、接入失败）一并清理。
- 服务端不可达/解绑失败：binding 标记 `detach_pending`，条目保留 `hidden_missing` 但**不再作为
  ProjectRail 待处理问题**，按 reconcile 周期（15s）静默重试，直到成功清理。
- 检测沿用现有 `all_success` / `path_missing` 保护：`git worktree list` 失败且路径仍存在时不做任何处理。
- 不做服务端 taskSpace 删除、归档处理、路径迁移、自动创建 worktree 或 Git hook。

## Confirmed Facts

- 现状：`packages/desktop/src-tauri/src/agent/worktree/mod.rs:379-403` 在 `lock_registry()`
  （std Mutex）保护块内把未发现的 auto-managed 条目置 `Stale`/`HiddenMissing`，清 `last_error`
  与 active 计数，触发 `bindings_dirty`；不做 detach、不删除条目。
- `packages/desktop/src-tauri/src/agent/worktree/mod.rs:168-190` `sync_active_bindings` 在
  `hidden_missing` 时把同路径 binding 从 `TaskSync` 绑定列表剔除，但不改 config。
- `packages/desktop/src-tauri/src/agent/detach.rs:183-229` `detach_local_association`：
  `mark_pending` 置 `detach_pending`（幂等，已 pending 时返回原 binding）→ `POST
  /api/agent/task-spaces/{id}/detach`（body `localRepoKey`）→ 成功或终态错误
  （404 / `BINDING_UNKNOWN` / `BINDING_ALREADY_DETACHED`）时删游标、删本地 binding；
  网络/服务端错误时保留 binding，返回 `status=pending`。
- `packages/desktop/src-tauri/src/agent/detach.rs:106-124` `remove_local_binding` 只改 config，
  不触碰 worktree 注册表；`packages/desktop/src-tauri/src/agent/worktree/` 下没有
  `entries.remove` 调用，注册表由 `worktree-registry.json` 持久化。
- 发现只从 approved binding 列举 worktree（`packages/desktop/src-tauri/src/agent/worktree/discovery.rs:33-60`），
  删除后的路径不再出现在发现结果中；`prunable` 记录直接跳过。
- reconcile 在 std Mutex 保护块内，不能 `await`；detach 是 async，必须先收集目标、释放锁后调用，
  再回来删除条目并持久化。
- 前端：`packages/web/src/components/layout/ProjectRail.tsx:358-361` 把
  `hidden_missing` 收进 `worktreeIssues`；`:448-462` 显示"worktree 已删除，可解绑"与解绑按钮。
  `packages/web/src/components/layout/project-rail/association.ts:340-345` 的
  `visibleTaskSpaces` 已过滤 `hidden_missing`，分支本身仍然隐藏。
- `ProjectRail` 的 worktree 状态经 `list_worktree_status` 命令读取
  （`packages/desktop/src-tauri/src/agent_service.rs:1055`，`main.rs:683`），来自
  `WorktreeService::list`。
- Alert 溢出已复现：`packages/web/src/components/ui/alert.tsx:5-15` 的 `alertVariants` 是
  `grid w-full`，隐式列 `auto` 的网格项默认 `min-width:auto`；ProjectRail 行内
  `span.min-w-0.truncate` 的容器（`ProjectRail.tsx:441` 的 `flex flex-col` div）作为网格项
  无法收缩。232px 宽容器下实测 Alert `clientWidth=230`、`scrollWidth=426`，文本右边缘 386
  超过 Alert 右边 242（Chrome headless 等价样式复现）；给网格项加 `min-width:0` 后
  `scrollWidth=230`，文本在按钮前正常省略。
- 其他 Alert 调用点大多是可换行的普通文本，不触发；属于共享组件缺省约束，nowrap/长不可断
  词（路径、ID）内容都会触发。

## Requirements

### R1 删除检测

- reconcile 中未在发现结果出现、且（路径不存在 或 `git worktree list` 全部成功）的条目进入删除处理。
- 只处理 `auto_managed=true` 的条目；`auto_managed=false`（手工接入或未接入）不触发自动解绑。
- `all_success=false` 且路径仍存在：保持现状，不判定删除、不解绑。

### R2 自动解绑

- 按条目路径匹配 config 中的 approved binding；存在时调用
  `detach::detach_local_association(&store, &api, &task_sync, task_space_id, false)`。
- 返回 `detached=true`（含 `already_detached`）：删除注册表条目，持久化，重载 config 后调用
  `sync_active_bindings` 刷新 `TaskSync` 绑定，重建 watcher，通知 state sink。
- 返回 `pending`：保留条目（`hidden_missing`）与 `detach_pending` binding，写下轮重试；
  不写 `last_error`/`lastVisibilityError` 作为用户提示，仅记录日志。
- 路径无对应 binding 的条目（仅发现、接入失败、已手工解绑）：直接删除条目，不产生服务端调用。
- 条目仍有 `task_space_id` 且无 binding 时同样直接删除条目（不再查询服务端）。

### R3 幂等与并发

- 同一 taskSpace 每轮 reconcile 最多一次 detach 调用；`detach_pending` 状态下重复调用由
  `mark_pending` 幂等吸收。
- 同一 worktree 的重复删除事件、启动 reconcile、15s 轮询共用 `refresh_lock`，不产生重复解绑。
- 客户端关闭期间删除的 worktree：下次启动 reconcile 补做解绑。

### R4 注册表清理与状态

- 条目删除后写回 `worktree-registry.json`；`list_worktree_status` 不再返回该条目。
- `hidden_missing` 不再写入任何用户可见错误字段；解绑失败只落日志。
- 删除条目后 `sync_active_bindings` 使用重新读取的 config，避免把已删除 binding 重新注册进
  `TaskSync`。
- `is_approved` 过滤 `detach_pending`，`detach_pending` binding 不再被发现流程使用。

### R5 ProjectRail

- `worktreeIssues` 不再包含 `visibility === 'hidden_missing'`；删除"worktree 已删除，可解绑"
  文案与对应解绑按钮分支。
- 自动接入失败、首次上传失败、可见性查询失败的提示保持不变。
- 分支隐藏规则不变：`visibleTaskSpaces` 继续过滤 `hidden_missing`；解绑 pending 期间分支不显示。

### R6 边界

- 手工接入的 worktree 删除：不自动解绑，沿用现有分支守卫错误展示。
- 不删除服务端 taskSpace/任务/冲突/审计，不影响其他设备 binding。
- 不自动创建/移动 worktree，不修改 Trellis 脚本。

### R7 Alert 溢出修复（同批处理）

- `packages/web/src/components/ui/alert.tsx` 的 `alertVariants` 基础类补 `*:min-w-0`：Alert 是
  `grid w-full`，隐式列宽 `auto` 下网格项 `min-width:auto` 会让 nowrap/truncate 子内容把整列撑出
  容器，文本越过边框。
- 只改基础类，不改任何调用点；图标列（`has-[>svg]:grid-cols-[auto_1fr]`）、`AlertTitle`、
  `AlertDescription`、`AlertAction` 布局不变。

## Acceptance Criteria

- [ ] 删除已自动接入的 worktree 后，客户端在一个 reconcile 周期（≤15s）内完成服务端 detach、
      删除本地 binding 与游标、清理注册表条目；ProjectRail 不出现任何 worktree 提示。
- [x] 解绑成功后 `list_worktree_status` 不再返回该 worktree，分支不出现在项目树/Board。
- [ ] 服务端不可达时解绑保持 `detach_pending`、分支隐藏、无提示；服务端恢复后重试成功并清理条目。
- [ ] 客户端重启后仍能对已删除 worktree 的残留 binding 补做自动解绑。
- [x] 仅发现未接入、接入失败的 worktree 删除后注册表条目被清理，且不发起服务端请求。
- [x] 手工接入的 worktree 删除不触发自动解绑，现有分支守卫错误展示不变。
- [x] 自动接入失败/上传失败提示、归档同步可见性、单 worktree 同步、命令与冲突行为无回归。
- [x] Alert 内 nowrap 行（ProjectRail worktree 行）在窄侧栏中于按钮前省略，文本不越过
      Alert 边框；其他 Alert 调用点布局不变。

## Verification（2026-11-20）

- `cargo test`（desktop）：328 passed。新增
  `worktree::tests::deleted_worktree_detaches_bound_space_including_pending` 与
  `deleted_worktree_drops_entry_without_matching_binding`，覆盖 `detach_pending` 仍继续解绑、
  手工接入不动、`git worktree list` 失败且路径仍在不动、无 binding / taskSpace 或路径不匹配时直接删条目。
- `cargo check --all-targets`：通过，只有既有 warning。
- `yarn workspace @trellis-board/web build`、`yarn lint`（oxlint）：通过；构建产物 CSS 含
  `:is(.\*\:min-w-0>*){min-width:0}`，`*:min-w-0` 正确编译为直接子项规则。
- 未在此会话执行：真机 Tauri + 服务端 + 真实 worktree 的端到端删除。人工复核步骤：接入 worktree →
  `git worktree remove` 该目录 → 15s 内确认 ProjectRail 无提示、`list_worktree_status` 不含该条目、
  服务端 binding 已撤销；断网删除后恢复网络，确认 15s 内补做解绑；重启客户端确认同样补做。

## Out of Scope

- 服务端 taskSpace、任务、冲突、审计的删除或归档处理。
- worktree 移动/`git worktree repair` 的路径迁移；`repo_path` 不自动迁移。
- 手工接入 binding 的自动解绑。
- 自动创建/删除/移动 worktree、Git hook。
- 修改 `detach` 服务端协议或新增接口。

## Risks

- 路径暂时不可用（移动硬盘拔出、目录被临时重命名）会被判定为删除并解绑；路径恢复后按新
  worktree 重新发现和接入，生成新 binding。用户已确认接受（原 PRD 的"不自动解绑"安全边界被覆盖）。
- 解绑是破坏性本地操作，但只影响本设备 binding；服务端任务数据和其它设备不受影响。
