# 实施报告：合并后任务归属与同步暂停纠正

## 结论

已在 `main` 完成核心实现：项目持久化固定基线分支；基线 Agent 只在遇到来源分支不同的任务时
读取一次 HEAD tree，并为已进入 HEAD 的任务生成 `tracked-in-head` 证据；服务端在不访问 Git 的
前提下接纳基线首份来源任务、拒绝来源 taskSpace 后续写入，并默认隐藏基线已接管的来源重复副本。

实现已通过 Web 生产构建、Rust 单测、Windows portable 构建、真实服务 API 和真实客户端 E2E。
`8ddea09` 对应 CI run `43535564677` 全部门禁成功；`v0.4.7` 正式构建 run
`43538753452` 成功并发布 portable ZIP 和 SHA256。

## 已实现

### 服务端

- SQLite schema 升到 v12：
  - `sync_project.baseline_branch`
  - `sync_task_merge_evidence`
  - `sync_task_space_file(task_space_id, task_id, deleted)` 索引
- 新项目首次 attach 的分支成为基线；旧 v11 项目按最早活动 taskSpace 回填基线。
- project 返回 `baselineBranch`，taskSpace 返回 `isBaseline`，Agent heartbeat 返回
  `baselineBranch`。
- `POST /changes` 支持可选 `mergeEvidence`，并将其纳入请求摘要和 pending 幂等重放。
- 基线首次接纳来源不同任务时校验并原子写入证据与审计；缺少、错字段或非基线声明均拒绝。
- 基线已有同一稳定任务 ID 后，来源 taskSpace 对同一任务的新增、修改、移动和删除返回
  `TASK_OWNED_BY_BASELINE`。
- 默认任务查询、计数、筛选和分页按项目内稳定任务 ID 隐藏来源旧副本；显式快照接口保留来源数据。
- 查询行增加 `sourceBranchName`。

### 桌面 Agent

- `AgentBinding` 持久化可选 `baselineBranch`；attach 和 heartbeat 更新该字段。
- 普通同分支任务继续直接同步，不读取 Git tree。
- 只有基线 binding 遇到来源不同的任务时读取当前完整 HEAD：
  - 每次候选判断先做轻量 `head_commit()`；
  - HEAD 未变复用进程内 HashSet；
  - HEAD 变化时才重新执行一次 `git ls-tree -r --name-only <HEAD> -- .trellis`。
- 精确命中 `<taskDir>/task.json` 后生成证据，并随批次上传。
- `PendingBatch` 持久化 `mergeEvidence`，重试时原样发送。
- 服务端返回 `TASK_OWNED_BY_BASELINE` 后，本进程把该 taskSpace/taskId 标记为基线所有，停止主动上传；
  binding 变化或进程重启后可重新确认。

### Web

- 类型增加 `baselineBranch`、`isBaseline`、`sourceBranchName`。
- 任务卡、团队视图、归档、注意力队列和任务详情在有效归属与来源不同时显示
  “分支 dev · 来源 dev1”；相同时不重复显示来源。
- 团队查询行归一化同时兼容 `sourceBranchName` 和 `source_branch_name`。
- `/api/board` 和 `/api/task` 也保留来源分支字段，避免缓存任务或直接详情打开时丢失来源信息。

## 设计修正

### 同分支普通任务不要求证据

证据只为“基线 taskSpace 首次接纳来源分支不同的任务”服务。普通同分支任务、基线已有同一稳定任务
ID 的后续上传都不生成或要求证据。这样不会给日常 watcher 增加无关 Git 成本。

### 稳定任务 ID 的去重方式

Team 扫描现有 `execution_task_key` 实际仍是 `<taskSpaceId>::<taskId>`，不能直接跨 taskSpace
比较。本次实现用第一个 `::` 之后的任务 ID 后缀作为项目内稳定身份：

- 去重仍依据 `execution_task_key`，而不是目录型 `task_key`；
- 不改变现有 Team 执行键的外部格式和命令校验；
- 证据表继续保存 `<projectId>::<taskId>`，查询按 `project_id + task_id` 关联来源展示。

## 服务端信任边界

服务端不 clone、fetch、ls-tree、merge-base，也不启动项目 Git/Python 子进程。`tracked-in-head`
是绑定基线 taskSpace 的已批准 Agent 对“指定任务目录的 `task.json` 存在于该完整 HEAD”的受信声明。
服务端只验证 active Agent、approved binding、分支、任务 ID、目录、受控路径、结构和证据一致性，
不能独立证明 Agent 没有伪造 HEAD 路径。需要独立验真时必须改为服务端 Git 镜像，超出本任务范围。

## 验证结果

聚焦回归通过：

```powershell
node --test apps/server/test/team-task-snapshot.test.js apps/server/test/team-task-index-v10.test.js apps/server/test/team-task-spaces.test.js apps/server/test/team-gitless-http.test.js apps/web/test/team-web.test.js
```

