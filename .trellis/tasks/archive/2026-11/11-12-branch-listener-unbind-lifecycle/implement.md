# 实施计划

## 1. 前置约束

- 活跃任务：`.trellis/tasks/11-12-branch-listener-unbind-lifecycle`。
- 用户已批准实施，任务状态为 `in_progress`。
- `D:\wit\trellis-board` 保持 `main` 分支和其他任务的未提交改动，不在该工作区实施本任务。
- 早期实现工作区为 `D:\wit\trellis-board-branch-listener-unbind-lifecycle`，分支为
  `codex/branch-listener-unbind-lifecycle`，仅作为旧 Node sidecar 结构的迁移来源。
- 当前主分支已迁移为 monorepo + Rust/Tauri 桌面端，本任务在
  `D:\wit\trellis-board-branch-listener-unbind-integration` 的
  `codex/branch-listener-unbind-lifecycle-main` 分支重新集成，基线为 `main@87346c3`。
- 不执行回滚、格式化、`git reset --hard` 或 `git checkout --`。
- 开发期间不执行构建。所有功能、测试和规范修改完成后，再执行最终 Web/桌面 UI 构建。
- 本机无 Rust 工具链；Rust 编译和单测由 GitHub Actions 的 Windows 构建环境补验。

## 2. 变更范围

### 数据库与服务端

- `apps/server/database.js`
- `apps/server/team/sync-agent-service.js`
- `apps/server/team/task-space-service.js`
- `apps/server/team/gitless-board-service.js`
- `apps/server/team/task-command-service.js`
- `apps/server/team/http.js`
- `apps/server/test/database.test.js`
- `apps/server/test/database-v10.test.js`
- `apps/server/test/team-agent-slot.test.js`
- `apps/server/test/team-task-spaces.test.js`
- `apps/server/test/team-task-commands.test.js`
- `apps/server/test/team-gitless-http.test.js`
- `apps/server/test/team-static.test.js`

### Rust 桌面 Agent

- `apps/desktop/src-tauri/src/agent/detach.rs`（新增）
- `apps/desktop/src-tauri/src/agent/device.rs`
- `apps/desktop/src-tauri/src/agent/onboarding.rs`
- `apps/desktop/src-tauri/src/agent/protocol.rs`
- `apps/desktop/src-tauri/src/agent/runtime.rs`
- `apps/desktop/src-tauri/src/agent/store.rs`
- `apps/desktop/src-tauri/src/agent/task_command.rs`
- `apps/desktop/src-tauri/src/agent/task_sync.rs`
- `apps/desktop/src-tauri/src/agent_service.rs`
- `apps/desktop/src-tauri/src/main.rs`

### 桌面与 Web

- `apps/desktop/src-tauri/capabilities/board-local-association.json`
- `apps/desktop/src-tauri/permissions/desktop.toml`
- `apps/web/src/api/board.ts`
- `apps/web/src/components/layout/ProjectRail.tsx`
- `apps/web/src/features/board/dialogs/BranchListenersDialog.tsx`（新增）
- `apps/web/src/features/board/dialogs/CreateTaskDialog.tsx`
- `apps/web/src/features/board/dialogs/TaskDetailDialog.tsx`
- `apps/web/src/pages/board/BoardPage.tsx`
- `apps/web/src/lib/project-rail-association.js`
- `apps/web/src/lib/project-rail-association.d.ts`
- `apps/web/src/lib/team-client.js`
- `apps/web/src/lib/team-client.d.ts`
- `apps/web/test/project-rail-association.test.js`
- `apps/web/test/team-web.test.js`
- 与 ProjectRail 纯状态有关的现有测试文件

### 规范

- `.trellis/spec/backend/architecture-and-runtime.md`
- `.trellis/spec/backend/desktop-realtime-sync.md`
- `.trellis/spec/backend/http-and-filesystem.md`
- `.trellis/spec/backend/quality-guidelines.md`
- `.trellis/spec/backend/scanning-and-persistence.md`
- `.trellis/spec/frontend/rendering-and-state.md`

## 3. 实施顺序

### Step 1：Schema v11 与迁移

- [x] 将 `DATABASE_SCHEMA_VERSION` 升到 `11`。
- [x] 给 `sync_agent_binding` 增加 `is_listening`、`listener_reported_at`、`last_listener_at` 和监听查询索引。
- [x] 用 `PRAGMA table_info` + `ALTER TABLE` 实现 v10 到 v11 的幂等补列，保证新库和旧库走同一最终结构。
- [x] 将支持迁移版本范围扩展到 v11，继续保留 v6-v10 升级和 `VACUUM INTO` 备份。
- [x] 更新所有固定断言 schema 版本的测试，不把 v11 新列泄漏成旧表迁移依赖。
- [x] 明确 v11 数据库只能由新程序打开；回滚使用迁移前备份。

