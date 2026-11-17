# 本机 taskDir 安全解析与错误展示

## Scenario: 跨端相对路径映射到本机任务根

### 1. Scope / Trigger

- Trigger：修改 `agent/protocol.rs`、`agent/task_sync.rs`、`agent/task_command.rs` 的任务目录映射，
  或修改 `task_sync_error` 控制事件和 `packages/web/src/desktop/LiveSyncControlDialog.tsx`。
- 目标：跨端只传相对任务目录，本机安全映射；不允许 Windows canonical 路径与普通绝对路径混用，
  也不允许同步确认弹窗只显示裸 UUID。

### 2. Signatures

```rust
pub fn resolve_task_dir_under(tasks_root: &Path, task_dir: &str) -> Option<PathBuf>
```

```json
{
  "type": "task_sync_error",
  "taskSpaceId": "space-id",
  "projectName": "project-name",
  "branchName": "main",
  "taskDir": ".trellis/tasks/task-a",
  "code": "INVALID_RESPONSE",
  "message": "任务目录路径校验失败"
}
```

### 3. Contracts

- `taskDir` 固定使用 `/`，以 `.trellis/tasks/` 开头；它跨客户端稳定，不包含本机绝对路径。
- `resolve_task_dir_under` 只做词法校验和同源逐段构造，不调用 `canonicalize` 比较两个来源的绝对路径。
- 合法根必须同时支持普通 `C:\repo\.trellis\tasks` 和 `\\?\C:\repo\.trellis\tasks`。
- TaskSync 写入、删除、备份必须先解析路径，再检查 `.trellis`、`tasks` 和所有已存在目标组件都不是
  符号链接；失败返回错误，不写文件、不删文件、不建备份、不推进 cursor。
- `projectName` 来自当前 binding 的 `display_name`，`branchName` 来自 `branch_name`;
  `repoPath` 不得进入事件、日志或用户错误文案。
- 旧事件缺少 `projectName/branchName/taskDir` 时，同步确认弹窗必须回退到 `taskSpaceId`。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 合法的活动或归档相对目录 | 映射到当前 binding 的 `.trellis/tasks/...` |
| 普通 Windows 根或 `\\?\` 扩展根 | 两种形式都成功，且目标保持在根内 |
| 根本身、`..`、`.`、空段、反斜杠、NUL、盘符、ADS | `INVALID_RESPONSE`，失败关闭 |
| 根、父目录或目标经过符号链接 | `INVALID_RESPONSE`，不写、不删、不建备份 |
| 合法目录但目标不存在 | 允许作为待写入目标，后续按原子目录流程创建 |
| 旧 `task_sync_error` 缺可读字段 | 同步确认弹窗显示 `taskSpaceId` |

### 5. Good / Base / Bad Cases

- Good：`C:\repo` 和 `\\?\C:\repo` 两种 binding 根都能解析 `.trellis/tasks/archive/2026-11/task-a`。
- Good：错误弹窗显示 `project-name / main`，下方仅用 UUID 和相对 taskDir 做诊断。
- Base：目标目录不存在但路径合法，允许后续从服务端完整目录原子创建。
- Bad：只规范 `tasks_root`，目标仍为普通绝对路径，导致同一目录被误判越界。
- Bad：路径无效时删除/备份静默返回成功，随后 cursor 推进，造成本地与服务端游标不一致。
- Bad：把 `repoPath` 放进控制事件或日志，泄露用户本机目录结构。

### 6. Tests Required

- `agent/protocol.rs`：活动/归档合法路径；普通与 `\\?\` 根；根、`.`、`..`、空段、反斜杠、NUL、
  盘符、ADS、尾部空格/句点拒绝。
- `agent/task_sync.rs`：临时仓库合法解析；非法删除保留哨兵目录；非法备份不创建 taskSpace 备份目录；
  错误事件包含项目/分支/taskDir 且不含 `repoPath`。
- `packages/desktop/test/desktop-ui-build.test.js`：同步确认弹窗（`LiveSyncControlDialog`）使用项目/分支并保留
  taskSpaceId 回退，源码契约不得重新引入 `"repoPath":` 或旧越界文案。

### 7. Wrong vs Correct

#### Wrong

```rust
let root = std::fs::canonicalize(tasks_root)?; // 可能得到 \\?\C:\...
let target = repo_path.join(task_dir);          // 仍是 C:\...
if !target.starts_with(root) { /* 假阳性 */ }
```

#### Correct

```rust
let target = resolve_task_dir_under(&tasks_root, task_dir)
    .ok_or_else(|| task_directory_error(task_dir, "任务目录路径校验失败"))?;
assert_no_symlink_components(&tasks_root, &target).await?;
```
