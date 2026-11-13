# 扫描与持久化

## 共享 watcher

- `packages/shared/trellis-watcher.js` 是目录过滤、递归监听、事件字段和 close/rebuild 的唯一实现。
- 单机 `apps/server/watcher.js` 只做兼容包装；桌面 sidecar 直接使用共享模块。
- 团队服务端不得启动该 watcher 监听自己的项目工作副本。
- 事件保留兼容字段 `relativePath`（相对 `.trellis`）和 `trellisPath`（相对仓库，含 `.trellis/`）。

## 扫描输入

每个仓库的扫描根为 `.trellis/tasks`。只有包含 `task.json` 的任务目录成为任务；`archive/` 下任意嵌套层级的任务仍会被发现并标记为归档。

这里有两类扫描输入：

- standalone 直接扫描 SQLite 白名单中的本机仓库，可读取 workspace 和 Git 元数据。
- Team taskSpace 只扫描 `sync_task_space_file` 物化到系统临时目录的 `.trellis/tasks/**`，不读取
  Git、workspace、`.developer`、scripts、spec、config 或 workflow。

任务证据主要来自：

- `task.json`、`prd.md`、`design.md`、`implement.md`。
- `implementation-report.md`、`check-report.md`、`e2e-report.md`。
- `research/` 目录。
- `implement.jsonl`、`check.jsonl` 条数。
- 开发者 workspace 的 `index.md` 和 `journal-*.md`。
- Git 分支元数据。

阶段判断读取原文件。详情展示时每个产物预览截断到 `40_000` 字符，但截断不能影响阶段推导。

## 阶段语义

13 个阶段顺序为：

```text
prd -> research -> design -> implementPlan -> context -> review
    -> implement -> check -> e2e -> spec -> commit -> archive -> journal
```

推导依据包括 PRD 的 Requirements/Acceptance Criteria 语义、报告内容、`task.status`、JSONL 记录、workspace journal、相关文件、提交和归档位置。进度只统计必需阶段；`e2e` 标记为可选，缺少它不阻塞后续收尾。

`task.status=in_progress` 只表示任务已开始，不能单独完成 `implement`。实施完成还必须存在实施报告、检查报告、已勾选验收项、提交或 `status=completed`；`implement.md` 中已勾选的检查项只有在已有上述实施完成证据时，才能进一步完成 `check`。归档任务仍按归档目录补齐历史阶段，不因这项证据门禁回退已完成阶段。

E2E 只接受明确的执行完成证据。`implement.md` 中的计划、条件句或“下一步做 E2E”不能计为完成；否定语句也不能计为完成。[apps/server/test/loader.test.js](../../../apps/server/test/loader.test.js) 对这些分支有回归。

人工阶段由 `setManualStage()` 写入 SQLite `task_stage` 表，键为 `${projectId}/${relativeDir}`。`withManualStages()` 只覆盖被勾选的阶段，不自动补齐前序阶段。写入人工阶段时还必须把 `executionTaskKey` 传入同一事务，追加 `stage_manual_confirmed` 事件。移除项目时必须在同一事务中清理该 `${projectId}/` 前缀下的人工阶段和 `${projectId}::` 前缀下的执行扩展数据，避免项目重新加入或任务路径复用时继承旧值。

## 列表与详情

`scanRepository()` 生成完整扫描结果。列表 API 使用 `toTaskListItem()` 白名单字段，避免把 `artifacts` 正文和额外详情带出；`scanTask()` 为详情返回最新单任务扫描结果。

`taskKey` 是 `${project.id}::${relativeDir}`，用于当前路径定位、缓存和前端选中态，归档后会变化。计划字段、标签和事件使用 `${project.id}::${task.id || dirName}` 形式的 `executionTaskKey`，归档不改变该身份。扫描汇总必须检查同一项目内执行身份是否重复；冲突任务仍返回列表，但 `executionIdentityValid=false`，不得投影共享扩展数据或接受扩展写入。