验证：

```powershell
node --test apps/server/test/database.test.js apps/server/test/database-v10.test.js apps/server/test/plugin-store.test.js
```

验收重点：

- v10 数据库升级后旧 binding 全部保留，默认 `is_listening=0`。
- 重复打开不重复加列，不丢失已有监听时间。
- 新建 v11 库和 v10 升级库的表结构一致。

### Step 2：心跳协议与真实监听集合

- [x] `sync-agent-service.heartbeat()` 接受 `listenerReportVersion: 1` 和最多 64 个 `listeningTaskSpaceIds`。
- [x] 新协议心跳在同一事务中更新该 Agent 全部 approved binding 的 `listener_reported_at`，按集合更新 `is_listening`，只对监听项推进 `last_listener_at`。
- [x] 旧客户端缺少字段时保持原 binding 监听字段不变。
- [x] 未知 taskSpace、非当前 Agent binding、非法或重复 ID 整次拒绝，不产生部分监听更新。
- [x] 修正 Rust `TaskSync` 的 binding 刷新路径，让每次准备心跳时都校验真实 Git 分支。
- [x] 心跳集合来源必须是运行时实际激活的 `TaskSync` binding，并排除 `detachPending`、非 approved、分支不匹配和已撤销 binding。
- [x] 集合未变化时只刷新状态，不重建 watcher、不重复 pull；集合变化时立即重建 watcher。
- [x] 修复心跳返回空 bindings 或全部 binding 被撤销时本地监听集合未更新的问题。
- [x] `_heartbeatPayload()` 发送空 `listeningTaskSpaceIds` 时仍是完整权威报告，不能省略字段。

验证：

```powershell
node --test apps/server/test/team-agent-slot.test.js apps/server/test/team-task-spaces.test.js
```

测试必须覆盖：

- 单 binding 从分支 B 切到 A 后，心跳不再上报 B。
- 多 worktree 的两个真实分支可同时上报。
- 同一仓库存在多个脏 binding 时只有真实分支被激活。
- 新客户端空数组清空该 Agent 的全部监听标记。
- 旧客户端不上报时不会刷新 `listener_reported_at`。
- 服务端超时阈值后 `is_listening=1` 不再计为在线。

### Step 3：监听状态投影和详情

- [x] 在 taskSpace 列表查询中批量计算 `approvedBindingCount`、`onlineListenerCount`、`listenerReportedBindingCount`、`lastListenerAt` 和 `listenerState`。
- [x] 状态优先级固定为 `disabled -> online -> unassociated -> unknown_legacy -> inactive`。
- [x] `onlineAgentForTaskSpace()`、项目 Agent 汇总和负责人候选的 `online` 全部改用真实监听判断。
- [x] `/api/team/status` 返回每个 taskSpace 的监听聚合；项目级 online 只汇总真实监听。
- [x] 新增 `GET /api/task-spaces/:taskSpaceId/listeners`，只允许 `canManage` 用户，返回脱敏客户端详情。
- [x] 不返回 token、凭据、`localRepoKey`、本地绝对路径或跨团队用户信息。

验证：

```powershell
node --test apps/server/test/team-task-spaces.test.js apps/server/test/team-gitless-http.test.js
```

测试必须覆盖：

- 三个客户端得到 `3/3 online`。
- 一个切换分支得到 `2/3`，一个解绑得到 `2/2`。
- 全部切换得到 `0/3 inactive`。
- 全部解绑得到 `0/0 unassociated`。
- v10 升级后的 approved binding 得到 `unknown_legacy`。
- disabled taskSpace 始终优先返回 `disabled`。
- 普通成员读取详情返回 403，项目负责人/团队管理员可读取。

### Step 4：服务端权威解绑

- [x] Rust `ApiClient` 通过现有请求封装调用 detach 接口，提交 `localRepoKey`。
- [x] `task-space-service` 增加 Agent detach 方法，只允许当前认证 Agent 操作自己的 binding。
- [x] HTTP 增加 `POST /api/agent/task-spaces/:taskSpaceId/detach`。
- [x] 事务内完成 binding revoked、`is_listening=0`、进行中命令取消、服务端 cursor 删除和一次性审计。
- [x] binding 不存在或已 revoked 返回幂等成功；非重试型 localRepoKey 不匹配返回明确冲突。
- [x] 不物理删除 binding、taskSpace、任务、冲突或审计。
- [x] 更新 `apps/server/test/team-static.test.js`：删除“不得存在 detachAgent”的旧断言，替换为真实路由与权限断言。

验证：

```powershell
node --test apps/server/test/team-task-spaces.test.js apps/server/test/team-task-commands.test.js apps/server/test/team-gitless-http.test.js apps/server/test/team-static.test.js
```

