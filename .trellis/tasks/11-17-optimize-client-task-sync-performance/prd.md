# 任务同步性能与归档来源重构

## Goal

把团队任务同步拆成两条独立链路：

- 客户端只同步尚未归档的活动任务，继续保证活动任务的 CAS、冲突、pending 重试和跨客户端一致性。
- 服务端只通过定时 Git 拉取归档任务，为客户端和普通浏览器提供统一归档索引；归档不再经过 Agent 监听、上传、拉取、cursor 或冲突链路。

同时消除任务创建热路径中的全目录扫描、全空间正文读取、无必要 Git 检查和跨 taskSpace 串行阻塞。

## Background

已核实的性能事实：

- 2026-11-16 的一次 warm E2E 从 `task.py create` 到 Board 可见约 `9.293s`；服务端 warm 增量投影约 `139ms`，主要延迟在桌面客户端同步链路。
- `read_local_task_snapshot_files()` 收到 `task_dirs` 后仍从 `.trellis/tasks` 根递归遍历再过滤；代码锚点：`packages/desktop/src-tauri/src/agent/task_sync.rs:6762`、`:6782`、`:6811`。
- `upload_directories()` 对单任务仍读取并哈希整个 taskSpace 正文；代码锚点：`packages/desktop/src-tauri/src/agent/task_sync.rs:4943`。
- 同一上传还会在发送前重扫目标目录；该重扫是一致性门禁，需要保留，但前面的全空间重复读取可以删除。
- 当前所有 taskSpace 共享 `binding_sync_lock`，慢扫描会串行阻塞其他 taskSpace。
- 当前 Git HEAD/ref 变化会无条件进入 full ownership 扫描；单 taskSpace 日志中 P95 约 `12.898s`，最大约 `20.831s`。

已核实的归档事实：

- 当前服务端把活动和归档任务正文都放在 `sync_task_space_file`，并用 `sync_task_index.archived` 区分索引；没有独立归档表。
- 当前客户端仍扫描、监听、计算 dirty、维护 cursor/ownership 并双向同步 `.trellis/tasks/archive/**`。
- 当前归档页已经读取服务端任务查询，不是直接读取桌面本地目录。
- 当前本机服务端有效文件快照为 `4,893` 行，其中归档 `4,826` 行、活动 `67` 行；归档约占 `98.6%`。
- 当前各项目归档文件行远多于活动文件行，例如 `mdp-management-web` 为归档 `1,615`、活动 `0`，`trellis-board` 为归档 `741`、活动 `25`。
- 当前项目远端既有 SSH，例如 `ssh://git.weintdata.cn:1022/...`，也有公开 HTTPS，例如 `https://github.com/yxtdhappy/trellis-board`。

已确认的产品决策：

- 客户端归档索引读取服务端，不读取本机归档作为 Board 索引来源。
- 服务端归档任务只通过定时 Git 拉取获得。
- `.trellis/tasks/archive/**` 下的所有文件都不进入客户端 watcher、扫描和任务快照同步。
- 服务端通过管理页面按 Git 远端来源配置只读凭据：同一 `scheme + host + port` 共用一份，不同来源互不复用。
- 服务端 Git 只读取每个项目对应活动 taskSpace 分支下的 `.trellis/tasks/archive/**`，不读取活动任务或项目其他文件。
- 允许服务端归档与尚未提交、尚未推送的客户端本地归档暂时不一致。

## Requirements

### R1：客户端只同步活动任务

- 客户端全量扫描、目标目录扫描、watcher、HEAD 差量、ownership、cursor、pending、deferred、冲突、SSE pull 和命令上传都必须忽略 `.trellis/tasks/archive/**`。
- 活动任务移动到归档目录时，客户端只上传旧活动路径的删除墓碑；不得上传新归档路径正文。
- 活动任务的批次幂等、文件级 CAS、稳定任务 ID、分支归属、冲突阻断和 pending 原样重试不得退化。
- 服务端 Agent 快照不得返回归档文件，Agent `POST changes` 和冲突覆盖不得写入归档路径。

### R2：服务端归档使用独立事实源

