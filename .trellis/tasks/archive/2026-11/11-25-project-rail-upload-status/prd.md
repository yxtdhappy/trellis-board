# 项目栏上传状态与失效任务目录同步收敛

## Goal

让项目栏只在“上传已停滞、需要重试”时显示“等待重试上传”；正常上传期间显示“正在上传”。
同时清理已删除任务目录残留的同步基线，停止每 5–10 秒一次的无效上传告警。

## Background

- 用户新增任务后，`trellis-board` 项目行反复出现“已关联 · 1 个任务等待重试上传”（截图见会话 `m00006`）。
- 实测 `live-cursors.json`（taskSpace `3536a478-4b1b-4b3b-a8f0-42903482d33d`）在 22:38、22:47、22:48–22:59 多次检查中均无 `pending`；服务端 14:31–14:53Z 的批次每次都只包含 1 个任务目录，全部成功。
- `desktop.log` 中同一目录 `.trellis/tasks/11-20-handoff-manual-e2e-114216` 的告警出现 270 次（2026-11-24T13:47Z 至 2026-11-25T14:50Z，每 5–10 秒一次）：`上传未产生提交，继续应用当前快照：dirtyDirs=[".trellis/tasks/11-20-handoff-manual-e2e-114216"]`。
- 该目录在本地 `.trellis/tasks`、归档目录和 git 历史中均不存在；服务端 `sync_task_space_file` 中它的 4 个文件全部 `deleted=1`（revision 164），但游标 `baselines` 仍保留这 4 个路径。
- 根因一（误显示重试）：`pending` 是上传进行中的持久化出站批次。`upload.rs:389-397` 在 POST 前写入，成功后在 `upload.rs:879-892` 清除；`projectAssociationView` 把“存在 pending”直接投影为“等待重试上传”，而 ProjectRail 每 10 秒轮询，新增任务后任务文件写入频繁，轮询必然会捕获到瞬时 pending。
- 根因二（永久 dirty）：`cursor.rs:106-111` 在“基线非空、本地为空”时每轮判 dirty；服务端目录查询过滤 `deleted = 0`（`shared.js:314-319`）返回 HTTP 200 空列表，`build_directory_files` 生成空 diff，`upload_persisted_batch` 返回 `None`，`committedRevision=0`，于是 `pull.rs:532` 每轮告警。现有代码只在服务端返回归档错误时清理目录状态，没有“本地目录不存在且服务端无存活文件”时的收敛路径。
- 影响：日志噪声；每 5–10 秒一次的无效拉取/上传流程（含约 1.8 秒的 ownership 扫描）；项目栏状态误导用户以为任务同步卡住。
- 旁证：2026-11-25T13:56:54Z 有一次 `任务文件写入失败: 系统找不到指定的文件。 (os error 2)`，全天仅 1 次，未复现，与本问题无直接关系。

## Requirements

### R1 区分“正在上传”与“等待重试”

- 关联投影新增只读字段 `pendingUploadRetrying: bool`，表示当前 pending 批次已持续超过停滞阈值。
- 前端 `projectAssociationView` 在 `pendingUploadCount > 0` 时：
  - `pendingUploadRetrying = false`：显示“已关联 · 正在上传 N 个任务”，使用与同步中一致的非警告视觉（primary + 脉冲点）；
  - `pendingUploadRetrying = true`：保持现有“已关联 · N 个任务等待重试上传”文案与 warning 视觉。
- `detail` 继续展示任务目录名（basename），便于定位。

### R2 停滞阈值

- 阈值定义为 30 秒，由桌面端用 pending 批次的 `createdAt` 与当前时间计算；不新增游标字段，不依赖前端时钟。
- `pending` 不存在、`createdAt` 缺失或无法解析时，`pendingUploadRetrying = false`（按上传中处理）。

### R3 失效任务目录收敛

- 当同时满足以下条件时，清除该目录的 `baselines` 与 `deferred`（与归档清理同一路径；不清理 `readonlyTaskDirs`）：
  1. 游标中存在该目录的同步基线；
  2. 本地已不存在该活跃任务目录（目录不存在；空目录也视为存在，保持保守）；
  3. 服务端目录查询返回无存活文件（HTTP 200 空列表或 404）。
- 复用现有 `remove_task_dir_cursor_state`（`cursor.rs:446-462`），与归档清理走同一条状态清理路径。
- 判定必须使用 `fetch_directory` 的服务端结果，禁止仅凭“本地目录不存在”清理，避免把服务端仍有文件、但本地暂时缺失的场景误判。
- 本地仍有任务文件的目录一律不清理，保持 `upload.rs:195-199` 的既有保护。