测试必须覆盖：

- 只撤销目标 Agent，不影响同分支其他客户端。
- 已投递/运行中命令被取消，后续不再投递。
- cursor 被清理，历史任务和审计保留。
- 重复调用幂等且只产生一次审计。
- 任意事务步骤失败时 binding、命令、cursor 和审计全部回滚。

### Step 5：Rust Agent 本地待解绑

- [x] 新增 `apps/desktop/src-tauri/src/agent/detach.rs`，作为运行时与桌面命令共用的本地解绑生命周期。
- [x] 先原子写入 `detachPending=true`，再调用服务端；运行时立即从监听集合移除该 binding。
- [x] 成功后删除本地 binding 和 `live-cursors.json` 中对应 taskSpace 的全部 cursor/pending/deferred/conflict 状态。
- [x] 网络失败保留 `detachPending` 和本地数据，显示待确认；AgentRuntime 每个心跳周期重试。
- [x] 服务端 404 或已撤销可作为终态清理本地；仓库不匹配等不可重试错误保留状态并暴露原因。
- [x] `AgentBinding`、本地关联投影和状态输出增加 `detachPending`，但不把该字段上报为服务端 binding 状态。
- [x] 桌面命令与运行时内部重试统一走共享生命周期。

验证：

```powershell
npm test
```

测试必须覆盖：

- 服务端成功时本地 binding/cursor 被清理。
- 服务端失败时 binding 仍存在且 `detachPending=true`，但 watcher/upload/pull 均跳过。
- 下一次心跳重试成功后自动清理。
- 待解绑期间心跳的 `listeningTaskSpaceIds` 不包含该 taskSpace。
- 桌面命令不再只删除本地 binding 后提示用户去 Web 手动撤销。

### Step 6：Tauri 与项目栏快捷解绑

- [x] Tauri 新增 `detach_local_association(task_space_id)`，校验 Board 调用方和 ID 后调用 Rust 运行时。
- [x] 命令执行时先刷新监听集合，确保 watcher 立即停止；失败时仍保留 `detachPending` 并停止该分支同步。
- [x] 在 `board-local-association.json` 和 `desktop.toml` 增加最小权限项，禁止复用全局 shell 权限。
- [x] ProjectRail 在本地 approved 分支行增加“不再同步此分支”按钮和二次确认。
- [x] `detachPending` 时禁用重复点击并显示“服务端解绑待确认”。
- [x] 成功后刷新本地 associations、`/api/team/status` 和 Board；失败时只显示失败/待确认，不伪报成功。
- [x] 保持浏览器无 `__TAURI__` 时隐藏本地解绑入口。

验证：

```powershell
node --test apps/web/test/project-rail-association.test.js apps/web/test/team-web.test.js
```

权限和参数测试必须覆盖：

- 只接受合法 taskSpace ID。
- 只能由 Board 页面调用，控制窗口和外部页面不能调用。
- 无 Tauri 环境时浏览器不显示本地解绑入口。
- 服务端失败后本地保留待确认状态且仍不监听该分支。

### Step 7：监听状态 UI 与创建/改派门禁

- [x] 扩展前端 project/taskSpace 类型，接收监听聚合和 `listenerState`。
- [x] ProjectRail 分支行显示 `在线监听数 / 已关联数`，按五类状态使用 warning/destructive/muted 语义 token。
- [x] 项目父行聚合只用于展示，不改变分支独立判断。
- [x] `CreateTaskDialog` 在选中 taskSpace 无在线监听时禁用提交并显示“请先启动并绑定该分支的客户端”。
- [x] `TaskDetailDialog` 对当前任务 taskSpace 使用同一判断，禁用改派并显示原因。
- [x] 将按钮禁用判断抽成 `apps/web/src/lib/team-client.js` 的纯函数，Node 测试覆盖 online/offline/legacy/disabled。
- [x] `TaskCommandService` 在创建 operation 前增加零监听专用错误；目标用户离线继续使用 `AGENT_OFFLINE`。
- [x] 管理权限用户可打开监听详情；普通成员只看到聚合。

验证：

```powershell
node --test apps/web/test/team-web.test.js apps/server/test/team-task-commands.test.js apps/server/test/team-gitless-http.test.js
```

测试必须覆盖：

- `onlineListenerCount=0` 的 `inactive/unassociated/unknown_legacy` 均不可提交。
- `onlineListenerCount>0` 但目标负责人离线时保留 `AGENT_OFFLINE`。
- 直接调用创建/改派 API 且零监听时不写 `sync_task_command`。
- 监听数从 0 变为 1 后按钮下一次刷新恢复可用。

### Step 8：跨层回归与真实页面验收