- 服务端归档正文不得再由 Agent 写入，也不得与活动任务快照共用可写文件集合。
- 服务端为每个 project + branch taskSpace 保存一份由 Git 得到的归档快照。
- Git 导入只接受 `.trellis/tasks/archive/<YYYY-MM>/<task-dir>/<file>`，文件类型和大小遵循现有任务快照白名单。
- 分支之间归档数据必须隔离；同一稳定任务 ID 的查询去重继续遵循现有基线规则。
- Git 拉取失败时保留上一次成功快照和索引，显示过期/错误状态，不得清空归档。

### R3：服务端 Git 定时同步

- 定时器只遍历状态为 active 且未 retired 的 project/taskSpace 分支。
- 服务端只执行 fetch 和只读对象读取，不 checkout、不创建项目工作副本、不 commit、不 push。
- Git 缓存按 taskSpace branch 隔离，使用 `--depth=1 --filter=blob:none` 获取 commit/tree，再只为 archive 路径按需读取 blob；远端不支持 partial clone 时标记不支持并不能静默退化为全分支 blob 拉取。
- 每个 project + branch 的同步在同一 taskSpace 锁内执行；不同 taskSpace 可以受控并行。
- 成功同步后，归档索引更新必须触发 Board `tasks.changed`，但不得因“仅归档变化”唤醒 Agent 拉取活动任务。
- 失败必须使用有界退避，不能阻塞 HTTP 请求或活动任务写入。
- 管理页的每个 taskSpace 必须显示“最近更新时间”，该时间以最后一次成功完成归档索引投影为准；失败时同时保留最近尝试时间和最近成功时间。
- fetch、归档文件导入或索引投影失败都必须为该 taskSpace 写入可查看的失败日志，不能只显示一个通用状态。

### R4：按远端来源隔离的只读 Git 凭据与页面配置

- 只允许系统管理员配置、替换和删除归档 Git 凭据。
- 凭据按规范化后的 `scheme + host + port` 唯一绑定；例如 `git.weintdata.cn:1022` 与 `github.com:443` 必须是两份独立配置，不能跨来源复用。
- SSH 私钥只能用于与来源完全匹配的 SSH 远端；HTTPS 使用独立 Token 或匿名访问，不能把 SSH 私钥交给 HTTPS 客户端。
- 未配置凭据的 SSH 远端直接拒绝；公开 HTTPS 可匿名读取，私有 HTTPS 必须显式配置 Token。
- 密钥和 Token 必须分别加密落盘，API 只能返回“已配置/未配置”、类型、更新时间和可选指纹，永不返回明文。
- 日志、审计、错误详情和进程输出不得包含私钥、口令、Authorization、临时密钥文件路径。
- 服务端必须使用隔离 Git 配置、非交互认证、严格主机校验和参数数组执行子进程，禁止 shell 拼接。
- 页面至少提供启用开关、按 `scheme + host + port` 维护凭据、立即同步、同步周期，以及每个 project/branch 的状态、最近更新时间、最近尝试时间和失败日志入口。

### R5：统一服务端归档索引和详情

- `sync_task_index.archived=1` 继续作为归档查询索引，普通浏览器和桌面客户端共用。
- 归档详情的 PRD、设计、报告、研究等正文读取同一份服务端 Git 导入快照。
- 活动索引 revisions 与归档导入 revisions 必须可区分，避免归档轮询让 Agent cursor 误判活动任务发生变化。
- 归档导入、索引重建和 Board 缓存更新必须保持同一 taskSpace 的事务/版本边界。

### R6：迁移与兼容

- 新 Agent 不再发送归档路径；服务端对归档路径返回稳定、不可自动重试的错误。
- 客户端升级时，包含归档路径的旧 pending batch 必须安全迁移或终止，不能原样无限重试。
- 服务端首次成功 Git 导入前可以保留旧归档快照作为只读缓存；首次成功后以 Git 快照替换该 taskSpace 的旧归档来源。
- 数据库升级前必须使用现有备份机制生成可恢复备份。

### R7：性能与可观测性

- 保留并完成原活动任务优化：目标目录直扫、去全空间正文读取、HEAD 差量、命令/watcher 去重、taskSpace 级锁和阶段日志。
- Git 导入需要记录 project、branch、taskSpace、fetch 耗时、对象读取耗时、文件数、revision、结果和脱敏错误。
- 每个 taskSpace 的失败日志必须包含阶段、错误码、脱敏摘要、尝试时间和可选结构化详情；日志必须分页、限量保留，并通过 system admin 接口读取。
- 客户端同步日志不得再出现归档目录扫描计数；服务端日志不得出现仓库绝对路径或凭据内容。

