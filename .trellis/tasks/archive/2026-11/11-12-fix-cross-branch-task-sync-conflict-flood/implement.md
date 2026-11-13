# 实施计划

## 1. 前置约束

- 活跃任务：`.trellis/tasks/11-12-fix-cross-branch-task-sync-conflict-flood`
- 工作分支：用户明确要求在真实检出的 `main` 上直接实施，不创建、不切换 Git 分支。
- PR 基线：`main`
- 未经用户对最终计划再次确认，不运行 `task.py start`，不改产品代码。
- 实施过程中不执行构建；全部代码、测试和规范修改完成后只做一次最终编译验证。
- 不清空或回滚工作区已有未跟踪任务目录。
- 不直接清理远端数据库；先完成代码与 dry-run 工具，正式 apply 作为独立停机步骤。

## 2. 变更范围

### Agent / 共享快照

- `packages/shared/task-snapshot.js`
- `apps/desktop/src-tauri/src/agent/task_sync.rs`
- `apps/desktop/src-tauri/src/agent/task_command.rs`
- `apps/desktop/src-tauri/src/agent/http.rs`
- `apps/desktop/src-tauri/src/agent/device.rs`
- `apps/desktop/src-tauri/src/agent_service.rs`
- Rust 模块内单元测试

### 服务端

- `apps/server/team/task-snapshot-service.js`
- `apps/server/team/http.js`
- `apps/server/test/team-task-snapshot.test.js`
- `apps/server/test/team-gitless-http.test.js`

### 桌面与 Web

- `apps/web/src/desktop/ControlApp.tsx`
- `apps/desktop/src-tauri/src/main.rs`
- `apps/desktop/src-tauri/permissions/desktop.toml`
- `apps/desktop/src-tauri/capabilities/live-control.json`
- `apps/web/src/components/layout/ProjectRail.tsx`
- `apps/web/src/features/board/dialogs/CreateTaskDialog.tsx`
- `apps/web/src/features/board/dialogs/TaskOwnershipDialog.tsx`（新增）
- `apps/web/src/pages/board/BoardPage.tsx`
- `apps/web/src/lib/project-rail-association.js`
- `apps/web/src/lib/project-rail-association.d.ts`
- `apps/web/test/project-rail-association.test.js`

### 清理与规范

- `scripts/task-space-duplicate-cleanup.js`
- `apps/server/test/task-space-duplicate-cleanup.test.js`
- `packages/shared/test/task-snapshot.test.js`
- `.trellis/spec/backend/desktop-realtime-sync.md`
- `.trellis/spec/backend/task-ownership-and-conflict-idempotency.md`
- `.trellis/spec/frontend/rendering-and-state.md`

## 3. 实施顺序

### Step 1：共享任务元数据

- [ ] 在 `groupTaskSnapshotFiles()` 解析 `task.json` 时同时提取 `taskId` 和 `taskBranch`。
- [ ] 保持现有返回字段兼容；空、非法或非字符串 `branch` 归一为 `null`。
- [ ] 增加纯函数级测试：正常分支、空分支、非法 JSON、非字符串 branch、归档目录。
- [ ] 确认任务正文、摘要和 CAS 计算不变。

验证：

```powershell
node --test packages/shared/test/task-snapshot.test.js
```

### Step 2：Agent 归属查询 API

- [ ] `AgentApiClient` 增加 `fetchTaskOwnership(taskSpaceId, taskIds)`。
- [ ] 服务端新增 `POST /api/agent/task-spaces/:taskSpaceId/task-ownership`。
- [ ] 服务端复用 `bindingContext()` 和项目访问校验，只返回有效 taskSpace 元数据。
- [ ] 限制单次 200 个 ID，去重、稳定排序，不返回任务正文。
- [ ] HTTP 测试覆盖未绑定、越权项目、disabled taskSpace、任务存在于多个分支和任务不存在。

验证：

```powershell
node --test apps/server/test/team-task-snapshot.test.js apps/server/test/team-gitless-http.test.js
```

### Step 3：客户端统一归属门禁

- [ ] 在 `AgentTaskSnapshotSync` 增加归属分类和唯一推断，不把分类逻辑散落到 watcher/pull/retry。
- [ ] `_uploadDirectories()` 只把 `syncable` 任务送入批次。
- [ ] `_uploadBatch()` 在真正网络调用前重新读取 pending files 对应任务的分支。
- [ ] pending retry、bootstrap、incremental dirty、deferred、command、overwrite 全部复用该门禁。
- [ ] 唯一归属时调用 `task.py set-branch` 自动补齐并继续当前操作。
- [ ] 多分支歧义写入 cursor `ownershipPending`，发出一次 `task_ownership_review` 控制事件。
- [ ] fingerprint 不变时不重复发事件、不上传；任务内容变化后可重新审查。
- [ ] other-branch 任务不写服务端、不创建 CAS conflict，也不标记为网络错误。
- [ ] 切回对应分支或用户改写归属后自动恢复。

