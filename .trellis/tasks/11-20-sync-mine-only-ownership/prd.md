# 同步只处理本人任务：枚举期归属过滤、服务端新建归属校验、改派权限收紧

## Goal

客户端同步的口径改成「只上传自己创建的新任务，或者更新指派给自己的正在处理的任务」。落地三件事：

1. **枚举期归属过滤**：本地任务目录在进入任何同步流程之前先判归属，不是本人的目录整目录不处理（不进首同步差异、不进上传队列、不进待归属收件箱、不发 `/files` 探针、不弹窗）。
2. **服务端新建校验**：任务在服务端尚无行时不再无条件放行上传，上传方必须是该任务解析出来的负责人。
3. **改派权限收紧**：改派只允许「当前负责人」「项目负责人（lead）」「把任务接到自己名下（自取）」三种操作者。

## 背景

现场（2026-11-20）：`mdp-management-web` 接入后首次同步弹「任务差异需要确认」，差异是「看板推送任务支持配置截图服务账号（仅本地存在）」。该目录 `.trellis/tasks/11-16-dashboard-push-service-account` 的 `task.json` 是 `creator=yhj / assignee=yhj / branch=null`，本机 `.trellis/.developer` 是 `name=fenglei`。

链路与缺陷：

- 首同步：本地目录 → `classify_task_snapshots` 判 `LocalOnly` → `gate_local_only_differences` 只把 **403** 当他人任务，**404**（服务端无该任务行）保留 → `initial_sync_review` 弹窗，不写 cursor。11-19 任务刻意把 404 定义为「真实本地新增」，因此这是它的验收行为，不是回归。
- 后续同步（真正的数据污染）：`local_sync_state_from_groups` 把「无基线且本地非空」的目录一律判 dirty → `upload_directories` 只过滤 inactive control 和 readonly → 服务端 `assertUploadAllowed` 在 `!row` 时直接 `return { task: null, lease: null }` **不做任何归属校验** → `commitUpload` 用 `resolveAssignee()` 从 `task.json` 反查负责人，非本人就写成 `stage='pending'` 行。也就是说客户机会**替别人在服务端建任务行**。
- 改派：`task-command-service.js` 的 `commandTarget()` 只校验**目标**成员是否可写，不校验**操作者**；Web 端 `assignmentActionState()` 只看任务是否归档。任何成员都能改派任何任务。

## User Flow

1. 接入项目首同步 / 每轮常态同步：客户端枚举本地 `.trellis/tasks/*`，逐个判归属。
   - 归属不是本人 → 整目录跳过，日志记一条（含目录与判定依据），不产生差异、不上传、不发探针。
   - 归属是本人或无归属信息 → 走原有流程（首同步分类、live sync 上传、待归属收件箱）。
2. 归属为本人但服务端还没有这条任务：上传后服务端校验「上传方 = 解析出的负责人」，通过则建行并给出租约；不通过返回 `403 TASK_WRITE_FORBIDDEN`，客户端把该目录标为只读镜像并继续同步其他目录。
3. 看板/客户端改派：
   - 当前负责人改派给自己或别人 → 允许。
   - 项目 lead 改派任何任务 → 允许。
   - 普通成员把别人的任务改成自己（自取）→ 允许。
   - 普通成员把别人的任务改成第三个人 → 拒绝（403），UI 提示失败。
4. 改派成功后服务端照旧下发 `assign_task` 命令，目标客户端写本地 `task.json` 并上传 → 下一轮该目录在目标客户端恢复为「我的任务」。

## Requirements

- **R1 客户端归属谓词**：判定 owner 取 `task.json.assignee`（非空、trim 后），为空时回退 `task.json.creator`；比较大小写不敏感。
  - owner 为空、读不到 `task.json`、解析失败、或读不到本机 developer id → **不丢弃**（fail open，保持现有行为）。
  - owner 等于本机 developer id → 本人任务，保留。
  - 本地任务控制状态里该目录存在且 `state.is_writable_local()`（`materialized`/`claimed`/`pending_delivery`）→ 保留（改派给我时由服务端下发控制记录，此时本地 `task.json` 可能还没更新）。
  - 其余 → 丢弃。
- **R2 单点过滤**：过滤发生在本地任务枚举处，覆盖首同步（review/bootstrap/safe 全入口）、live sync dirty 判定、`upload_directories`、待归属收件箱、冲突处理读取本地文件，不允许只修一条路径。
- **R3 不发探针**：被丢弃的目录不得触发 `GET /api/agent/task-spaces/:id/files` 归属探针；首同步差异集合里也不得出现该目录。
- **R4 服务端新建归属校验**：`assertUploadAllowed` 在任务行不存在且本次上传携带非删除文件时，必须用本批文件里的 `task.json` 解析负责人：
  - 解析出的 `userId` 等于上传 Agent 的 `userId` → 继续（保持现有 materialized/pending 逻辑）。
  - 解析出的 `userId` 不等于 Agent 的 `userId` → `403 TASK_WRITE_FORBIDDEN`，整批拒绝，不写文件、不建行、不递增 revision。
  - `task.json` 缺失或无法解析（解析结果回退到上传者本人）→ 视为上传者本人，行为不变（fail open，避免阻塞合法上传）。