团队任务索引列表保留 `archivedAt`。归档查询按真实归档时间倒序并生成稳定游标；活动任务仍按最后活动时间倒序。归档响应额外返回当前筛选范围内出现过的负责人集合，供完整负责人筛选使用。

详情合并使用 `mergeTaskDetail()`：先合并磁盘详情与缓存列表/分组字段，再应用 SQLite 当前人工阶段。SQLite 人工阶段必须是最终值，缓存中的 `stages`、`manualStage` 和 `derivedStage` 不得反向覆盖。

## 缓存

`loader.js` 维护模块级 `taskScanCache` 和 `gitMetadataCache`：

- 任务缓存按文件 stat 签名判断是否复用。
- Git 元数据缓存 TTL 为 `60_000ms`。
- 消失的任务会从缓存中清理。
- Team snapshot Worker 使用唯一临时根物化，必须传 `disableTaskCache: true`；否则
  `taskScanCache` 会按临时路径累积旧条目。
- 单个任务变化可以走 `refreshCachedTask()`；workspace 或关系变化可能要求更宽范围重算。
- PRD 验收计数、Design 是否非骨架等轻量摘要必须随新证据进入任务缓存签名，并通过 `toTaskListItem()` 保留摘要对象、移除产物正文；不要在列表投影中再套一层不存在的 `summary.summary`。

HTTP 层把完整 board 持久化到 SQLite `scan_cache` 单行，并用 `SCAN_SCHEMA_VERSION` 校验，当前协议为 `11`。读取旧版本缓存时视为无效。SQLite `board_state` 保存刷新运行状态和 `executionWipLimit`；两者都不是业务事实来源。任务扫描事实来自仓库文件，人工阶段和执行扩展事实来自 `task_stage`、`task_execution`、`task_tag`、`saved_view`、`task_event`、`task_dependency`。

刷新完成后比较上一个有效 board 与新 board 的 `derivedStage`。首次追踪、扫描缓存升级失效或缺失时只写 `tracking_started` 基线；后续真实变化写 `stage_observed`。身份冲突或归档任务不作为阶段观察基线。人工阶段接口触发的刷新应抑制扫描观察，避免把人工写入重复记成扫描变化。

## SQLite 持久化

运行数据目录中的 `board.sqlite` 使用 Node 24 内置 `node:sqlite`，没有第三方驱动。主线程共享一个进程级连接，扫描 Worker 在自身线程内另开连接；`DatabaseSync` 不跨线程传递。

`database.js` 是 schema 和迁移的唯一所有者：

- 当前 schema 为 v12。新库和旧库升级都保留旧账号、团队、`team_project`、`project_live_*`、
  `git_operation`、`git_credential` 和插件表，并新增 `sync_project`、
  `sync_task_space`、`sync_task_space_file`、`sync_task_space_batch`、`sync_active_agent`、
  `sync_agent_binding`、`sync_agent_cursor`、`sync_task_index`、`sync_task_command`、
  `sync_task_merge_evidence`、`sync_conflict` 和 `sync_file_audit` 等 tasks-only 表。
- Team runtime 只读写 `sync_*`、账号、团队、审计和执行扩展表；旧 Git 和实时覆盖表只作为人工回滚材料，
  不在启动、扫描、项目接入或命令链路中读取。
- `sync_task_space_file` 保存 LF 规范化后的当前正文、摘要、删除墓碑、来源 Agent/用户和 revision；
  `sync_task_index` 以 `(task_space_id, task_key)` 隔离路径实例；跨 taskSpace 判定同一稳定任务时
  使用 `execution_task_key` 的 `::<task.json.id>` 后缀。默认查询在基线索引已有同一稳定任务 ID 时
  隐藏来源旧副本。
