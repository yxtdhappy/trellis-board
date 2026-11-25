# 实施计划：项目栏上传状态与失效任务目录收敛

> 前置：本文件与 `prd.md`、`design.md` 需经用户显式确认后才可执行 `task.py start`；确认前不改代码。

## 0. 启动

```bash
python .trellis/scripts/task.py start .trellis/tasks/11-25-project-rail-upload-status
```

- 确认 `task.json.status` 从 `planning` 变为 `in_progress`。
- 确认工作区除本任务目录外无本次无关改动；不清理、不回滚他人改动。
- 本机无 Rust 工具链：Rust 仅做静态自查，编译与单测由推送后的 Windows CI `yarn test --scope=rust` 验证。

## 1. 桌面投影：区分“正在上传 / 等待重试”

文件：`packages/desktop/src-tauri/src/agent/device.rs`

1. `LocalAssociation`（:77-124）增加字段：

   ```rust
   #[serde(default)]
   pub pending_upload_retrying: bool,
   ```

2. 在 `pending_upload_task_dirs` 附近新增常量与纯函数：

   ```rust
   const PENDING_UPLOAD_RETRY_AFTER_SECS: i64 = 30;

   fn pending_upload_retrying(cursors: &Value, task_space_id: &str) -> bool
   ```

   逻辑按 `design.md` 3.1：读取 `taskSpaces.<id>.pending.createdAt`，RFC3339 解析失败或缺失返回 `false`，年龄 ≥ 30s 返回 `true`。

3. `read_local_associations`（:875-942）在 :892 附近计算布尔值，并在 :931-932 附近的 `LocalAssociation { … }` 中填充 `pending_upload_retrying`。

4. 同步更新其余构造点（新增字段必须显式赋值）：
   - `packages/desktop/src-tauri/src/agent_service.rs:997-1020` → `false`
   - `packages/desktop/src-tauri/src/agent/device/tests.rs:120-152` → 按测试意图填 `false` 或 `true`
   - `packages/desktop/src-tauri/src/main/tests.rs:4-26` → `false`

5. 测试（`packages/desktop/src-tauri/src/agent/device/tests.rs`）：
   - `created_at = now` → `false`
   - `created_at = now - 29s` → `false`
   - `created_at = now - 31s` → `true`
   - `created_at` 缺失、空串、非法字符串 → `false`
   - 无 `pending` 对象 → `false`

静态自查：字段命名走 `serde(rename_all = "camelCase")`，序列化键必须是 `pendingUploadRetrying`。

## 2. 失效目录收敛

文件：`packages/desktop/src-tauri/src/agent/task_sync/upload.rs`

1. 在 `fetch_directory` 循环（:162-191）之后、归档清理（:192-207）之前，收集候选目录：
   - `server_files.is_empty()`
   - `!self.active_task_directory_exists(binding, task_dir).await`
   - `cursor.baselines` 中存在 `task_dir` 或 `{task_dir}/…` 前缀
   - 只遍历本次 `entries` 中实际请求过的目录，禁止全局扫描

2. 与 `archived_dirs` 合并去重；归档目录仍先执行 `cleanup_archived_residue`，两类目录统一调用 `remove_task_dir_cursor_state`，随后重读 cursor。

3. 不修改 `remove_task_dir_cursor_state` 与 `CursorPatch.task_dir_removals` 的语义（只清 baselines + deferred）。

4. 建议把“候选筛选”抽成纯函数，便于单测；若新增测试文件，需在 `packages/desktop/src-tauri/src/agent/task_sync/tests/mod.rs` 注册。

5. 测试：
   - 基线存在 + 本地目录不存在 + 服务端空 → 目录被清理
   - 基线存在 + 本地目录存在（含空目录） + 服务端空 → 不清理
   - 基线存在 + 本地不存在 + 服务端有文件 → 不清理
   - 未在本次请求中的目录即使符合条件也不受影响
   - 清理后 `baselines`、`deferred` 均无该目录；重复调用不再产生写入（依赖 `apply_cursor_patch` 的 no-op 行为）

