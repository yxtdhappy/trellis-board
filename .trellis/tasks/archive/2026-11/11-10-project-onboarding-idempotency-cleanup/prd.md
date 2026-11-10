# 项目接入幂等与 Windows 清理修复

## Goal

让项目接入在重复提交、Git 本地步骤超时和 Windows 文件锁场景下保持可恢复：

- 同一团队、同一规范化远端、同一同步分支只能存在一个团队项目。
- 接入失败返回可定位的真实原因，不能被清理阶段的 `EPERM` 覆盖。
- 清理失败不能产生页面可见但数据库未登记的半成品项目。

## Background

2026-11-10 使用 `ssh://git@git.weintdata.cn:1022/prod-mdp/mdp-backend-service.git` 接入“大数据”团队时出现以下现象：

- 两次 `POST /api/admin/projects` 均返回 `500`，耗时约 `32.7s` 和 `33.0s`。
- 服务端日志最终报清理 UUID 工作副本时 `EPERM: Permission denied`。
- `projects/` 下留下两个 `mdp-backend-service` 工作副本，但 SQLite 只有 `mdp-backend-web`，不存在对应 `repositories`、`team_project` 或 `project_connected` 审计记录。
- 页面只查询数据库，因此两个残留目录不可见。
- 同一远端可以再次提交并生成新的随机 UUID。
- 接入私有 GitHub 仓库 `https://github.com/yxtdhappy/trellis-board.git` 的
  `codex/team-board` 分支时，页面报“无法收敛项目工作副本”及
  `GIT_SPARSE_CHECKOUT_FAILED`。
- 根因是 `clone --filter=blob:none` 创建了 promisor 仓库，但后续
  `sparse-checkout`、`read-tree` 和模板清单读取没有继承 clone 的 HTTPS askpass 环境；
  Git 懒取缺失 blob 时尝试交互式询问用户名并失败。
- 另有一个独立问题：使用真实 `yhj_trellis` SSH 凭据接入
  `ssh://git@git.weintdata.cn:1022/prod-mdp/mdp-backend-service.git` 的 `dev` 分支时，
  认证已经传到全部命令，但第一次 `git read-tree -mu HEAD` 耗时 30.475s，刚好超过
  `LOCAL_TIMEOUT=30s`，被错误映射为 `GIT_REMOTE_TIMEOUT`。另一复跑样本也在
  `git sparse-checkout set` 阶段超过 30s。
- 放宽可疑网络步骤后，完整接入耗时 43.006s 成功，`initialized=false`，commit 为
  `516bd1b71d482f6eca027410b9059540131b11c9`，工作树只有 `.trellis`。这证明 SSH 问题
  是 promisor lazy fetch 的真实网络耗时，不是认证缺失。真实完整接入稳定在约 41–43s，
  最终将所有操作执行超时在各自原值上增加 30s，避免重新落到原来的 30s 边界。
- 项目实际接入成功并显示“批准项目接入”内容后，右上角额外出现 toast
  “请先填写 Git 远端 URL”。项目列表和审批内容均正常，属于成功后的伪错误。
- 伪错误来源是 `resetForm()` 清空受控分支 Select 时触发 `changeBranch('')`，
  `changeBranch()` 未判断空分支便调用 `runProbe()`。
- 定时拉取日志两次只出现 `projectId` 和 `error: "同步项目失败"`，但项目随后
  `sync_status=current`、`last_error=null` 且成功 fetch，说明是瞬时失败。
  当前日志丢失 `TeamError` 的 code、status、details、stack/cause，无法区分网络、
  认证、项目状态或代码错误。

## Requirements

### R1：按团队、远端和同步分支判重

- 项目身份固定为 `teamId + remote_identity_hash + sync_branch`。
- clone 前先检查已有项目，存在时返回 `409 PROJECT_ALREADY_CONNECTED`，不执行 clone。
- 写数据库前在现有 `BEGIN IMMEDIATE` 事务内再次检查，阻止并发请求产生重复记录。
- 冲突错误包含已有项目 ID、名称、同步分支和状态。
- 同一仓库的不同同步分支仍可作为不同团队项目接入。
- 已有 `repositoryId` 升级本地仓库的现有行为保持不变。

证据：[projects.js](../../../server/team/projects.js:335)、[projects.js](../../../server/team/projects.js:419)、[database.js](../../../server/database.js:217)。

### R2：Windows 超时终止与清理可靠