- `sync_agent_binding` 保存 `is_listening`、`listener_reported_at` 和 `last_listener_at`。
  `is_listening` 只是最近报告值，读取在线人数时必须叠加报告时间、设备心跳、active Agent 和
  project/taskSpace 状态。
- `task_dependency` 保存稳定 `executionTaskKey` 双方、原因、创建人、创建时间和可空解除时间；活动边 `(blocker_task_key, blocked_task_key)` 唯一，双向查询有索引。解除只写 `resolved_at`，历史行不删除。
- 启用 WAL、外键、`busy_timeout=5000` 和 `synchronous=NORMAL`。
- v10 -> v11 迁移必须在 `BEGIN IMMEDIATE` 中通过 `PRAGMA table_info` 幂等补三列，再创建
  `sync_agent_binding_listener` 索引；新库直接包含最终结构，v6-v10 升级复用同一迁移入口。
- v11 -> v12 迁移幂等补 `sync_project.baseline_branch`，创建 `sync_task_merge_evidence`、
  task ID 索引并回填基线；已有项目优先选择最早创建的活动 taskSpace，时间相同按 ID 排序。
- v10/v11 -> v12 迁移前使用 `VACUUM INTO` 写入 `backups/board.sqlite.pre-v12.*`。补列、表、索引、
  数据回填或 schema 版本写入任一步失败时整体回滚；大于 v12 的数据库拒绝打开。
- v1 -> v2 -> v3 顺序迁移在单一 `BEGIN IMMEDIATE` 事务中完成；迁移前用 `VACUUM INTO` 写入可独立打开的源版本快照，命名为 `board.sqlite.v1-backup` 或 `board.sqlite.v2-backup`。失败时主库保留源版本和原表，备份仍可独立打开。
- 首次初始化在 `BEGIN IMMEDIATE` 中一次性导入四个旧 JSON，并写入 `legacy_json_imported_v1`。
- 迁移后不再读写旧 JSON；它们只作为迁移来源和回滚备份。
- 损坏的旧 JSON 记录警告并跳过，不阻止服务启动。
- 项目批量新增、删除及重排、看板状态多字段更新、依赖创建/解除必须在事务中完成。移除项目时，同一事务按 `projectId::` 前缀清理其执行数据，并删除任一侧属于该项目的依赖行。

### Team tasks-only 持久化契约

- `sync_task_space.revision` 只由成功的非 no-op 快照批次递增；`indexed_revision` 只由成功投影推进。
- `sync_task_space_file` 的主键是 `(task_space_id, relative_path)`；删除写墓碑而不是物理删除，供增量
  cursor 获取最后一次删除。
- `sync_task_space_batch` 的主键是 `(agent_id, task_space_id, batch_id)`；请求摘要不同时拒绝相同 batchId。
- `sync_project.baseline_branch` 是项目级同步归属基线。新项目首次 attach 的分支成为基线；已有项目
  字段为空时由 attach 补齐，迁移时优先最早活动 taskSpace。
- `sync_task_merge_evidence` 每项目、每稳定 task ID 最多一条，保存 `tracked-in-head`、完整 HEAD SHA、
  来源/基线分支、任务目录和受信来源 Agent/用户。重复证据只允许相同基线、来源和分支，不覆盖冲突内容。
- `sync_active_agent` 与 `agent_device` 同事务替换；`sync_agent_binding`、cursor 和命令都只能引用当前
  active Agent。
- `sync_task_command` 的 `pending -> delivered -> running -> succeeded|failed|cancelled` 状态变更必须
  使用条件更新；过期 `delivered/running` 租约恢复 `pending`，不能并发执行同一命令。
- `sync_conflict` 只保存待处理冲突摘要；`sync_conflict_backup` 只在覆盖服务端时保存双方正文；
  `sync_file_audit` append-only，不保存完整历史正文。
