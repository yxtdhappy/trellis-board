# 项目接入幂等与 Windows 清理修复实施计划

## 1. 服务端错误契约

- [x] 在 `server/team/errors.js` 增加 `PROJECT_ALREADY_CONNECTED`。
- [x] 保持 `errorPayload()` 现有结构，使前端继续读取 `code`、`details` 和 `message`。

验证：检查错误常量可被 `projects.js` 和 `team-core.test.js` 导入。

## 2. 项目判重

- [x] 在 `server/team/projects.js` 增加按团队、远端身份和分支查询已有项目的内部函数。
- [x] 在 clone 前增加预检查。
- [x] 在写 `repositories` 前的事务内增加复检。
- [x] 统一返回 `409 PROJECT_ALREADY_CONNECTED`，详情只含项目元数据。
- [x] 保持 `repositoryId` 升级路径和现有 Agent/负责人/凭据校验顺序。

验证：第二次相同接入不应调用 `gitManager.cloneForTeam()`。

## 3. Windows 进程树终止

- [x] 将 `server/team/process.js` 的 `terminateTree()` 改为有界 Promise。
- [x] `runProcess()` 超时后等待进程树终止再 reject。
- [x] `server/plugins/supervisor.js` 优雅停止改为 `await terminateTree(...)`，强制终止使用
  显式 `void terminateTree(...)`。

验证：超时子进程被终止；错误消息保持“执行超过 `${timeoutMs}ms`”。

## 4. 工作副本清理与错误保留

- [x] `server/team/git-manager.js` 的 clone cleanup 使用 `maxRetries` 和 `retryDelay`。
- [x] clone cleanup 失败时保留并抛出原始错误，清理错误只写服务端日志。
- [x] `server/team/projects.js` 的事务失败 cleanup 同步使用删除重试。
- [x] 不把绝对路径或清理异常写入 API `details`。

验证：超时或工具链错误不会被 `EPERM` 覆盖；日志可同时定位两者。

## 5. 前端冲突反馈

- [x] 在 `web/src/hooks/useAdminProjects.ts` 识别 `PROJECT_ALREADY_CONNECTED`。
- [x] 冲突时刷新项目列表，再通过现有 `report()` 显示服务端消息。
- [x] 不打开批准对话框，不重置表单，不新增标签页。

验证：重复接入后列表仍只有一条，并显示明确提示。

## 6. 自动化测试

- [x] `tests/team-core.test.js`：顺序重复接入被拒绝，第二次 clone 次数为 0。
- [x] `tests/team-core.test.js`：并发接入最多一条数据库记录。
- [x] `tests/team-core.test.js`：同仓库不同分支允许接入。
- [x] `tests/team-credentials.test.js`：`runProcess()` 超时且子进程终止，返回原始超时错误。
- [ ] 如 Windows 文件锁可稳定模拟，增加清理重试测试；否则记录定向人工 E2E。

## 7. 现有孤儿目录检查

- [x] 只读查询 `repositories`、`team_project`、`audit_event`、任务索引和实时同步表。
- [x] 展示两个 UUID 的绝对路径和引用检查结论。
- [ ] 停止服务后再次确认路径仍位于 `TrellisBoard/server/projects/`。
- [ ] 取得再次授权后才执行删除；未授权则保留并记录为风险。

## 8. Partial clone 认证与懒取超时

- [x] `setSparsePaths()` 的 init、set、read-tree 都接收并传递 `auth`。
- [x] `applyTrellisSparse()` 和 `checkoutInitializationContext()` 传递 `auth`。
- [x] `cloneForTeam()` 的稀疏检出、远端 tree 读取和初始化后收敛复用同一 `auth`。
- [x] `readRemoteTree()` 的 `ls-tree` 与模板清单 `show` 使用同一 `auth`。
- [x] `ensureSparseTrellis()` 通过 `withProjectAuth()` 解析并使用项目凭据。
- [x] 稀疏检出失败消息包含经脱敏的 Git stderr/stdout。
- [x] 增加本地 partial clone、错误消息和 `ensureSparseTrellis()` 回归测试。
- [x] `LOCAL_TIMEOUT` 从 `30000ms` 增加到 `60000ms`，`sparse-checkout init` 使用该值。
- [x] `sparse-checkout set`、`read-tree`、checkout 使用 `REMOTE_TIMEOUT=210000ms`。
- [x] `merge` 和分叉恢复/初始化重试的 `rebase` 使用项目认证与
  `REMOTE_TIMEOUT=210000ms`。