- Windows 超时终止进程树后，必须等待 `taskkill /T /F` 完成，再进入目录清理和错误返回。
- 克隆失败清理和项目接入失败清理使用有界重试，覆盖瞬时 `EPERM`、`EBUSY` 等文件锁。
- 清理错误不得覆盖原始 Git 或工具链错误。
- 服务端日志同时保留原始错误、清理错误、项目/工作区标识以及用户、团队和分支上下文。

证据：[process.js](../../../server/team/process.js:46)、[process.js](../../../server/team/process.js:98)、[git-manager.js](../../../server/team/git-manager.js:1077)。

### R3：前端接收明确冲突

- 重复接入被拒绝后，“已接入项目”列表刷新。
- 前端显示服务端冲突信息，不进入新的初始化或批准流程。
- Git 超时继续通过现有 `TeamError` 映射返回，不再退化为 `500 INTERNAL_ERROR`。

证据：[useAdminProjects.ts](../../../web/src/hooks/useAdminProjects.ts:260)、[errors.js](../../../server/team/errors.js:16)。

### R4：现有孤儿目录安全处理

- 不在代码中自动扫描并删除数据库未知目录。
- 两个已知 UUID 目录只在停止服务、完成数据库和审计引用检查后作为人工清理步骤处理。
- 执行删除前必须再次展示精确路径并取得明确授权。

### R5：Partial clone 全链路认证

- `setSparsePaths()`、`applyTrellisSparse()`、`checkoutInitializationContext()` 必须接收并传递认证上下文。
- `cloneForTeam()` 在同一个 `withGitAuth()` 作用域内完成 clone、稀疏检出初始化、共享分支检出、
  远端 tree/模板清单读取、初始化上下文检出、提交、推送和最终收敛。
- `readRemoteTree()` 必须把认证传给 `ls-tree` 和 `git show HEAD:.trellis/.template-hashes.json`，
  防止 promisor 仓库懒取 blob 时再次要求交互式凭证。
- `ensureSparseTrellis()` 必须使用项目凭据包裹 `applyTrellisSparse()`；
  `read-tree` 触发 promisor fetch 时仍使用项目绑定的 HTTPS/SSH 凭据。
- 稀疏检出失败消息必须包含经 `sanitizeProcessOutput()` 处理的 Git stderr/stdout，
  在保留真实错误的同时脱敏 Token、私钥和口令。

### R6：操作执行超时统一增加 30s

- `git sparse-checkout init` 只操作本地 sparse 配置，使用增加后的 `LOCAL_TIMEOUT=60s`。
- `git sparse-checkout set`、`git read-tree -mu HEAD`、共享分支 `git checkout` 都可能触发
  promisor lazy fetch，必须使用增加后的 `REMOTE_TIMEOUT=210s`。
- `git merge --ff-only FETCH_HEAD`、分叉恢复中的 `git rebase FETCH_HEAD` 也会物化工作树或
  缺失对象，必须继承当前认证并使用 `REMOTE_TIMEOUT=210s`。
- `readRemoteTree()` 的 `git ls-tree` 和模板清单 `git show` 读取远端对象，也必须默认使用
  `REMOTE_TIMEOUT=210s`。
- 自动化测试必须区分 `sparse-checkout init` 与 `set`，并断言 `set`、`read-tree`、`checkout`
  的 `timeoutMs` 为 210000。

| 操作 | 原超时 | 新超时 |
| --- | ---: | ---: |
| 本地 Git 默认操作 `LOCAL_TIMEOUT` | 30s | 60s |
| 远端/promisor 操作 `REMOTE_TIMEOUT` | 180s | 210s |
| 推送 `PUSH_TIMEOUT` | 120s | 150s |
| 远端探测 `PROBE_TIMEOUT` | 30s | 60s |
| Trellis CLI 初始化 | 180s | 210s |
| SSH 主机扫描 | 15s | 45s |
| toolchain 预检 | 30s | 60s |
| 团队 `task.py` | 120s | 150s |
| `runProcess` 默认超时 | 30s | 60s |

### R7：成功接入后的内部重置不得触发探测提示

- `changeBranch()` 只有在分支非空且当前远端 URL 去空白后非空时才调用 `runProbe()`。
- `resetForm()`、`resetProbe()`、切换 URL/凭据造成的内部清空不得显示
  “请先填写 Git 远端 URL”或其他用户操作错误。
