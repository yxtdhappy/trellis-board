# 项目接入幂等与 Windows 清理修复设计

## Architecture And Boundaries

本次修改保持在现有边界内：

- HTTP 路由不新增。
- 项目接入业务集中在 `server/team/projects.js`。
- Git 子进程生命周期集中在 `server/team/process.js` 和 `server/team/git-manager.js`。
- 前端冲突处理保持在 `web/src/hooks/useAdminProjects.ts`。
- 不修改数据库 schema，不新增迁移。

## Project Identity

项目身份键为：

```text
team_id + remote_identity_hash + sync_branch
```

`remote_identity_hash` 已由 `normalizeGitRemote()` 生成，能够把同一仓库的 SSH/HTTPS 表达归一。`sync_branch` 使用已验证的共享分支，因此同一仓库不同分支可以并存。

新增 `PROJECT_ALREADY_CONNECTED`：

```json
{
  "error": "项目 xxx 已在当前团队接入分支 dev",
  "code": "PROJECT_ALREADY_CONNECTED",
  "details": {
    "projectId": "<existing repository id>",
    "projectName": "<existing name>",
    "syncBranch": "dev",
    "syncStatus": "current"
  }
}
```

错误中不包含本地工作目录路径。

## Server Data Flow

### First Check

在远端和目标分支通过校验后、生成 UUID 和 clone 前执行：

```sql
SELECT p.repository_id, p.sync_branch, p.sync_status, r.name
FROM team_project p
JOIN repositories r ON r.id = p.repository_id
WHERE p.team_id = ?
  AND p.remote_identity_hash = ?
  AND p.sync_branch = ?
ORDER BY p.created_at, p.repository_id
LIMIT 1
```

命中时直接抛出 `409 PROJECT_ALREADY_CONNECTED`，避免第二次 clone。

### Second Check

clone、工具链检查和 Agent 初始化成功后，在现有 `withTransaction(db, ...)` 中、写 `repositories` 之前再次执行同一查询。

`BEGIN IMMEDIATE` 串行化写事务，因此：

- 并发请求可以同时 clone。
- 只允许第一个事务创建项目记录。
- 后续事务发现冲突并回滚。
- 调用方 catch 清理本次 UUID 工作副本。

### Existing Repository Upgrade

`repositoryId` 显式升级路径继续保留。已有项目检查先于新 UUID 生成，失败信息由新的统一冲突错误提供；不会改变“已有本地仓库升级为团队项目”的有效路径。

### Partial Clone Authentication Continuity

`cloneForTeam()` 使用 `git clone --filter=blob:none --no-checkout`，仓库是 promisor clone。
后续 `sparse-checkout` 与 `read-tree` 可能为了 materialize 缺失 blob 而访问 origin；这些命令
必须与初始 clone 共用同一个 `withGitAuth()` 生命周期。

认证传递签名：

```text
setSparsePaths(cwd, paths, { auth })
applyTrellisSparse(cwd, { requireTrellis, auth })
checkoutInitializationContext(cwd, { auth })
readRemoteTree(cwd, { auth })
```

`cloneForTeam()` 内所有稀疏收敛、初始化上下文检出和 `readRemoteTree()` 调用都传同一个 `auth`：

- 初始 clone、分支 checkout、初始化 push 继续使用该认证。
- `readRemoteTree()` 的 `ls-tree` 和模板清单 `git show` 使用该认证，避免懒取 blob 时回落为交互式提示。
- 初始化完成并 push 后再次收敛工作副本时仍使用该认证。

`ensureSparseTrellis(project)` 先完成本地 clean/branch 检查，再用
`withProjectAuth(project, ...)` 解析项目绑定的凭据，并将得到的 `auth` 传给
`applyTrellisSparse()`。这样由后续请求触发、首次 materialize `.trellis/**` 的场景也不会丢失认证。

稀疏检出错误在 `TeamError` 消息中附带 `stderr || stdout || 'Git 返回非零退出码'`，最多 2048
字节，并传入当前 `auth.redact`。消息可以定位 Git 失败原因，但不能包含原始 Token、私钥或口令。

### Promisor Lazy Fetch Timeout

partial clone 的认证缺失和网络耗时是两个独立根因：

- GitHub 现象是后续命令未继承 askpass，Git 尝试交互式读取用户名。
- SSH 现象是认证存在，但 `read-tree`/`sparse-checkout set` 需要懒取缺失对象，真实耗时接近或
  超过 30 秒。