- [x] clone 与远端 `ls-tree`、模板清单 `show` 使用 `210000ms`。
- [x] `PUSH_TIMEOUT=150000ms`、`PROBE_TIMEOUT=60000ms`、
  `TRELLIS_INIT_TIMEOUT=210000ms`、SSH 主机扫描 `45000ms`。
- [x] toolchain 预检 `60000ms`、团队 `task.py` `150000ms`、
  `runProcess` 默认值 `60000ms`。
- [x] 回归测试区分 init/set，并断言所有 lazy-fetch 步骤的 `timeoutMs`。

验证：

```powershell
node --test --test-name-pattern="partial clone|稀疏检出失败消息|ensureSparseTrellis" tests/team-sparse-onboarding.test.js
node --test tests/team-sparse-onboarding.test.js
```

## 9. 成功接入后的重置防护

- [x] 在 `web/src/lib/onboarding-probe.js` 增加无 DOM 依赖的 `canProbeBranch()` 守卫。
- [x] `OnboardingTab.changeBranch()` 只在分支和远端 URL 均非空时自动探测。
- [x] 保留用户显式点击“识别远端”时的空 URL 提示。
- [x] 增加 `tests/onboarding-probe.test.js`，覆盖空值、空白和有效组合。

验证：

```powershell
node --test tests/onboarding-probe.test.js
```

## 10. 定时刷新错误诊断

- [x] 增加 `server/team/error-diagnostics.js` 的 `diagnosticError()` 和 `errorSummary()`。
- [x] scheduler catch 记录 `name/code/status/message/details`，并保留兼容字段 `error`。
- [x] 非 TeamError 记录脱敏后的 stack/cause。
- [x] `refreshProject()` 的 fetch、工具链和扫描失败使用 `code: message` 摘要写入 `last_error`。
- [x] 增加 `tests/team-error-diagnostics.test.js`，覆盖结构化日志、摘要和脱敏。
- [x] 不向真实数据库强制写诊断，也不为验证本次增强而重启服务。

验证：

```powershell
node --test tests/team-error-diagnostics.test.js
```

## 11. 最终验证

在全部代码和测试修改完成后执行一次：

```powershell
node --test tests/onboarding-probe.test.js
node --test tests/team-error-diagnostics.test.js
node --test tests/team-core.test.js
node --check server/team/error-diagnostics.js
node --check server/team/http.js
node --check server/team/projects.js
npm --prefix web run lint
cd web
./node_modules/.bin/tsc.cmd -b
```

浏览器 E2E 由主流程在服务重启后完成：

1. 使用 `mdp-backend-service` 接入一次。
2. 再次提交相同团队、远端、分支，确认 409 和列表刷新。
3. 选择同一仓库不同分支，确认仍可接入。
4. 模拟/等待本地 Git 超时，确认前端错误不是 `INTERNAL_ERROR`，且失败 UUID 目录被清理或日志明确记录清理失败。
5. 成功接入后确认审批内容出现，右上角不再出现“请先填写 Git 远端 URL”。

## Risky Files

- `server/team/projects.js`
- `server/team/process.js`
- `server/team/git-manager.js`
- `server/plugins/supervisor.js`
- `web/src/hooks/useAdminProjects.ts`
- `tests/team-core.test.js`
- `tests/team-credentials.test.js`
- `tests/team-sparse-onboarding.test.js`

## Rollback Points

- 判重逻辑可单独回滚，不影响进程清理修复。
- Promise 化 `terminateTree()` 可单独回滚，但必须同时恢复 supervisor 调用形式。
- 不涉及数据库迁移，无 schema 回滚。

## Start Gate

- [x] 用户明确批准最新规划摘要。
- [x] `implement.jsonl` 与 `check.jsonl` 含真实规格条目。
- [x] 设计、实施计划与 PRD 一致。