- 用户显式触发“识别远端”时，`runProbe()` 对空 URL 的提示保持不变。
- 使用无 DOM 依赖的纯守卫和 Node 测试覆盖空分支、空 URL、空白字符串和有效组合。

### R8：定时刷新失败日志与项目错误摘要

- 定时刷新失败日志必须保留 `name/code/status/message/details`；兼容字段 `error` 继续保存 message。
- 非 `TeamError` 额外记录经脱敏的 `stack` 和 `cause`。
- 日志和数据库摘要不得包含 Token、私钥、口令、Authorization、Cookie 或绝对路径。
- `projects.refresh` 写入 `last_error` 时使用 `code: message`，保持前端可读且不泄露内部路径。
- 不因当前项目已经恢复而强制写入数据库或重启服务；只在后续真实失败发生时记录增强诊断。

## Acceptance Criteria

- [ ] 首次接入同一团队、远端和分支成功。
- [ ] 再次提交相同组合返回 `409 PROJECT_ALREADY_CONNECTED`，且第二次不执行 clone。
- [ ] 并发提交相同组合时，最多产生一条 `team_project` 记录。
- [ ] 同一仓库的 `dev` 和 `main` 可分别接入为两条项目记录。
- [ ] 本地 Git 步骤超时后返回明确超时错误，而不是 `INTERNAL_ERROR`。
- [ ] 超时后进程树已退出，UUID 工作副本在有界重试内清理。
- [ ] 模拟清理仍失败时，日志保留原始错误和清理错误，且数据库不产生项目记录。
- [ ] 重复接入冲突后，前端刷新项目列表并显示已有项目提示。
- [ ] 两个已知孤儿目录的引用检查结果明确；未经再次授权不删除。
- [x] 本地 partial clone 回归断言 `clone`、`sparse-checkout`、`read-tree`、`checkout`
  和远端 `ls-tree`/`show` 均继承 HTTPS 认证环境。
- [x] 本地回归断言 `ensureSparseTrellis()` 解析项目凭据后再执行 sparse/read-tree。
- [x] 稀疏检出失败消息包含脱敏后的 Git 输出，不泄露测试 Token。
- [x] 本地回归断言 `sparse-checkout init=60000ms`，
  `sparse-checkout set/read-tree/checkout=210000ms`。
- [x] 本地回归断言 clone、远端 `ls-tree` 与模板清单 `show` 使用 `210000ms`。
- [x] 分支探测守卫只有在分支和远端 URL 均非空时返回 true。
- [x] `changeBranch('')` 和内部重置不会调用探测，也不会显示空 URL toast。
- [x] 定时刷新失败日志记录 `TeamError` 的结构化字段并脱敏 details。
- [x] 非 `TeamError` 的 stack/cause 已脱敏。
- [x] 临时数据库中的项目刷新失败把 `code: message` 写入 `last_error`，不包含 Token 或绝对路径。
- [ ] 真实 4317 服务重启后，私有 GitHub 仓库 `codex/team-board` 分支可完成接入。
- [ ] 真实 4317 服务重启后，SSH `mdp-backend-service/dev` 在当前超时配置下可完成接入。
- [ ] 真实管理台完成一次接入后，审批内容出现且不出现“请先填写 Git 远端 URL”toast。
- [ ] 相关 Node 测试、前端 lint、最终类型检查和构建通过。

## Out Of Scope

- 不新增项目自动发现或批量修复后台任务。
- 不自动删除未登记目录。
- 不修改桌面客户端 `live-control` 窗口行为。
- 不改变 Git 远端探测、凭据加密、Agent 工具初始化或工具链批准规则。
- 不覆盖多服务实例并发写库；当前仍以单团队服务进程为前提。
- 本次不增加 schema v9 唯一索引。

## Key Decisions

- 判重键为“团队 + 规范化远端身份 + 同步分支”，允许同仓库多分支。
- 第一阶段使用 clone 前预检查加事务内复检，不升级数据库 schema。
- 清理失败只进入服务端诊断日志，不把本地路径暴露给前端。
- 残留目录清理是单独的人工操作，不是自动修复行为。

## Risks And Deferred Items

- 预检查加事务内复检依赖所有写入经过当前服务进程；若后续支持多进程写同一数据库，需要增加唯一索引迁移。
- 具体哪条本地 Git 命令在故障时超时仍被清理错误覆盖；本任务修复后应能由原始超时错误定位。
- 处理现有孤儿目录前仍需确认没有手工保留价值。