### R8：验证

- 单元/集成测试覆盖活动同步、归档导入、索引查询、权限、密钥加密、失败保留、分支隔离和旧 pending 迁移。
- 真实 E2E 使用至少两个分支和一个归档任务，验证 Git 提交并被服务端拉取后，Board 归档页可见。
- 性能测试继续使用原门槛：文件写完到活动 revision committed 的客户端侧 P95 `<= 2s`，看板点击到任务首次可见 P95 `<= 5s`。

## Acceptance Criteria

- [ ] 客户端任意扫描、watcher、HEAD 差量、ownership、pull、pending 和冲突路径都不读取或上传 `.trellis/tasks/archive/**`。
- [ ] 活动任务归档后，服务端活动索引消失；下一次 Git 同步成功后以 `archived=1` 出现在归档索引。
- [ ] Agent 尝试写入归档路径时整批拒绝，服务端归档快照不变化。
- [ ] 同一 Git 项目不同 taskSpace 分支分别读取各自分支的 archive，不串分支、不串项目。
- [ ] 服务端 Git 进程只执行只读 fetch/object 命令；测试仓库中的活动任务和源码从未被导入归档表。
- [ ] Git 请求使用 shallow + `blob:none` partial clone；测试证明活动任务和源码 blob 未下载、未读取，远端不支持过滤时同步明确失败。
- [ ] Git 认证失败、分支不存在或网络超时时，上一份归档索引和详情仍可读，状态显示上次成功时间与脱敏错误。
- [ ] 每个 taskSpace 显示最近一次成功更新归档索引的时间；失败后仍显示最近尝试时间，并能打开该 taskSpace 的失败日志。
- [ ] fetch、导入、索引投影任一步骤失败都会产生日志；日志分页、按时间倒序、脱敏且不能出现私钥、Token、Authorization 或绝对路径。
- [ ] 管理页保存凭据后再次读取只得到来源、类型、配置状态和可选指纹，不返回私钥或 Token；审计和日志扫描不到敏感值。
- [ ] `git.weintdata.cn:1022` 与 `github.com:443` 只能匹配各自凭据；任一来源缺失或不匹配时不会复用另一来源的凭据。
- [ ] 仅归档变化不会触发 Agent `task.changed`；Board 页面仍能通过事件刷新归档索引。
- [ ] 项目包含 `300` 个以上活动任务目录、`1500` 个以上正文文件时，单任务上传不读取非目标活动任务正文，也不读取任何归档正文。
- [ ] 单任务创建 P95 和看板首次可见 P95 达到 `2s/5s` 门槛，日志能证明归档文件数和全空间扫描次数归零。
- [ ] 两个 taskSpace 同时触发时，一个 taskSpace 的慢 Git/任务扫描不会串行阻塞另一个 taskSpace 的 HTTP 请求或普通活动上传。
- [ ] 升级、重开客户端和服务端重启后，活动 cursor、pending、冲突、归档索引和最后一次 Git 同步状态保持可解释。
- [ ] 优化前后样本、数据库行数、Git 同步耗时和真实 E2E 证据写入 `e2e-report.md`。

## Out of Scope

- 不把 Git 历史中的所有归档版本做成时间机器；只展示每个活动分支当前 HEAD 下的归档。
- 不读取客户端未提交或未推送的归档文件。
- 不自动合并同一任务在不同分支上的归档差异；继续按基线 taskSpace 去重。
- 不支持 SSH/HTTPS 之外的 Git 远端协议；SSH 使用按来源配置的只读私钥，HTTPS 使用按来源配置的只读 Token 或匿名访问。
- 不重构 Board 归档页视觉、分页协议或普通任务查询 API。
- 不提供任意历史日志全文搜索、日志下载或日志导出；只提供按 taskSpace 查看有界失败历史。
- 不优化 `task.py create` 自身约 `2-3s` 的文件生成耗时。
- 不清理当前工作区中与本任务无关的 dirty/untracked 文件。
