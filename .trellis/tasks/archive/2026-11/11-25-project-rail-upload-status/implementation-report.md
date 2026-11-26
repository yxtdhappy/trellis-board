# Implementation Report

## 任务

- Task: `11-25-project-rail-upload-status`
- Type: `complex` / `fullstack`
- 目标: 区分正常在途上传与超过 30 秒的等待重试，并让本地已删除、服务端已无存活文件的失效任务目录停止无效上传循环。

## 交付范围

### 1. 桌面端投影

- `packages/desktop/src-tauri/src/agent/device.rs`
  - `LocalAssociation` 新增 `pending_upload_retrying`（serde camelCase，默认 false）。
  - 新增 `pending_upload_retrying` 判断：读取 cursor 中 `pending.createdAt`，只有存在超过 30 秒才为 true；缺失或时间非法按“上传中”处理。
  - `read_local_associations` 填充该字段。

### 2. 失效任务目录收敛

- `packages/desktop/src-tauri/src/agent/task_sync/upload.rs`
  - 在 `fetch_directory` 之后收集“本次请求目录中服务端无存活文件、本地活动目录不存在、cursor 仍有基线”的目录。
  - 与原有归档目录清理结果合并、排序去重后统一调用 `remove_task_dir_cursor_state`，清理 baselines 与 deferred。
  - 新增纯函数 `prunable_task_directories` 便于回归测试。
- 新增 `packages/desktop/src-tauri/src/agent/task_sync/tests/upload_cleanup.rs`，覆盖命中、保留、目录名前缀误匹配和去重四种情况。
- `packages/desktop/src-tauri/src/agent/task_sync/tests/mod.rs` 注册测试模块。

### 3. 项目栏展示

- `packages/web/src/components/layout/project-rail/association.ts` 与 `types.ts`：归一化并透传 `pendingUploadRetrying`。
- `packages/web/src/lib/project-rail-association.js`：新增 `pendingUploadView`。未超时时显示 `已关联 · 正在上传 N 个任务`（primary + pulse）；超时后才显示 `已关联 · N 个任务等待重试上传`（warning）。
- `packages/web/test/project-rail-association.test.js` 覆盖两种分支。

### 4. 规范

- `.trellis/spec/frontend/rendering-and-state.md` 记录 30 秒阈值、“上传中不算失败”以及显示优先级。

## 关键提交

- `737f1f8 fix(desktop): 区分上传中与等待重试并收敛失效任务目录`

## 验证

- `yarn test --scope=web --file=project-rail-association`：17/17 通过。
- `yarn test --scope=desktop`：39 通过、1 跳过（POSIX 专用）。
- `tsc -b --noEmit`：通过。
- `oxlint`：无新增 error（仅既有 warning）。
- 改动文件单独 `oxfmt --check`：通过。
- `yarn test --scope=lint` 整体在仓库级 `oxfmt --check .` 失败，涉及 35 个与本次无关的文件；未做无关格式化。
- Rust 单测/编译：本机无 Rust 工具链，未本地执行；由 CI 的 `yarn test --scope=rust` 验证。

## 真实运行观察

- 2026-11-26 08:57 客户端重启（0.5.12）后，首个 pull 对 `.trellis/tasks/11-20-handoff-manual-e2e-114216` 记录一次 `上传未产生提交` 警告。
- 随后 `live-cursors.json` 中该目录的 4 个基线被清空，`pending` 为空；至 09:08 未再出现重复警告，服务端 `last_error` 为 null。

## 未覆盖/限制

- 重启后尚无新的真实上传批次，`正在上传 N 个任务` 的临时文案未在真实上传窗口中被观测。
- 2026-11-25T13:56:54Z 的一次性 `os error 2` 属独立问题，按 PRD 范围外处理。

## 结论

实现完成，Web/桌面 JS 侧验证通过；Rust 部分依赖 CI。可进入独立 check 与归档。
