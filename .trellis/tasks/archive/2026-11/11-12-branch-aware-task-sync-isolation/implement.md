# 同一仓库跨分支任务串写实施计划

## 1. 绑定替换

- [x] 在 `server/team/task-space-service.js` 的 attach 事务中撤销同 Agent、同 `local_repo_key` 的旧 binding。
- [x] 取消旧 binding 的 pending/delivered/running 命令，并追加替换审计。
- [x] attach 响应增加 `replacedBindings`，保持旧字段不变。
- [x] 在 `agent/project-onboarding.js` 中按 `taskSpaceId` 和 `localRepoKey` 双重替换本地 binding。
- [x] 在 `agent/config-store.js` 中对新写入执行单仓库单 binding 校验，同时允许读取历史双绑定。
- [x] 在 `agent/task-snapshot-sync.js` 的 binding 注册阶段按真实分支消歧，阻止旧配置继续双 watcher。

验证：

```powershell
node --test tests/team-task-spaces.test.js
node --test agent/test/project-onboarding.test.js
node --test agent/test/task-snapshot-sync.test.js
```

## 2. 分支门禁

- [x] 在 `agent/git-sync.js` 增加复用现有 Git 校验能力的 `assertRepositoryBranch()`。
- [x] 在任务快照 pull、upload、冲突覆盖、延后补同步和 pending retry 的实际读写边界执行门禁。
- [x] 分支不匹配时更新 binding health，发出控制事件，并保持 cursor、pending 和任务文件不变。
- [x] 分支恢复后重新拉取并清除错误状态。
- [x] 上传批次携带 `observedBranchName`。
- [x] 服务端 HTTP 层强制上报，并对 taskSpace/binding 分支做二次校验。

验证：

```powershell
node --test agent/test/git-sync.test.js
node --test agent/test/task-snapshot-sync.test.js
node --test tests/team-task-snapshot.test.js
node --test tests/desktop-realtime-apply.test.js
```

必须覆盖：

- 错分支上传不上传、不推进 cursor。
- 错分支 pull 不写本地目录。
- pending retry 和 deferred sync 同样拒绝。
- `task.changed` 事件触发时仍拒绝。
- 切回绑定分支后恢复。
- 服务端拒绝 observed branch 不一致或缺失。

## 3. 桌面交互

- [x] 接入向导读取现有本地关联，按规范化 repo path 找出同仓库旧绑定。
- [x] 展示旧分支、新分支和“不删除旧任务空间”的提示。
- [x] 用户确认后调用替换关联，不接受静默替换。
- [x] ProjectRail 对 `BRANCH_MISMATCH` 显示“分支不一致，已暂停同步”和实际/期望分支。
- [x] 关联成功后沿用现有 `sidecar::restart()`，旧 watcher 随旧进程退出。

验证：

```powershell
node --test tests/desktop-association.test.js
npm --prefix web run build
```

真实 Tauri 验收覆盖：同一仓库旧分支关联、切换 Git 分支、重新接入、确认替换、旧分支 watcher 停止、新分支同步恢复。

## 4. 存量清理工具

- [x] 新增 `scripts/task-space-duplicate-cleanup.js`，默认只读 dry-run。
- [x] 按稳定 task ID + relative dir 识别重复任务。
- [x] 输出内容差异、来源和拟删除清单。
- [x] `--apply` 前停止服务检查、数据库备份和事务写 tombstone/audit/revision/index。
- [x] 增加临时数据库夹具测试，证明只删除指定旧 taskSpace 的重复目录。
- [x] 对真实库执行 dry-run，结果记录在 `cleanup-dry-run.md`；未执行 `--apply`。

验证：

```powershell
node --test tests/task-space-duplicate-cleanup.test.js
node scripts/task-space-duplicate-cleanup.js --database <db> --project <id> --remove-task-space <old> --keep-task-space <new>
```

本任务不自动执行真库 `--apply`；dry-run 结果确认后再单独授权。

## 5. 全量回归

- [x] 更新 `.trellis/spec/backend/desktop-realtime-sync.md`，记录单仓库单 binding、observed branch 和替换语义。
- [x] 更新 README 和桌面说明，明确多分支必须使用多 worktree。
- [x] 执行相关 Node 测试。
- [x] 最后执行一次完整验证，不在每个小阶段重复构建。

```powershell
npm test
npm run test:plugins
npm --prefix web run build
```

## 6. 高风险点与回滚

- 高风险文件：`agent/config-store.js`、`agent/project-onboarding.js`、`agent/task-snapshot-sync.js`、`server/team/task-space-service.js`、`server/team/task-snapshot-service.js`。
- 工作区内已有 4 个未跟踪任务目录，只修改本任务目录和直接相关文件，不触碰无关改动。
- 服务端 attach 必须事务化；不得先单独撤销旧 binding 再做新 binding 写入。
- 本地替换必须先得到服务端成功结果，再写 config；失败重试依赖 attach 幂等。
- 存量清理只在用户审查 dry-run 后执行，执行前必须取得数据库快照。

## 7. 完成门禁

- [x] 代码级验收项已有自动化证据；真实 Tauri/安装包验收仍待重启后执行。
- [x] 当前重复任务 dry-run 已确认，共 6 个任务、33 个文件，其中 1 个任务有内容差异。
- [x] 代码没有重新引入同仓库双 watcher。
- [x] 分支不匹配路径没有部分写入。
- [x] 用户明确批准实施后，才执行 `task.py start`。