因此不能继续把所有 sparse 子命令都视为本地操作。超时边界如下：

| Git 操作 | 超时 |
| --- | --- |
| `sparse-checkout init --no-cone` | `LOCAL_TIMEOUT=60000ms` |
| `sparse-checkout set` | `REMOTE_TIMEOUT=210000ms` |
| `read-tree -mu HEAD` | `REMOTE_TIMEOUT=210000ms` |
| 初始化前后及共享分支 `checkout` | `REMOTE_TIMEOUT=210000ms` |
| `merge --ff-only FETCH_HEAD` | `REMOTE_TIMEOUT=210000ms` |
| 分叉恢复及初始化推送重试的 `rebase FETCH_HEAD` | `REMOTE_TIMEOUT=210000ms` |
| 远端 `ls-tree` | `REMOTE_TIMEOUT=210000ms` |
| 模板清单 `git show HEAD:.trellis/.template-hashes.json` | `REMOTE_TIMEOUT=210000ms` |

其他操作执行超时同步在各自原值上增加 30 秒：

| 操作 | 超时 |
| --- | ---: |
| `LOCAL_TIMEOUT` | `60000ms` |
| `REMOTE_TIMEOUT` | `210000ms` |
| `PUSH_TIMEOUT` | `150000ms` |
| `PROBE_TIMEOUT` | `60000ms` |
| `TRELLIS_INIT_TIMEOUT` | `210000ms` |
| SSH 主机扫描 | `45000ms` |
| toolchain 预检 | `60000ms` |
| 团队 `task.py` | `150000ms` |
| `runProcess` 默认值 | `60000ms` |

`PROBE_WINDOW_MS=60s`、`SSH_TRUST_TTL_MS=5min`、Windows taskkill fallback 2 秒和
HTTP 关闭等待 5 秒不是操作执行超时，保持不变。

`readRemoteTree()` 构造统一的 `remoteOptions = { timeoutMs: REMOTE_TIMEOUT, ...options }`，
并同时传给 `ls-tree` 与 `readRemoteManifestPaths()`，避免 tree 与清单读取使用不同超时。

`ensureSparseTrellis()`、`fetchProject()`、`fetchAndFastForward()`、`pushCommit()` 和
`remoteContainsCommit()` 统一经过 `remoteException()` 映射。已有 `TeamError` 原样保留，
`runProcess()` 的原始超时错误映射为 `504 GIT_REMOTE_TIMEOUT`，不能退化为 HTTP 500。

## Windows Timeout Lifecycle

### terminateTree

`terminateTree(child)` 改为返回 Promise：

- Windows：等待 `taskkill /pid <pid> /T /F` 的 `close` 或 `error`。
- `taskkill` 启动失败时回退 `child.kill()`。
- 最多等待约 2 秒；超时后回退 `child.kill()` 并 resolve，避免 HTTP 请求永久悬挂。
- 非 Windows：发送 `SIGKILL` 后立即 resolve。

`server/plugins/supervisor.js` 的优雅停止流程会 `await terminateTree(...)` 后再等待退出；
强制 `kill()` 保持 fire-and-forget，并显式使用 `void terminateTree(...)`。

### runProcess Timeout

超时回调先标记 `settled`，等待 `terminateTree()` 完成后 reject：

```text
timeout reached
  -> settled = true
  -> await/await-equivalent terminateTree
  -> reject(original timeout error)
```

子进程后续 close 事件因 `settled` 已为 true，不会覆盖超时错误。

## Clone Cleanup

### Retry

项目工作副本清理使用：

```js
fs.rmSync(target, {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
})
```

同时更新：

- `git-manager.js` 中 `cloneForTeam()` 的 catch。
- `projects.js` 中写数据库失败后的 UUID 目录清理。

### Error Preservation

`cloneForTeam()` catch 中先保存原始异常，再执行清理：

- 清理成功：按原逻辑 `remoteException(originalError, "克隆项目")`。
- 清理失败：记录原始错误和清理错误，但仍抛原始错误映射。

服务端日志只记录本地诊断信息，不将绝对路径写入 API 响应。

## Frontend Contract

`useAdminProjects.connectProject()` 继续使用现有 `report()` 显示错误，但识别：

```ts
error.code === "PROJECT_ALREADY_CONNECTED"
```

命中时先 `await reloadProjects(true)`，再显示错误。这样即使另一个标签页或其他管理员已经接入，当前页面也会显示真实项目列表。

不打开新标签页，不自动打开批准对话框，不改变表单状态。

