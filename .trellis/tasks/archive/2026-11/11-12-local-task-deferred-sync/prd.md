# 优化本地任务待同步状态与补同步入口

## Goal

让首次同步选择 `safe` 后产生的 deferred 本地任务不再被“同步正常”状态掩盖；用户可以直接看到待同步任务，并通过明确确认触发一次安全补传。多分支汇总继续按 taskSpace 独立展示，不把同名任务跨分支合并。

## Background

- 2026-11-12 本地 `D:\wit\trellis-board` 的 main 工作区有 6 个活动任务，其中 3 个已在 main taskSpace，另外 3 个仍在客户端 `live-cursors.json` 的 `deferred` 中。
- main binding 的 `initialSyncMode` 为 `safe`，`liveSyncStatus` 为 `ready`。当前项目栏因此显示“已关联 · 同步正常”，但实际上仍有 3 个本地任务没有进入服务端。
- `safe` 的设计要求是“只同步无冲突项，不上传本地独有内容”。deferred 目录只有在用户再次修改或服务端同路径发生变化时才重新处理，当前没有主动补同步入口。
- “全部项目”视图会聚合所有可读 taskSpace。同一仓库的 `main` 和 `codex/server-gitless-task-sync` 分别有独立任务，因此总任务数会大于单一 main 分支，这是按分支隔离的预期行为。

## Requirements

### R1：暴露 deferred 状态

- `list_local_associations` 返回的每个关联增加可选的 `deferredCount` 和 `deferredTaskDirs`。
- 状态读取来自现有 `live-cursors.json`，不新增数据库表，不修改服务端快照协议。
- 缺少游标文件、旧 sidecar 或字段缺失时按 0 个 deferred 任务兼容处理。

### R2：修正项目栏状态

- `status=approved`、`readOnly=false` 且 `deferredCount>0` 时，项目栏显示“已关联 · N 个本地任务未同步”，并使用待处理视觉状态。
- 父项目状态聚合优先级为：关联失效、同步异常、同步中、存在 deferred、等待同步、同步正常。
- deferred 数量为 0 时才显示“已关联 · 同步正常”。
- 只读关联不提供补同步动作。

### R3：提供显式补同步入口

- 可写且存在 deferred 任务的关联行提供“上传 N 个本地任务”入口。
- 执行前必须由用户确认；不得因为状态轮询、页面打开或 watcher 轮询而自动上传。
- 补传复用现有按任务目录上传、文件级 CAS、限流、客户端 sequence、冲突检测和备份能力。
- 冲突时停止后续覆盖，保持现有冲突确认窗口行为；不得静默覆盖任一方。
- 成功后刷新本地关联状态和 Board 任务；失败时保留 deferred 状态并展示脱敏错误。

### R4：明确多分支汇总语义

- “全部项目”和“具体项目”继续聚合所有可读 taskSpace，不按 task ID 跨分支去重。
- 同一 task ID 在不同分支仍使用 `taskSpaceId + taskKey` 作为独立实例。
- 当展示范围包含多个 taskSpace 时，页面必须明确提示任务按分支独立统计，避免把跨分支数量误认为重复同步。

## Acceptance Criteria

- [ ] 模拟 main 关联有 3 个 deferred 任务时，`list_local_associations` 返回 `deferredCount=3` 和对应任务目录。
- [ ] 项目栏不再显示“同步正常”，而是显示“3 个本地任务未同步”；main 分支行同样可见待处理状态。
- [ ] 点击补同步入口会先要求确认，取消后不上传、不改 cursor、不改变 deferred。
- [ ] 确认后依次上传全部 deferred 任务；成功后 `deferredCount=0`，项目和分支状态恢复“同步正常”，Board 中出现对应任务。
- [ ] 任一任务 CAS 冲突时停止覆盖，保留冲突双方内容并打开现有冲突确认窗口；其余状态不得被错误报告为全部成功。
- [ ] 同一任务存在于 main 和另一分支时，两个 taskSpace 分别计数和展示，不合并为一条任务。
- [ ] 旧 sidecar 不返回新字段时，前端仍可正常运行并按 0 个 deferred 处理。
- [ ] 完成后只执行一次规定的最终验证：相关 Node 测试、Web 构建、格式检查和必要的桌面契约测试。

## Out of Scope

- 不改变 `safe` 首次同步“不自动上传本地独有任务”的产品语义。
- 不新增服务端 API、SQLite schema 或跨分支自动合并能力。
- 不自动执行第二次补传重试；网络失败后由用户再次操作或现有同步机制恢复。
- 不删除或重建 binding，不修改 Git 分支，不自动 commit/push。
- 不在本次任务中重构项目接入向导的差异逐项选择流程。