- **R5 已存在任务行语义不变**：他人负责的任务仍返回 `409 TASK_WRITE_FORBIDDEN`（现有 `readonly_task_dirs` 流程不变）；归档、版本、租约校验顺序和错误码不变。
- **R6 改派权限**：服务端 `enqueue()` 处理 `assign_task` 时校验操作者，满足其一才允许：
  - `actor.userId === 任务当前 assignee_user_id`；
  - `actor` 是该项目的 lead；
  - `assigneeUserId === actor.userId`（自取）。
  否则 `403 FORBIDDEN`，返回可读文案；不写命令、不发通知。`create_task` 权限不变。
- **R7 可诊断**：客户端跳过他人任务目录时打一条 warn 日志，含任务目录、判定出的 owner 与依据（`TASK_JSON` / `CONTROL`）；
  服务端新建校验拒绝时日志/details 带任务目录与解析出的负责人。
- **R8 保持 11-19 语义**：403/404/409 的归属探针语义不动。过滤生效后，走到探针的只可能是本人或无归属信息的目录，因此 404 = 真正的本地新增任务依然成立。
- **R9 不新增状态文件字段**：不引入新的 cursor 字段；被过滤的目录不写 `readonly_task_dirs`（它们不是「只读镜像」，而是根本不处理）。

## Non-goals

- 不做「新任务必须带命令凭证」的来源证明（用户明确 L2 不变）。
- 不依据服务端 `fetch_task_ownership` 推断归属，也不引入网络请求做归属判定。
- 不改 `visibleTaskIds` 服务端裁剪语义、不改归档流程、不改 `task.json` 结构。
- 不重做首同步 review 弹窗文案与交互。
- 不改通知行为（11-19 已完成）。
- 不改 Web 端改派控件的可见性/禁用逻辑（服务端 403 通过现有 toast 呈现）；若后续需要 UI 预置灰，另行建任务。

## Acceptance Criteria

- [ ] 用现场绑定（binding `23d5d14d-44a4-4440-b896-53148c5b2d95`，taskSpace `d3a320e8-21d7-4381-a95a-a96936481d4a`，`initialSyncMode=review`）重新首同步：不再弹「任务差异需要确认」；`initialSyncCompleted=true`；`live-cursors.json` 出现该 taskSpace 的 revision；`desktop.log` 有一条跳过 `11-16-dashboard-push-service-account` 的 warn，且无该目录的 `/files` 请求。
- [ ] 同一绑定下修改该他人任务目录的文件：不上传、服务端 revision 不变、无 409 日志。
- [ ] 本地新建一个 `assignee` 为本机 developer id（无 `branch`）的任务目录并首同步：仍以 `LocalOnly` 出现并按 review 模式弹窗；点「仅同步无冲突项」后服务端出现该任务行、`stage='materialized'`、租约归属本机。
- [ ] 本地新建一个 `assignee` 为他人 developer id 的目录（模拟篡改）：上传被服务端 `403 TASK_WRITE_FORBIDDEN` 拒绝，服务端不产生任务行，客户端该目录进入 `readonly_task_dirs`。
- [ ] 本地已有他人任务的目录，把手写 `task.json` 的 `assignee` 改成本机 developer id：因客户端过滤先放行，服务端已有行时按 R5 返回 `409 TASK_WRITE_FORBIDDEN`；服务端无行时按 R4 通过并成为本机任务（已知残留风险，见 Risks）。
- [ ] 普通成员 A 把负责人为 B 的任务改派给 C：`403 FORBIDDEN`，无命令行写入，看板操作列表不新增记录。
- [ ] 普通成员 A 把负责人为 B 的任务改派给自己：成功，目标客户端收到 `assign_task` 并落地 `task.json`。
- [ ] 项目 lead 改派任何任务：成功。
- [ ] 任务当前负责人把任务改派给别人：成功。
- [ ] 服务端测试覆盖：`!row` + 我是负责人 → 建行；`!row` + 负责人是别人 → 403 且零写入；`!row` + task.json 无 assignee → 建行（fail open）。
- [ ] 客户端单测覆盖：owner=本人、owner=他人、owner 空、creator 回退、读不到 dev id（fail open）、存在可写 control 行、目录被过滤时不发探针且不进差异。
- [ ] `cargo test`（`packages/desktop/src-tauri`）与 `yarn test`（`node --test packages/*/test/*.test.js`）全绿。

## Risks

- **篡改 task.json 可自封负责人**：`task.json` 是本地文件，可被手工改。改了 `assignee` 且服务端无该行时，服务端 `resolveAssignee` 会按篡改后的值认人。彻底堵住需要来源凭证（命令实例），本次明确不做。
- **误杀自己的任务**：谓词取 `assignee` 优先，若服务端已改派给我但本地 `task.json` 还没更新，且控制记录尚未落盘 → 该目录短暂被跳过；改派命令到达后恢复。fail open 分支（读不到 dev id / task.json 坏）保证不会静默丢任务。
- **过滤点遗漏**：本地枚举有两个入口（`local_files`→`local_groups`、ownership index 的 `indexed_local_groups`），漏掉任一都会让 live sync 继续上传他人任务。implement 里逐点列出并加测试。
- **只读标记与过滤语义混淆**：被过滤目录不写 `readonly_task_dirs`，避免 UI 显示「只读镜像」而实际是「不归我管」；如果后续需要展示，另行设计。
- **改派权限收紧影响既有习惯**：普通成员不能再把任务指派给第三人，需要通过 lead。若现场有依赖，会在 403 时立刻暴露。
- **服务端新建校验的 fail open**：`task.json` 无 `assignee` 时无法判定，只能放行；这是本次接受的边界。