- `sync_task_space_scan_cache` 以 taskSpace 和 `indexed_revision` 隔离；旧 revision Board 不得覆盖新 revision。
- `sync_project_member.trellis_dev_id` 是「只看我的」的唯一依据：查询时用
  `EXISTS (SELECT 1 FROM sync_project_member mine WHERE mine.project_id = t.project_id AND mine.user_id = ?
  AND mine.trellis_dev_id IS NOT NULL AND t.assignee_dev_id = mine.trellis_dev_id COLLATE NOCASE)`
  关联 `sync_task_index.assignee_dev_id`，不得用索引期快照的 `assignee_user_id` 代替——成员 dev id 变更
  不重建索引。成员映射同时参与 Board 查询的 `etag` 与 `cacheKey` 哈希，否则旧结果命中或错误 304。
- 每日 `board.sqlite.snapshot.*` 备份由 `VACUUM INTO` 产生，保留 7 份；备份失败记录告警，不回滚业务。

### 依赖图与风险投影

#### 1. Scope / Trigger

- Trigger：新增 SQLite 表、写接口、详情投影、保存视图条件和首屏风险字段，属于数据库、HTTP 与前端跨层契约变更。

#### 2. Signatures

- SQL：`task_dependency(id, blocker_task_key, blocked_task_key, reason, created_by, created_at, resolved_at)`。
- `POST /api/tasks/dependencies`：请求 `{ blocked: { projectId, taskPath }, blocker: { projectId, taskPath }, reason }`，成功 `201`。
- `DELETE /api/tasks/dependencies`：请求 `{ id }`，成功 `200`。
- `GET /api/board/settings?teamId=`：读取全局或指定团队 WIP，成功 `200`。
- `PUT /api/board/settings`：请求 `{ executionWipLimit, teamId }`，成功 `200`。
- `GET /api/saved-views?teamId=`、`POST/PUT/DELETE /api/saved-views`：全局或指定团队作用域。

#### 3. Contracts

- A blocked by B 固定写为 `blocked_task_key = A`、`blocker_task_key = B`；B 的 `blocks` 由同一行反向生成。
- 活动边 `(blocker_task_key, blocked_task_key)` 唯一；解除只写 `resolved_at`，不删除行。创建/解除时间与对应 `task_event` 同事务。
- 列表只返回 `blockedByCount`、`blocksCount`、活动阻断时长、WIP 状态、开工条件缺口数量和完成条件缺口数量。
- 详情返回活动 `blockedBy` / `blocks`，以及已结束 `resolvedBlockedBy` / `resolvedBlocks`；历史项必须带 `createdAt`、`resolvedAt` 和区间 `durationMs`。
- 当前 WIP 指未归档、身份有效且 `derivedStage === "implement"` 的任务数。上限存 `board_state.executionWipLimit`，默认 `2`、允许 `1`–`9`，只提醒。
- 开工条件对未归档任务在所有阶段计算；进入实现后仍可返回尚未补齐的规划证据。归档任务不再返回开工条件缺口。
- 完成条件不把归档扫描补出的 `archive-gap` 阶段当作实施或检查报告；归档任务仍要求真实报告、验收状态和 commit 证据。
- 保存视图 `blocked` 只接受 `any | blocked | unblocked`；缺失字段按 `any`。
- 保存视图 `team_id = NULL` 表示全部团队全局视图，具体值表示团队视图；`user_board_state.team_id = ''` 同理表示全局 WIP。移除团队成员时删除该团队作用域，保留全局数据。

#### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 缺失任务、身份冲突、路径越界 | 写入前拒绝，依赖和事件计数不变 |
| 自引用、同向重复活动边 | 拒绝，保留已有边 |
| 新增边使活动图形成二/三/任意长度闭环 | 拒绝，错误包含闭环标题 |
| 原因为空或超过 500 个 Unicode 字符 | 拒绝 |
| 依赖行写入成功但事件失败，或解除更新成功但事件失败 | 整笔事务回滚 |
| WIP 不在 1–9 | 拒绝保存 |
| WIP 达到或超出上限 | 只返回 `at_limit` / `over_limit`，阶段写入继续成功 |