## Onboarding Reset Contract

受控分支 Select 在项目接入成功、表单重置、远端或凭据变化时都可能回调
`changeBranch('')`。回调必须区分“用户选择了一个仍可探测的分支”和“内部状态被清空”：

- `canProbeBranch(branch, remoteUrl)` 对两个参数都先转为字符串并 `trim()`，只有均非空才返回
  `true`。
- `changeBranch()` 先清空旧 Agent 状态并写入当前分支，再通过上述守卫决定是否自动探测。
- 守卫失败时直接返回，不调用 `runProbe()`，因此不会出现“请先填写 Git 远端 URL”的伪 toast。
- 用户显式点击“识别远端”仍直接调用 `runProbe()`；该入口对空 URL 的错误提示保持不变。
- 守卫放在无 DOM 依赖的 `web/src/lib/onboarding-probe.js`，由现有 Node 测试覆盖，不引入
  React 渲染测试框架。

## Operational Error Diagnostics

定时刷新由 `createRefreshScheduler()` 的 catch 边界统一消费。日志不能只写通用
`error.message`，否则真实失败会被压缩成“同步项目失败”。诊断契约如下：

```js
diagnosticError(error)
// { name, code, status, message, details, stack?, cause? }
```

- `TeamError` 保留 `name/code/status/message/details`，不输出 stack。
- 非 `TeamError` 额外输出脱敏后的 `stack` 和 `cause`。
- 敏感键、Token、私钥块、Authorization/Cookie、文件 URL 和绝对路径统一脱敏。
- scheduler 继续写兼容字段 `error: diagnostic.message`，不改既有日志消费方。

项目业务状态使用较短的 `errorSummary(error, fallback)`：

- 格式为 `code: message`；message 已包含相同 code 前缀时不重复。
- 最大 1000 个字符，继续执行同一套秘密和路径脱敏。
- `refreshProject()` 的 fetch、工具链检查和扫描失败均把该摘要写入 `last_error`。

诊断增强只对后续真实失败生效。当前已经恢复的项目不强制写库，也不要求为验证日志而重启服务。

## Compatibility And Migration

- 不新增 SQLite schema 版本。
- 不修改已有 API 成功响应。
- 新增一个团队管理错误码。
- `terminateTree()` 从 fire-and-forget 变为 Promise；更新所有调用方。
- 同仓库多分支接入保持允许。

## Operational Notes

现有两个孤儿目录不纳入自动清理：

- `680ef8f1-684d-4bb3-b5d3-2d3f8c73c95a`
- `ce5928e3-901c-4fca-ab24-48e62b12ef43`

代码完成后只执行引用检查。实际删除必须停止服务并再次取得用户明确授权。

## Test Strategy

- 顺序重复接入：第二次在网络 clone 前返回 409。
- 并发接入：两个请求最多一个成功，另一个冲突。
- 同仓库不同分支：两条均可成功。
- 进程超时：超时错误不是清理错误，且子进程被终止。
- 前端错误：429/409/504 等 `TeamError` 继续走统一 report，不出现未捕获异常。
- Windows 文件锁：使用真实服务或 Windows 定向测试验证删除重试；无法稳定自动化时记录人工 E2E 证据。
- partial clone 认证：通过 `runProcessImpl` 测试注入记录每个 Git 子进程的 env，断言受保护命令都带
  `GIT_ASKPASS_REQUIRE=force`、askpass 路径和测试凭据；初始化与 `ensureSparseTrellis()` 两条路径都覆盖。
- 稀疏检出错误：注入失败 Git 结果，断言 `GIT_SPARSE_CHECKOUT_FAILED.message` 保留 sanitized stderr。
- promisor lazy fetch 超时：捕获 `runProcessImpl` 的 options，区分 `sparse-checkout init/set`，
  断言 `init=60000`、`set/read-tree/checkout=210000`，并断言 clone 与远端
  `ls-tree/show=210000`、push=150000。
- 分支重置：覆盖空分支、空 URL、空白字符串和有效组合；只有有效组合允许自动探测。
- 定时刷新诊断：断言 TeamError 结构化字段、非 TeamError stack/cause、details 和
  `last_error` 摘要均脱敏，且摘要带 code 前缀并限制长度。

## Rollback

- 服务端修改均为局部逻辑，可回滚对应 commit。
- 不涉及数据库迁移，回滚无需数据修复。
- 若新判重造成兼容问题，可回滚 `connect()` 的预检查/事务内复检，同时保留进程清理修复。