### R4 日志收敛

- 收敛完成后，同一失效目录不得再产生“上传未产生提交”告警；允许在触发收敛的那一轮保留至多 1 条。
- 不新增每轮同步重复打印的状态日志，符合 desktop 日志规范（`.trellis/spec/desktop/tauri-commands/index.md:462`）。

### R5 保持既有语义

- 不改变正常上传、冲突、归属、只读、归档、分支不一致的判定优先级与文案。
- 不改变上传批次格式、目录 API、服务端 `deleted=0` 语义与 `sync_task` 状态。

### R6 规格同步

- 更新 `.trellis/spec/frontend/rendering-and-state.md` 的项目行状态清单，加入“正在上传 N 个任务”，并说明“等待重试上传”只在停滞/失败时出现。

## Acceptance Criteria

- [ ] AC1 游标中存在失效目录基线、本地无目录、服务端返回空目录时，执行一次上传流程后该目录从 `baselines`/`deferred` 中移除；下一次 pull 不再把它判为 dirty。
- [ ] AC2 本地仍有任务文件、服务端返回空目录时，不清理基线，仍按原逻辑上传本地文件。
- [ ] AC3 pending 的 `createdAt` 在 30 秒内时，关联投影 `pendingUploadRetrying=false`；超过 30 秒时为 `true`；`createdAt` 缺失时为 `false`。
- [ ] AC4 前端在 `pendingUploadCount=1` 且 `pendingUploadRetrying=false` 时显示“已关联 · 正在上传 1 个任务”，不使用 warning 样式；为 `true` 时显示“已关联 · 1 个任务等待重试上传”。
- [ ] AC5 状态优先级不回归：`liveSyncStatus=error`、冲突、服务端拒绝、归属待处理、初始确认仍优先于上传状态。
- [ ] AC6 手工检查修复后的 `desktop.log`：连续 10 分钟内不再出现失效目录的 `上传未产生提交` 告警；同一目录只在收敛前出现至多 1 条。
- [ ] AC7 质量门禁通过：`yarn test --scope=web --file=project-rail-association`、`yarn test --scope=lint`、`yarn test --scope=desktop`；Rust 测试由 Windows CI 的 `cargo test` 验证（本机无 Rust 工具链）。
- [ ] AC8 `.trellis/spec/frontend/rendering-and-state.md` 已更新，且任务目录随工作提交一并入库。

## Out of Scope

- 修复 2026-11-25T13:56:54Z 的一次性 `os error 2` 文件写入失败（未复现，另案处理）。
- 清理服务端 `sync_task` 中 `archived=0`、`materialization_state='claimed'` 的失效任务记录。
- 修改服务端目录 API 的 tombstone 语义，或新增服务端接口。
- 重构 ProjectRail 的 10 秒轮询机制（不改为 SSE/WebSocket）。
- 处理“跳过上传后 pending 长期残留”的所有分支（本次只在 UI 侧按停滞阈值暴露，不改跳过分支持久化语义）。

## Technical Notes

- 关键文件：
  - `packages/web/src/components/layout/project-rail/association.ts:165-318`（状态优先级与文案）
  - `packages/web/src/components/layout/project-rail/types.ts`（`LocalAssociation`、`ProjectAssociationView`）
  - `packages/web/src/lib/project-rail-association.js`（计数与聚合）
  - `packages/desktop/src-tauri/src/agent/device.rs:77-124`、`:875-942`、`:1038-1054`（关联投影）
  - `packages/desktop/src-tauri/src/agent/task_sync/cursor.rs:63-114`、`:446-462`、`:571-580`
  - `packages/desktop/src-tauri/src/agent/task_sync/upload.rs:4-368`、`:371-402`、`:645-895`
  - `packages/desktop/src-tauri/src/agent/task_sync/pull.rs:499-546`
  - `packages/desktop/src-tauri/src/agent/task_sync/snapshot.rs:601-641`
- 测试入口：`packages/web/test/project-rail-association.test.js`、`packages/desktop/src-tauri/src/agent/task_sync/tests/`、`packages/desktop/test/desktop-ui-build.test.js`。
- 设计取舍与数据流见 `design.md`，执行步骤见 `implement.md`。

## Open Questions

- 30 秒阈值是否需要按上传体积调整？当前上传均为秒级完成，30 秒已足够宽松；先按固定常量实现，后续有误报再调。
- 是否需要在 UI 上禁用“重试上传”入口以外的操作？本次不改交互，只改状态呈现。