#### 5. Good/Base/Bad Cases

- Good：A 同时被 B、C 阻断时仍显示两条原因；解除 B 后 A 不进入待推进队列，解除最后一条活动边后才进入。
- Base：旧保存视图没有 `blocked` 字段，保持原优先级、标签等筛选结果。
- Bad：解除时物理删除依赖行，导致原因、创建人、创建时间和结束时长永久丢失。

#### 6. Tests Required

- `apps/server/test/database.test.js` / `database-v10.test.js`：新库 v12、v10/v11 补列与基线、
  v6/v7/v8/v9 升级、源版本备份、旧表保留、归档时间回填、失败回滚和大于 v12 拒绝。
- `execution-store.test.js`：缺失、自引用、重复、原因边界、二/三节点环、创建/解除事件回滚、重开和重新创建。
- `execution-projection.test.js`：列表不带完整数组；详情同时返回活动与已结束双向历史；解除区间时长使用 `resolvedAt - createdAt`；开工、完成条件不改变阶段完成状态。
- 真实 HTTP：失败前后依赖与事件计数一致；循环错误含标题闭环。
- 浏览器：创建/解除后刷新一致，解除历史可见，860px 无页面级横向溢出。

#### 7. Wrong vs Correct

Wrong：

```js
if (dependency.resolvedAt) {
  resolvedBlockedKeys.add(dependency.blockedTaskKey);
  return;
}
```

Correct：

```js
if (dependency.resolvedAt) {
  resolvedBlockedKeys.add(dependency.blockedTaskKey);
  resolvedBlockedBy.get(dependency.blockedTaskKey).push(
    dependencySummary(dependency, dependency.blockerTaskKey, relatedTask, dependency.resolvedAt)
  );
  return;
}
```

只记录“曾经解除过”不足以解释阻断成本；历史投影必须保留双方、原因和固定结束时长。

#### Scenario: 开工条件与完成条件投影

##### 1. Scope / Trigger

- Trigger：修改风险派生、`/api/board` 风险摘要、`/api/task` 缺口数组或任务详情的条件检查布局。

##### 2. Signatures

- `deriveTaskRisk(task)` 返回 `{ wipState, dorMissing, dodMissing }`。
- `/api/board` 的任务 `execution.risk` 只返回 `dorMissingCount`、`dodMissingCount` 和 `wipState`。
- `/api/task` 除数量外还返回 `dorMissing: string[]` 与 `dodMissing: string[]`。

##### 3. Contracts

- 未归档任务无论处于规划、实现、检查还是收尾阶段，都必须计算 `dorMissing`；归档任务返回空数组。
- `dodMissing` 只在归档或收尾阶段计算。
- 列表不得返回完整缺口数组；详情可以返回数组，但不得因此携带产物正文或事件正文。
- 前端用户文案统一使用“开工条件”和“完成条件”，内部字段名保持兼容。
- 前端映射未知缺口文本时必须保留原文本，并显示“其他 / 补齐证据”，不能静默丢弃。

##### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 详情尚未加载，只有数量 | 显示读取中，不把未知数量当成“全部满足” |
| 详情加载失败且没有数组 | 显示“条件明细暂不可用”并禁用“查看明细” |
| 缺口文本没有前端匹配规则 | 归入“其他”，保留原文本和兜底建议 |
| 归档任务 | 不显示开工条件，只显示完成条件结果 |
| 实现中已有开工缺口 | 显示缺口数量，并允许在详情内联展开 |

##### 5. Good/Base/Bad Cases

- Good：实现中任务缺少设计和实施计划时，列表显示“开工条件仍缺 2”，详情展开后显示对应阶段、证据和下一步。
- Base：规划任务只突出开工条件，完成条件显示“暂不适用”。
- Bad：进入实现后把开工缺口清零，导致带着准入问题推进却不可见。
- Bad：在列表响应中包含完整缺口数组、阶段证据或产物正文。