验证标准：对应 AC1、AC2。

## 3. Web 投影与文案

文件：

1. `packages/web/src/components/layout/project-rail/types.ts`
   - `LocalAssociation` 增加 `pendingUploadRetrying: boolean`。

2. `packages/web/src/components/layout/project-rail/association.ts`
   - `normalizeAssociation`（:27-136）增加 `pendingUploadRetrying: value.pendingUploadRetrying === true`。
   - `projectAssociationView`（:165-318）将 :268-276 的 pending 分支拆成：
     - `pendingUploadRetrying === true`：保留 `已关联 · N 个任务等待重试上传`、warning 样式；
     - 否则：`已关联 · 正在上传 N 个任务`、primary 样式 + 脉冲点。
   - 位置不变，仍在归属/拒绝/冲突之后、`liveSyncStatus` switch 之前。

3. `packages/web/test/project-rail-association.test.js`
   - 补充 `pendingUploadRetrying` 的归一化断言（缺省 → false，true → true）。
   - 补充两种文案与样式断言；保留 `liveSyncStatus=error` 优先的回归断言。
   - 如测试夹具使用完整对象，补齐新字段。

验证标准：对应 AC3、AC4、AC5。

## 4. 规格更新

文件：`.trellis/spec/frontend/rendering-and-state.md`（:63-65 项目行状态清单）

- 加入“正在上传 N 个任务”。
- 说明 30 秒阈值与“等待重试上传”的触发条件，以及二者在聚合优先级中仍属 pending 档。

## 5. 最终验证（全部开发完成后只执行一次）

按顺序执行，失败即修复后重跑：

```bash
yarn test --scope=web --file=project-rail-association
yarn test --scope=lint
yarn test --scope=desktop
```

- `yarn test --scope=lint` 覆盖 `oxfmt --check`、`oxlint`、`tsc -b --noEmit`。
- Rust 单测不在本机执行；提交并推送后由 `.github/workflows/windows.yml` 的 `desktop build (windows)` 作业运行 `yarn test --scope=rust`。
- 手工验证（AC6）：
  1. 启动桌面端，确认当前 cursor 中不存在失效目录基线；如存在，等待一轮 pull。
  2. `desktop.log` 中该目录最多 1 条 `上传未产生提交`，之后 10 分钟不再出现。
  3. 新建/编辑任务文件，项目栏显示“正在上传 N 个任务”，不闪“等待重试上传”。
  4. 断网触发上传失败，30 秒后应显示“等待重试上传”；恢复网络并成功后回到正常状态。

## 6. 提交范围

- 代码：device.rs、upload.rs、测试、types.ts、association.ts、web 测试。
- 规格：`.trellis/spec/frontend/rendering-and-state.md`。
- 任务目录：`.trellis/tasks/11-25-project-rail-upload-status/`（`task.json`、`prd.md`、`design.md`、`implement.md`、`implement.jsonl`、`check.jsonl`）必须与工作提交同一笔入库，保证后续 `task.py archive` 的改名提交可正常工作。
- 提交前确认不夹带无关改动；提交信息建议 `fix(desktop): 区分上传中与等待重试并收敛失效任务目录`。
- 未获用户明确提交授权时，只完成变更与验证，不执行 commit/push。

## 7. 回滚

- 整体 revert 本次提交即可。
- 清理只删除 `live-cursors.json` 中的本地基线缓存，不删除任何任务文件；回滚后失效目录可能重新出现 dirty 循环，但无数据损失。

## 8. 完成标准

- [ ] AC1–AC8 全部满足。
- [ ] 本机 web 测试与 lint 通过。
- [ ] Rust 测试在 CI 通过（或明确记录 CI 未通过项与原因）。
- [ ] 任务目录随提交入库，spec 已更新。