验证：

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml task_sync
```

必须新增的断言：

- [ ] watcher 路径不因 branch 不匹配调用上传 API。
- [ ] pull 中的 dirty 目录不因 branch 不匹配调用上传 API。
- [ ] pending retry 被阻断且 pending 原样保留。
- [ ] bootstrap/safe/deferred/command 上传全部被同一门禁拦截。
- [ ] 单分支空 branch 自动补齐并上传。
- [ ] 唯一服务端主张自动补齐；主张冲突进入一次 review。
- [ ] review 后重启不重复事件；用户选择后清除状态。

### Step 4：服务端分支边界

- [ ] `applyChangesInternal()` 把 taskSpace 分支传给 `validateCompleteTaskGroups()`。
- [ ] 合并且新增的每个任务目录必须包含 `task.json.branch`。
- [ ] 空 branch 返回 `TASK_OWNERSHIP_REQUIRED`。
- [ ] branch 不等于 taskSpace 返回 `TASK_OWNERSHIP_MISMATCH`。
- [ ] 删除墓碑和合法归档移动保持现有行为。
- [ ] 错误详情只暴露 task ID、目录、期望分支、实际分支和下一步，不返回正文。
- [ ] 断言失败时 revision、任务文件、batch 和 conflict 均无变化。
- [ ] `overwrite-server` 同样经过该校验。

验证：

```powershell
node --test apps/server/test/team-task-snapshot.test.js
```

### Step 5：创建任务写入归属

- [ ] `task.py create --no-start` 成功后立即调用 `task.py set-branch <taskDir> <binding branch>`。
- [ ] set-branch 失败时命令失败，不把未归属任务当作创建成功。
- [ ] 已存在且内容匹配的幂等创建路径也要确认并补齐 branch。
- [ ] `_finishCreate()` 继续通过同一 CAS 上传。
- [ ] 测试真实 `task.py` 生成的 `task.json.branch`。

验证：

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml task_command
```

### Step 6：服务端冲突幂等

- [ ] `writeConflict()` 在 `BEGIN IMMEDIATE` 内查询同 Agent、taskSpace、task 的 pending 记录。
- [ ] 存在时更新 files/revision/clientSequence/batchId，复用 conflict ID。
- [ ] 不存在时插入新记录。
- [ ] `listConflicts()` 对历史记录按同一身份分组，只返回最新 pending。
- [ ] 新建或历史重复数据都不得导致同名任务返回多条 pending。
- [ ] 不新增 schema 版本或数据库列。

验证：

```powershell
node --test apps/server/test/team-task-snapshot.test.js apps/server/test/team-gitless-http.test.js
```

测试必须包含：

- [ ] 连续 10 次相同冲突只保留 1 行且 ID 稳定。
- [ ] 不同 Agent 或不同任务仍各有独立 conflict。
- [ ] 手工插入大量历史 pending 后，list API 只返回每组最新一条。
- [ ] 冲突处理成功后允许下一次真实冲突创建新 pending。

### Step 7：客户端冲突重试抑制

- [ ] 冲突时在 cursor 写 `conflictBlocked[taskDir] = conflictId`。
- [ ] watcher、pull、SSE、重启和 pending retry 在解封前不自动重试。
- [ ] `use-server` 和成功 `overwrite-server` 清除对应 blocked 状态。
- [ ] `save-local-copy` 保持 blocked，因为服务端 conflict 仍 pending。
- [ ] 用户显式重新处理冲突时不依赖 watcher 自动解封。