##### 6. Tests Required

- `execution-projection.test.js`：规划、实现、检查和归档任务的开工条件计算，以及完成条件边界。
- `condition-checks.test.js`：全部已知缺口文本、动态验收计数、阶段映射、阶段标签和未知文本兜底。
- 浏览器：1440px、1024px、860px、浅色和深色；实现中“查看明细”内联展开，13 阶段证据保持可见。

##### 7. Wrong vs Correct

Wrong：

```js
if (!task.archived && PLANNING_STAGES.has(task.derivedStage)) {
  // 开始实现后不再计算开工缺口
}
```

Correct：

```js
if (!task.archived) {
  // 开工缺口在所有活动阶段持续可见
}
```

扫描缓存中的 JSON 损坏或 schema 版本不匹配都视为 cache miss。SQLite 打开、schema、迁移和运行期查询失败是致命错误，不回退到旧 JSON。

### 事件、撤销与指标

- `task_event` 保持 append-only。计划字段、人工阶段、依赖创建和依赖解除事件的 `reversible=1`，同一用户操作共享 `correlation_id`；扫描观察和追踪起点不可撤销。
- 详情一次读取最多 1000 条事件并按 `occurred_at DESC, id DESC` 返回；超过窗口时 `eventTruncated=true`。只有窗口内无法确认最新未撤销候选组时才禁用撤销；窗口内已存在可确认候选时可以继续撤销。
- `operation_undone` 只追加补偿事件，payload 保存 `targetCorrelationId`、`targetEventIds` 和恢复摘要，不删除或改写原事件。
- 撤销前必须核对当前投影仍等于目标事件的 `after`；计划、人工阶段或依赖已被后续操作改变时拒绝执行。
- 计划、人工阶段、依赖活动性恢复与补偿事件必须在同一 `BEGIN IMMEDIATE` 事务完成；补偿失败整体回滚。
- 指标由最近事件窗口、当前归档状态和依赖区间实时计算，不持久化聚合值。完整度为 `missing | partial | tracked`；`tracking_started` 只提供追踪起点，不产生阶段停留。
- 归档时间来自归档目录内 `task.json` 的 mtime，移动目录时可能早于最后阶段事件。出现该情况时必须保守返回 `partial` 和明确原因，以最后阶段事件作为保守结束点，不能把不完整时长标成 `tracked`。
- 详情读取事件失败时保留任务基础字段、产物、阶段和依赖，只把事件时间线降为空并用 `historyError`、`metricsError` 暴露局部错误；不能因此拒绝整个任务详情。
- `POST /api/tasks/undo` 在补偿事务成功后必须先刷新 Board 组合快照，并抑制扫描阶段观察，再返回刷新后的任务详情；否则撤销人工阶段后，旧 `boardCache` 仍可能把已删除的 `manualStage` 合并回响应。
- 列表只返回 `summarizeExecutionMetrics()` 的轻量字段；完整 `history`、`metrics` 和事件正文只在 `/api/task` 详情返回。

#### Scenario: 可逆事件、撤销与指标重建

##### 1. Scope / Trigger

- Trigger：新增跨层撤销 API、append-only 补偿事件、详情历史投影和事件驱动指标。改动涉及 HTTP、SQLite 事务、归档稳定身份与前端渲染。

##### 2. Signatures

- `POST /api/tasks/undo`：请求 `{ projectId: string, taskPath: string }`；成功返回补偿 `correlationId`、`eventId`、`targetCorrelationId`、`targetEventIds`、`restored` 和刷新后的 `task`。
- `readExecutionEvents(db, executionTaskKey, limit)`：返回 `{ events, eventTotal, eventLimit, eventTruncated, eventWindowStartAt }`，`limit` 上限 `1000`。
- `buildTaskHistory(options)`：返回倒序事件、截断窗口和 `undo` 元数据。
- `computeExecutionMetrics(options)`：显式接收 `events`、`dependencies`、`archived`、`archivedAt`、`now` 和事件窗口，返回 `missing | partial | tracked` 及证据事件 ID。

