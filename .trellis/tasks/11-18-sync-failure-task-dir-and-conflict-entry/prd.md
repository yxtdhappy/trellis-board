# 任务同步失败定位与冲突待处理入口（含按归属同步与手动下载）

## 背景（已纠正的诊断）

弹窗「任务同步失败 / 只能读取本人任务内容」（trellis-board / main，taskSpace `a8d34d0e-…`）与项目栏 `mdp-backend-web`「已关联 · 2 个冲突待处理」是两个独立问题，实测数据如下。

**403 的真实来源不是“判给 yhj”。** 服务端 `snapshot` 的 38 条 controls 实测：

| 任务 | 服务端 assignee | state | relativeDir |
| --- | --- | --- | --- |
| `11-17-fix-archive-filter-listener-dev-id` | `567875d6…`（本机用户） | archived | `.trellis/tasks/archive/2026-11/…` |
| `11-17-in-window-task-sync-dialog` | `567875d6…`（本机用户） | archived | `.trellis/tasks/archive/2026-11/…` |
| `11-17-desktop-log-timestamp-format` | `567875d6…` | claimed | `.trellis/tasks/11-17-desktop-log-timestamp-format` |
| `11-17-fix-cross-branch-pending-blocking`、`11-17-multi-client-task-sync-control-plane` | 无 control（他人） | — | — |

`assertReadable`（`packages/server/team/task-control-service.js:802-833`）按**活跃路径**查 `sync_task`，行已改成归档路径 → 查不到 → 回落到 legacy `sync_task_space_file` 旧活行 → 抛 `403「只能读取本人任务内容」`（文案误导，实际是“服务端已归档”）。`11-17-unify-web-type-scale` 等返回 404 的目录没有 legacy 活行。

**本地重复副本是客户端造成的。** `.trellis/tasks/11-17-in-window-task-sync-dialog`、`11-17-fix-archive-filter-listener-dev-id`、`11-17-archive-local-snapshot-read` 三个活跃目录与 `.trellis/tasks/archive/2026-11/` 下同名目录**同时存在**，且 `git status` 显示三个活跃目录都是 untracked（客户端 materialize 产物，不是 Git 内容）。服务端 `11-18-archive-purge-active-rows`（`f055129`）只清 `sync_task_space_file` 活跃行，不碰本地文件系统，所以本机重复副本仍在、每轮 pull 继续 403。

**两个 mdp 冲突不会随服务端更新消失。** 实测 `GET /api/agent/task-spaces/5efbba95-…/conflicts` 仍返回 `workflow-import-export`、`project-permission-detail-fields` 两条 `pending`（2026-11-17T03:19 创建，任务目录已 404）。仓库代码中归档路径（`reconcileProjection` 的 `archived = 1` 分支）与 `purgeArchivedTaskFiles` 都不修改 `sync_conflict`，`listConflicts`（`packages/server/team/task-snapshot-service.js:1203`）也不过滤归档任务 → 更新服务端后冲突仍挂着。

## 目标

1. **同步失败可定位**：目录级失败在日志与 `task_sync_error` 事件/弹窗中带任务目录与错误码。
2. **按归属同步**：下拉方向只同步指派给自己的任务（服务端 `visibleTaskIds` 已实现，需保持）；上传方向只上传属于自己的本地任务，他人任务目录不再尝试上传、不再中断整次同步、不再弹“归属复核”。
3. **服务端语义纠正**：已归档任务按活跃路径读取返回 `409 TASK_ARCHIVED` 而非误导性 403；本地残留的活跃重复副本在“归档目录已存在且本地无未同步改动”时被清理。
4. **手动下载他人任务**：看板任务卡区分「已在本机 / 未下载到本机」，未下载的提供「下载到本机」按钮，下载为只读副本（不参与上传）。
5. **冲突有待处理入口**：项目栏「N 个冲突待处理」可点击重新拉取冲突并打开弹窗，服务端已消失的冲突被清理；服务端归档任务时同事务收敛 pending 冲突。

## 非目标

- 不实现跨用户任务接管（只读副本需要接管时走既有 `set_task_ownership` 流程）。
- 不做冲突自动合并；不改变“只有负责人可写任务”的权限模型。
- 不重构 `ControlHub`（仍为内存队列）。
- 不改 `sync_*` 表结构。

## 验收标准

1. trellis-board 增量同步：5 个脏目录（2 个“服务端已归档 + 本地重复副本”、1 个他人任务归档目录、2 个他人活跃任务）不再让 pull 失败，revision 正常前进；日志记录 `跳过` 与 `清理残留活跃副本`，不再出现「只能读取本人任务内容」。
2. 目录级失败（非 403/409 的 5xx、读取失败等）弹窗显示任务目录 + 项目/分支 + 错误码，`desktop.log` WARN 行含 `taskDir`。
3. 本地残留的活跃重复副本：归档目录存在且无未同步改动 → 被清理；有未同步改动 → 保留并提示（不静默删除）。
4. 看板任务卡：本机已存在的任务显示「已在本机」；未下载的显示「下载到本机」，点击后文件落到 `.trellis/tasks/<dir>`，标记只读、不参与上传，卡片状态变为「已在本机（只读）」。
5. 项目栏「2 个冲突待处理」可点击 → 打开同步确认弹窗列出冲突；已归档任务对应冲突被服务端收敛后，项目栏状态消失。
6. 服务端归档一个存在 pending 冲突的任务后：`GET /conflicts` 不再返回该冲突，`sync_conflict.status='resolved'`。
7. 回归：`yarn test`（node --test）、desktop `cargo test`、web `tsc -b` 全绿。

## 约束

- 遵循 `.trellis/spec/backend/desktop-realtime-sync.md`、`task-ownership-and-conflict-idempotency.md`、`desktop-task-path-resolution.md`、`guides/cross-layer-thinking-guide.md`（“目录名即任务身份”）。
- cursor（含新增只读集合）读改写必须在 cursor 锁内单次完成；本地已删除/移动目录不得残留状态。
- 新 agent 接口只读：不得赋予非负责人写权限，不得返回文件内容以外的敏感字段。
- 弹窗/看板沿用 shadcn + Base UI，固定 header/footer + 单一 `DialogBody` 滚动外壳。