验证：

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml task_sync
```

### Step 8：归属审查 UI

- [ ] `readLocalAssociations()` 增加 paused/pending 数量和任务目录。
- [ ] 保持现有 `deferredCount` 语义不变。
- [ ] `ProjectRail` 分支行区分“分支不匹配暂停”和“待确认归属”。
- [ ] 新增 `TaskOwnershipDialog`，打开时按需读取候选，不进入 3 秒轮询。
- [ ] 支持全选、批量归属当前分支、批量归属其他有效分支、暂不处理。
- [ ] 当前分支写入后立即同步并刷新 Board/关联摘要。
- [ ] control window 处理首次 `task_ownership_review`，关闭等同“暂不处理”。
- [ ] `CreateTaskDialog` 单分支隐藏选择器，多分支显示并采用既定默认顺序。

验证：

```powershell
node --test apps/web/test/project-rail-association.test.js
```

最终浏览器验收：

- [ ] 单分支项目创建任务不出现分支选择。
- [ ] 多分支项目创建任务可选择分支。
- [ ] 多分支歧义只出现一次批量审查。
- [ ] 选择 other-branch 后项目栏显示暂停数量，不再弹窗、不上传。
- [ ] 点击暂停数量可重新打开列表。
- [ ] 选择 current branch 后任务上传并出现在当前 Board。

### Step 9：历史清理工具

- [ ] 扩展现有 duplicate cleanup dry-run，输出 conflict 分组和最终 taskSpace 状态。
- [ ] 增加 `--cleanup-conflicts` 和 `--disable-remove-task-space` 显式开关。
- [ ] apply 前要求服务停止、备份数据库、taskSpace revision 未变化。
- [ ] 墓碑只删除 keep 与 remove 都存在的活动重复任务，不自动处理 old-only 或归档。
- [ ] 内容差异继续要求 `--allow-content-differences`。
- [ ] 每个 conflict 组只保留最新 pending，其余标记 resolved，不物理删除历史。
- [ ] remove taskSpace 最终状态为 disabled。
- [ ] 结果输出备份路径、墓碑数、resolved conflict 数、保留 conflict ID。

验证：

```powershell
node --test apps/server/test/task-space-duplicate-cleanup.test.js
```

### Step 10：规范与最终验证

- [ ] 更新 `.trellis/spec/backend/desktop-realtime-sync.md`，写入 task-level branch ownership、归属查询 API、冲突复用和客户端抑制。
- [ ] 更新 `.trellis/spec/frontend/rendering-and-state.md`，写入单/多分支选择、项目栏暂停状态和批量归属交互。
- [ ] 检查所有上传调用都经过统一门禁。
- [ ] 检查没有把 `base_branch` 当成任务同步归属。
- [ ] 检查旧 cursor 和旧数据库无 schema 迁移即可读取。
- [ ] 检查冲突错误不是通过普通自动重试路径处理。

先运行相关 Node 测试：

```powershell
node --test packages/shared/test/task-snapshot.test.js apps/server/test/team-task-snapshot.test.js apps/server/test/team-gitless-http.test.js apps/server/test/task-space-duplicate-cleanup.test.js apps/web/test/project-rail-association.test.js
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

全部功能代码完成后只执行一次最终编译验证：

```powershell
npm --prefix apps/web run build
```

如果 Rust/Tauri 命令有改动，再在同一个最终验证阶段执行唯一一次：

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

不会在每个小步骤执行构建。

## 4. 验收映射

| 验收 | 主要验证 |
| --- | --- |
| AC1 | Agent 错分支 watcher/pull/retry 测试；服务端 branch mismatch 测试 |
| AC2 | 独立 worktree/切回绑定分支恢复测试 |
| AC3 | 冲突稳定 ID、`conflictBlocked` 重启测试 |
| AC4 | 历史 pending 折叠读取测试；清理后响应体量检查 |
| AC5 | cleanup dry-run、服务停止、备份、disabled 状态测试 |
| AC6 | 上述 Node 测试全绿 |
| AC7 | 单分支/多分支创建 UI 浏览器验收 |
| AC8 | ownershipPending fingerprint 和重启测试 |
| AC9 | 服务端完整任务组 branch 校验测试 |
| AC10 | cleanup apply 后旧 taskSpace disabled、重复 conflict resolved、备份可打开 |

## 5. 生产清理流程

代码通过并部署后，按以下顺序执行；该流程不属于编码阶段：

1. 暂停所有桌面同步，并完全退出桌面客户端中的进程内 Agent。
2. 在服务端确认数据库绝对路径、当前 taskSpace revision 和备份目录可写。
3. 在生产数据库副本上执行 dry-run。
4. 人工核对 keep=`a8d34d0e-54af-4041-bb2c-4507665c7abe`，remove=`75984cbd-ed47-4389-bddf-2efbce07f275`。
5. 停止服务并再次确认 4317 无监听。
6. 执行 apply，记录备份路径、revision、墓碑数和 conflict resolved 数。
7. 重启服务，重新登录 Agent，确认旧分支绑定不可同步、main Board 正常、冲突列表低于 1 MiB。
8. 保留备份直到真实 E2E 和至少一次重启验证完成。

## 6. 回滚点

- 代码回滚：按任务相关文件单独回退，不影响用户已有未跟踪任务。
- 数据清理回滚：停止服务，用本次 `VACUUM INTO` 备份覆盖生产数据库，再启动并重新登录 Agent。
- 归属误判回滚：执行 `task.py set-branch` 修正本地任务；不通过删除服务端冲突记录解决。
- 单任务冲突误抑制：用户明确重新处理冲突后清除 cursor blocked；不直接清空全部 cursor。

## 7. 当前收尾状态

- [x] Agent 任务级归属门禁、pending 冲突抑制和归属 facade 已实现。
- [x] 服务端 ownership API、完整任务分支校验、冲突稳定 ID 和历史列表折叠已实现。
- [x] ProjectRail、TaskOwnershipDialog、control window 和单/多分支创建交互已实现。
- [x] 历史清理脚本支持 dry-run、备份、显式冲突收敛和旧 taskSpace 停用。
- [x] 前后端规范已拆分并更新，相关规范文件均在上下文注入阈值内。
- [ ] 自动化测试、Web 构建、Rust/Tauri 编译和真实浏览器验收：按用户要求本轮跳过。
- [ ] 远端数据库 dry-run/apply：未执行，需停机、备份并由用户单独授权。