##### 3. Contracts

- 可逆事件为 `task_plan_updated`、`stage_manual_confirmed`、`dependency_created`、`dependency_resolved`，共享操作内 `correlation_id` 且 `reversible=1`。
- `operation_undone` 是不可逆补偿事件，payload 至少包含 `targetCorrelationId`、`targetEventIds`、`targetEventType`、`targetLabel` 和 `restored`。
- 撤销前当前计划、人工阶段或依赖状态必须等于目标事件的 `after`；恢复使用 `before`，原事件不得删除或改写。
- 同一事务内完成投影恢复和 `operation_undone` 追加。归档任务、身份冲突任务、没有候选组、候选已撤销或 after-state 已变化时拒绝且不写数据。
- `/api/board` 的 `execution.metrics` 只能是 `summarizeExecutionMetrics()` 摘要；`execution.history`、完整 `metrics` 和事件正文只出现在 `/api/task`。
- `tracking_started` 只提供追踪起点。没有阶段节点为 `missing`；缺少实现/检查节点、跨阶段扫描、事件截断或不可信归档终点为 `partial`；节点完整且归档终点可信才为 `tracked`。

##### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 计划/阶段/依赖当前值不等于目标事件 after | 400“后续操作已改变当前值”，不追加补偿事件 |
| 同一 correlation 已撤销 | 400“没有尚未撤销的可逆操作”，事件数不变 |
| 补偿事件写入失败 | 计划、阶段或依赖恢复与补偿事件整体回滚 |
| 归档任务或身份冲突 | 写事务前拒绝 |
| 1,000 条截断但窗口内能确认最新候选 | 允许撤销 |
| 截断导致无法确认最新候选 | 禁用撤销并说明窗口原因 |
| 事件表读取失败 | 保留标题、阶段、产物和依赖；`historyError` / `metricsError` 局部显示 |
| `archivedAt` 早于最后阶段事件 | `partial`，使用最后阶段事件作保守结束点，不展示精确数值 |

##### 5. Good/Base/Bad Cases

- Good：计划 A→B 后撤销，投影恢复 A，原更新事件和 `operation_undone` 均可读。
- Base：旧任务只有 `tracking_started`、没有阶段事件，返回 `missing` 和“tracking_started 不计作阶段停留”。
- Bad：撤销通过删除旧事件或把原事件标记为不可见；这会破坏 append-only 历史与跨窗口可重建性。

##### 6. Tests Required

- `execution-history.test.js`：四类撤销分支、after-state 冲突、重复撤销、补偿失败回滚、截断候选、归档和身份冲突。
- `execution-metrics.test.js`：固定 `now` 的确定性、missing/partial/tracked、追踪起点过晚、开放检查、回流、重叠阻断、归档结束边界。
- `execution-projection.test.js`：列表无事件正文、归档稳定身份、详情局部错误隔离、1,001 条事件摘要。
- 真实 HTTP 与浏览器：撤销后 API/Board/详情读回一致；重复失败计数不变；`partial` 不显示精确数值；820px 无页面级横向溢出。

##### 7. Wrong vs Correct

Wrong：

```js
db.prepare("DELETE FROM task_event WHERE id = ?").run(targetEventId);
```

Correct：

```js
withTransaction(db, () => {
  restoreProjectionFromBefore(target);
  appendTaskEvent(db, {
    eventType: "operation_undone",
    payload: { targetCorrelationId, targetEventIds, restored }
  });
});
```

撤销是追加补偿并恢复投影，不是删除或改写历史。

## 刷新与监听

[apps/server/watcher.js](../../../apps/server/watcher.js) 只监听白名单仓库的：

