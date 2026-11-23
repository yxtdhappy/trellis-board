# 设计：修复任务归属确认被非 UTF-8 文件整体阻断

## 现状与调用链

1. `OwnershipInboxPanel.tsx:114` 调用 Tauri 命令 `set_task_ownership`。
2. `main.rs:805` → `agent_service.rs:727` → `task_sync/sync_api.rs:117`。
3. `sync_api.rs:131` 先执行 `self.local_groups(&binding, None)`；`None` 表示扫描整个 `.trellis/tasks`。
4. `ownership_inbox.rs:45` → `local_files.rs:549 read_local_task_snapshot_files`：
   - 递归遍历活动任务目录（跳过 `.trellis/tasks/archive/**`）；
   - 只处理 `.json/.jsonl/.md/.txt/.yaml/.yml`；
   - 对每个文件 `String::from_utf8`，失败即 `INVALID_RESPONSE`（`local_files.rs:621-624`），整次扫描返回。
5. ownership 索引增量扫描 `ownership.rs:426-429` 有同样的严格解码与整体失败。
6. `task_command.rs:827/842` 读取 `task.json` 时也有同样的错误文案。
7. `agent_service.rs:145-151` 只把 `error.message` 透传给前端；`safe_error_message` 会把 Windows 绝对路径脱敏为 `[本地路径]`。

因此：

- 任意一个任务目录里的坏文件会阻断整个 taskSpace 的归属预检；
- 错误消息没有文件名，无法定位；
- 不能把绝对路径写进错误文案（spec 禁止 `repoPath` 进入用户错误/log）。

## 设计决策

### D1 错误消息带仓库相对路径

在会向上返回的错误点，把已计算出的仓库相对路径拼入消息：

- `local_files.rs` 任务快照扫描：`relative` 已经是相对仓库根（如 `.trellis/tasks/11-23-x/prd.md`），直接使用。
- `ownership.rs` 索引扫描：`relative` 同样是相对仓库根，直接使用。
- `task_command.rs` 读取任务文件：调用方知道任务相对目录，给 `read_task_json_opt` / `read_utf8` 增加显式 `label` 参数，传 `.trellis/tasks/<dir>/task.json`。

消息格式：`任务文件不是有效的 UTF-8 文本：<relative_path>`。

不选方案：在错误里放 `path.display()`。Windows 绝对路径会被 `safe_error_message` 脱敏，用户仍看不到；且违反 `desktop-task-path-resolution.md` 的 `repoPath` 禁令。

`task_directory_digest`（`local_files.rs:386`）的解码错误只用于归档副本一致性判断，调用方按 `Err` 视为“不一致”，不会进入用户错误或同步失败日志；本次不改，避免为了不可见文本引入额外参数。

### D2 归属确认只扫描 decisions 涉及的任务目录

把 `set_task_ownership` 的两阶段处理拆开：

1. 先只做格式校验并归一化 decisions（任务目录格式、重复、action、branchName），收集 `selected: HashSet<String>`。
2. 调用 `self.local_groups(&binding, Some(&selected))`；该路径已被 `read_local_task_snapshot_files` 支持，并且现有测试 `targeted_local_read_does_not_decode_sibling_task_bodies` 已证明不会解码兄弟目录。
3. 再校验每个 decision 的 `task_dir` 是否出现在 `groups_by_dir`，缺失时仍返回 `INVALID_RESPONSE`“任务归属决定包含无效的任务目录”。

保持不变的语义：

- 目标任务目录自身含坏文件时，定向扫描仍解码该目录全部快照文件并失败；
- 目录不存在、格式非法、归档目录、他人任务目录（`retain_owned_groups` 过滤）仍失败；
- 重复 decision、非法 action、缺失/非法 branchName 的校验顺序不变；
- `sync_ownership_inbox` 收到的 groups 变为本次 decisions 的子集。该函数对 cursor 中 `ownershipPending` 的其他目录会做 `local_groups(binding, Some(&missing))` 定向补扫，删除差集只针对本次决议涉及的目录；其他目录的状态由后续常规同步维护，不产生新的语义。

### D3 兼容性与回滚

- 无服务端改动、无 schema/协议变化；错误文案变化不影响任何解析方。
- UI `ownershipAssignErrorMessage` 原样展示 message，路径会直接显示给用户。
- 回滚：还原本次 commit 即可；无数据迁移。

## 风险

- 定向扫描后，`ownership_groups` 不再是全量；已分析 `sync_ownership_inbox` 的 upsert/delete 逻辑，本操作的待归属目录都在子集内，其他目录由常规同步处理。
- 错误文案包含相对路径，可能出现在同步失败日志；相对路径不含用户名/盘符，符合 spec。
- 新增 `label` 参数需要同步修改全部调用点，遗漏会编译失败，风险可控。

## 测试策略

- 单测 `read_local_task_snapshot_files`：非 UTF-8 文件 → 错误消息包含相对路径。
- 单测 ownership 索引：强制全量扫描含非 UTF-8 的 `prd.md` → 错误消息包含相对路径。
- 单测 `set_task_ownership`：目标任务正常 + 兄弟目录含非 UTF-8 → `defer` 成功；并用 `read_local_task_snapshot_files(None)` 断言全量扫描确实会失败，证明测试夹具有效。
- 单测 `set_task_ownership`：目标任务自身含非 UTF-8 → 失败且消息带路径。
- 既有 task_sync / task_command 测试保持通过。