当前聚焦回归（含 `team-gitless-http.test.js`）结果：60 个测试全部通过。

此前已单独通过：

- `apps/server/test/database.test.js`：10/10
- `apps/server/test/plugin-store.test.js`：10/10
- `apps/server/test/team-task-spaces.test.js`：12/12
- `apps/server/test/team-gitless-http.test.js`：2/2
- `apps/server/test/team-task-snapshot.test.js`：18/18（最终聚焦回归）
- `apps/server/test/team-task-index-v10.test.js`：4/4（最终聚焦回归）
- `apps/server/test/team-agent-slot.test.js`：8/8（最终聚焦回归）

## 真实环境与 CI

- `npm run build` 通过，只有既有大 chunk 警告。
- GitHub Actions run `43535564677` 的 Node/Web 测试、Desktop bundle、Rust 单测、
  Windows portable 打包、SHA256、portable smoke test 和 launch smoke test 全部成功。
- 真实 Team 服务 schema 为 `12`，`integrity=ok`；5 个正式 binding 均在线监听。
- `mdp-backend-web` 的 17 个历史任务已生成 `tracked-in-head` 证据，来源分支保留。
- 未合入 `dev1` 探针没有上传，也没有生成证据；清理后关联恢复 ready。
- `/api/tasks/query` 对 `dev` 与 `feat/trellis-board` 的 95 个重叠稳定 ID 只返回基线副本。
- 真实归档页面显示“分支 dev · 来源 feat/trellis-board”。

## 残留风险

- `node --test apps/server/test/database-v10.test.js` 的迁移断言均通过，但在本机 Node `24.21.0`
  / Windows 上，v9 用例结束时 SQLite 的 `board.sqlite-wal` 句柄未在进程内立即释放，测试清理
  `fs.rmSync` 报 `EBUSY`。该问题发生在断言完成后的临时目录删除阶段，未影响迁移结果；Node
  `24.22.0` 才提供 `StatementSync.close()`，CI 全量门禁已通过。
- 真实数据中若 v11 项目最早活动 taskSpace 不是实际开发基线，迁移会选错；本任务不提供基线切换 UI。
- 基线 Agent 的 `tracked-in-head` 仍属于受信声明，不能防住被攻破或恶意的已批准 Agent。
- 已合入任务从基线快照删除后的归属回退语义不在本次范围内。
- ProjectRail 的全量任务扫描已消除，但 Team 状态、本地关联和 sidecar 仍有 3 秒状态轮询。
  真实客户端复测约 `5.99%`–`6.72%` 单核平均，未出现旧版约 `100%` 尖峰，但尚未达到 `<2%`。

## 文件变更

服务端：

- `apps/server/database.js`
- `apps/server/team/task-space-service.js`
- `apps/server/team/sync-agent-service.js`
- `apps/server/team/task-snapshot-service.js`
- `apps/server/team/task-space-index.js`
- 相关 `apps/server/test/database*.test.js`、`plugin-store.test.js`、
  `team-task-*.test.js`、`team-agent-slot.test.js`

桌面端：

- `apps/desktop/src-tauri/src/agent/store.rs`
- `apps/desktop/src-tauri/src/agent/protocol.rs`
- `apps/desktop/src-tauri/src/agent/onboarding.rs`
- `apps/desktop/src-tauri/src/agent/runtime.rs`
- `apps/desktop/src-tauri/src/agent/task_sync.rs`
- 相关测试构造器：`detach.rs`、`task_command.rs`

Web：

- `apps/web/src/api/board.ts`
- `apps/web/src/api/admin.ts`
- `apps/web/src/lib/team-client.js`
- `apps/web/src/features/board/task-view.ts`
- `apps/web/src/features/board/TaskCard.tsx`
- `apps/web/src/features/board/TeamView.tsx`
- `apps/web/src/features/board/ArchiveView.tsx`
- `apps/web/src/features/board/AttentionQueue.tsx`
- `apps/web/src/features/board/dialogs/TaskDetailDialog.tsx`
- `apps/web/test/team-web.test.js`

规范：

- `.trellis/spec/backend/task-ownership-and-conflict-idempotency.md`
- `.trellis/spec/backend/desktop-realtime-sync.md`
- `.trellis/spec/backend/architecture-and-runtime.md`
- `.trellis/spec/backend/scanning-and-persistence.md`
- `.trellis/spec/backend/http-and-filesystem.md`
- `.trellis/spec/backend/quality-guidelines.md`
- `.trellis/spec/frontend/rendering-and-state.md`

未触碰的其他用户改动：`.trellis/tasks/11-13-branch-retirement-lifecycle/` 和用户已暂存的
`11-13-optimize-task-sync-path-validation/e2e-report.md`。