- `.trellis/tasks`
- `.trellis/workspace`
- `.trellis/.developer`

路径统一为 `/`。当前使用递归 `fs.watch`，主要面向 Windows/macOS 本机；Linux 或网络盘不支持递归监听时保留手动刷新回退。

事件进入 [apps/server/index.js](../../../apps/server/index.js) 后经过：

1. 默认 `400ms` 防抖，可由 `TRELLIS_WATCH_DEBOUNCE_MS` 调整，最低 `100ms`。
2. 合并多个事件。
3. 若已有 `inflightScan`，写入 `queuedRefresh`。
4. 当前扫描结束后再执行排队刷新，避免最后一次变更丢失。

扫描范围由事件类型决定：

- `tasks/` 下能解析到具体任务目录的事件只调用 `refreshCachedTask()`，刷新该任务。
- `workspace/`、`.developer` 或无法解析到任务目录的 `tasks/` 事件会重扫对应仓库。
- Worker 冷启动、`POST /api/board/refresh` 和 `POST /api/board/refresh/start` 触发仓库级完整扫描；单任务和仓库级增量刷新复用 Worker 内存中的其他仓库结果。

无论本次文件扫描范围多大，`createBoard()` 都会把当前缓存中的全部仓库任务交给 `linkTaskGroups()` 重建跨仓库关系，再生成列表投影。因此监听刷新不是“每次全量重扫全部仓库”；除非同时处理缓存与跨仓库关系，也不要删掉这一步全局关系重建。

## 父子任务

关系来源包括明确 `parent`、`children` 和约定的 `meta.*Task`。仓库允许跨项目引用。冲突、缺失、自引用和循环会产生警告；关系无效时父任务停止继承子任务进度。

父任务只在子任务具备实现、检查等真实证据时汇总对应阶段，不凭空补齐父任务的规划阶段。

## 修改检查

- [ ] schema v12 新增基线、合入证据和 task ID 索引，旧依赖、归档、团队和 Git 表仍可打开，大于 v12 的版本仍被拒绝。
- [ ] v10/v11 -> v12 幂等补监听字段、基线和证据表；v6/v7/v8/v9 -> v12 顺序迁移成功；源版本备份可独立打开，旧数据保留和迁移失败回滚正确。
- [ ] 基线 taskSpace 已有同一稳定任务 ID 时，默认任务查询、计数、筛选和分页只返回基线副本；来源快照仍可显式读取。
- [ ] 扫描只把包含 `task.json` 的目录认作任务。
- [ ] 新证据文件已加入读取和缓存签名范围。
- [ ] standalone 缓存失效范围覆盖 workspace、关系和 Git 元数据影响；Team 只按 taskSpace revision 失效。
- [ ] E2E 计划/否定/完成三种语义均有测试。
- [ ] 输出结构不兼容时更新 `SCAN_SCHEMA_VERSION`。
- [ ] 列表摘要保留证据计数和 Design 有效性，但不泄漏完整依赖数组、事件或产物正文。
- [ ] 依赖创建/解除与事件同事务，所有失败场景不产生部分写入。
- [ ] 列表只返回风险摘要，详情才返回完整 `blockedBy`、`blocks`、原因、时长和开工、完成条件明细。
- [ ] 首次追踪只建立基线，不补造迁移前阶段事件。
- [ ] 身份冲突清除后不会从冲突快照补写虚假阶段变化。
- [ ] 删除或重命名任务后缓存能清理旧项。
- [ ] 移除项目时同一事务清理对应 `task_stage` 和执行扩展数据，且不会误删相似项目 ID 的记录。
- [ ] Team 快照投影只读取 `.trellis/tasks/**`，不依赖 `data/projects/**`、Git 子进程或 workspace。
- [ ] Team 每日数据库快照使用 `VACUUM INTO`，保留最近 7 份且备份失败不阻塞服务。