- [x] 检查所有在线判断都使用真实监听条件，不能残留只看 `last_seen_at` 的查询。
- [x] 检查所有解绑入口都经过共享本地生命周期，不能直接 `filter` 删除 binding。
- [x] 检查所有状态分支都按 taskSpaceId 独立，不跨分支合并。
- [x] 检查旧客户端的 `unknown_legacy` 不会伪造在线。
- [x] 检查现有跨分支任务归属 WIP 的改动未被覆盖。

相关 Node 测试：

```powershell
npm test
```

真实页面验收：

- [x] 三个客户端都监听时显示 `3/3`。
      （隔离 DB fixture + 真实 Team 服务聚合 + 真实桌面 UI；不是三台真实客户端。）
- [x] 一个客户端切到其他分支后显示 `2/3`，binding 不消失。
      （隔离 DB fixture 模拟监听集合变化后，真实桌面 UI 显示 `2/3`；未验证真实 60 秒心跳窗口。）
- [x] 一个客户端点击“不再同步此分支”并确认，只影响该客户端。
      （真实桌面快捷操作撤销临时客户端 binding；同分支其他 fixture binding 保持 approved。）
- [ ] 断网解绑显示待确认，watcher 停止；恢复网络后自动完成。
- [x] 全部解绑后显示 `0/0` 红色“无客户端关联”，taskSpace 与审计保留。
      （三个 fixture binding 依次权威解绑后，真实桌面 UI 为 `0/0`；未在含真实任务的探针上复核历史内容。）
- [x] 零监听时创建按钮禁用；直接调用服务端也被拒绝且不新增操作项。
      （`TASK_SPACE_NO_ONLINE_LISTENER`，操作项前后均为 0。）
- [ ] 恢复一个监听客户端后再次确认创建按钮恢复可用。
- [ ] 浅色、深色、1440px、1024px、860px 无页面级横向溢出。

### Step 9：规范与最终一次性验证

- [x] 更新 `.trellis/spec/backend/desktop-realtime-sync.md`：监听子协议、schema v11、detach API、在线判断和兼容。
- [x] 更新 `.trellis/spec/backend/scanning-and-persistence.md`：v11 迁移、备份和失败回滚。
- [x] 更新 `.trellis/spec/frontend/rendering-and-state.md`：监听五态、快捷解绑和创建/改派门禁。
- [x] 对本任务文件运行 `oxfmt --check`，不执行全仓库格式化写入。
- [x] 最后运行桌面 Web UI 与 Web 构建；此前不执行 build。
- [x] 如有 Rust/Tauri 改动，最后只执行一次
  `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`。
      （本机没有 cargo；GitHub Actions `43378479104` 的 Windows `Rust unit tests` 已成功。）

最终构建：

```powershell
npm run build:desktop
npm run build
```

若 Rust/Tauri 有改动：

```powershell
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## 4. 验收映射

| 验收 | 主要验证 |
| --- | --- |
| AC1 | 三客户端心跳集合与真实分支刷新测试 |
| AC2 | `0/3 inactive` 聚合测试和真实页面验收 |
| AC3 | 单 Agent detach 只撤销自身 binding |
| AC4 | 全部 detach 后 `0/0 unassociated` |
| AC5 | 心跳超时和设备离线在线判断 |
| AC6 | detachPending 排除 watcher/upload/pull，服务端拒绝 revoked |
| AC7 | detach 后任务、冲突、审计和 taskSpace 行仍存在 |
| AC8 | 重复 detach 幂等和单次审计 |
| AC9 | 监听详情权限、脱敏字段和跨团队拒绝 |
| AC10 | ProjectRail 按 taskSpaceId 独立状态 |
| AC11 | 数据库、服务端和 Web Node 测试 |
| AC12 | 桌面解绑成功、失败待确认和 cursor 清理测试 |
| AC13 | 前端按钮与 API 操作项双重门禁 |
| AC14 | v10 升级 binding 为 `unknown_legacy` 且不可创建/改派 |
| AC15 | Rust 桌面解绑成功/失败待确认/重试闭环 |

## 5. 回滚点

- Schema：停止服务，恢复 `backups/board.sqlite.pre-v11.*`，然后回退应用版本。
- 服务端代码：只回退本任务相关路由、服务和测试；不得回退用户已有 WIP。
- Agent：回退心跳字段和本地解绑模块；已 revoked 的 binding 不自动恢复，避免误续传。
- 桌面：回退 Tauri 命令和 capability；本地 `detachPending` 记录可保留，由旧版本停止同步但需人工处理。
- Web：回退 ProjectRail 和按钮门禁不影响服务端状态事实。

## 6. 明确不做

- 不实现 taskSpace 全局停用/启用。
- 不物理删除 taskSpace 或 binding。
- 不自动删除 Git 分支和本地任务目录。
- 不把设备级在线等同为分支监听。
- 不为旧客户端伪造监听状态或放宽创建/改派。
