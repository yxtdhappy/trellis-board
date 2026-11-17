# 任务同步性能与归档来源实施计划

## 1. 实施原则

- 先完成 schema、协议和测试夹具，再接 Git 子进程和 UI。
- 产品代码全部完成后只执行一次完整编译/测试；不在每个阶段重复构建。
- 不清扫、不格式化、不回滚工作区已有无关改动。
- 每个写入边界保留现有认证、CSRF、权限、事务和错误脱敏。
- 旧归档数据在 Git 首次成功导入前只读保留，不能造成发布后归档页立即清空。

## 2. 工作分解

建议实现时按三个可独立验证的工作流推进，但先由一个父任务完成契约收口：

### A. 服务端归档数据与 Git 导入

责任范围：

- `packages/server/database.js`
- `packages/server/team/http.js`
- `packages/server/team/archive-git-*.js`
- `packages/server/team/task-space-index.js`
- `packages/server/team/task-snapshot-service.js`
- 对应 server tests

### B. 管理页凭据与同步状态

责任范围：

- `packages/web/src/api/admin.ts`
- `packages/web/src/pages/admin/AdminPage.tsx`
- `packages/web/src/features/admin/ArchiveSyncTab.tsx`
- 对应 web tests

### C. 桌面活动-only 同步

责任范围：

- `packages/desktop/src-tauri/src/agent/task_sync.rs`
- `packages/desktop/src-tauri/src/agent/task_command.rs`
- `packages/desktop/src-tauri/src/agent/git.rs`
- 对应 Rust tests

共享协议与 schema 必须先由 A 完成，B/C 不能自行定义不同字段。

## 3. 有序检查清单

### 阶段 0：基线与隔离

- [ ] 记录当前活动文件、归档文件、任务索引行和 project/branch 分布。
- [ ] 记录 20 次任务创建的客户端阶段耗时和 Board 首次可见时间。
- [ ] 确认当前 `sync_task_space_file` 中 archive 行数并纳入迁移断言。
- [ ] 生成当前数据库备份，验证恢复命令可执行。
- [ ] 不修改当前用户已有 dirty/untracked 文件。

### 阶段 1：共享路径与协议

- [ ] 在 shared/task-snapshot 增加 archive 路径判断，保持现有路径格式校验。
- [ ] 增加稳定错误 `ARCHIVE_SYNC_SERVER_MANAGED`。
- [ ] 服务端所有 Agent 写入入口在事务开始前拒绝 archive。
- [ ] Agent snapshot/preflight/directory snapshot 统一过滤 archive。
- [ ] 测试混合活动+归档批次整批拒绝；活动删除单批仍成功。

### 阶段 2：Schema v14

- [ ] 新建 `sync_archive_file`。
- [ ] 新建 `sync_archive_git_credential`，唯一键为 `(scheme, host, port)`。
- [ ] 新建 `sync_archive_sync_config` 单行配置。
- [ ] 新建 `sync_archive_sync_state`。
- [ ] 新建 `sync_archive_sync_log`，按 taskSpace 保留最近 100 条失败记录。
- [ ] 为 `sync_task_space` 增加 `archive_revision`、`archive_indexed_revision`。
- [ ] 为 `sync_task_space_scan_cache` 增加 `indexed_archive_revision`。
- [ ] 编写 v13 -> v14 幂等迁移和备份。
- [ ] 复制旧 archive 行为 legacy 只读内容，并从 Agent 文件表移除 archive。
- [ ] 清理旧 cursor/deferred/conflict 中的 archive 条目。
- [ ] 测试旧库升级、空库创建、重复升级和中断恢复。

### 阶段 3：双 revision 与技术索引投影

- [ ] 索引物化输入同时读取 `sync_task_space_file` 和 `sync_archive_file`。
- [ ] 活动 revision 与 archive revision 分开推进。
- [ ] Board cache 的 current 判断同时检查两份 revision。
- [ ] archive-only 投影只发布 Board `tasks.changed`。
- [ ] 索引投影成功更新 `last_indexed_at`；投影失败写 `phase=index` 日志并设置 `index_error`。
- [ ] 活动写入不得被 archive 投影覆盖或误删。
- [ ] archive 投影失败不得回滚已提交 Git archive 文件。
- [ ] `manifestForDirectory()` 按路径选择活动或归档表。
- [ ] 测试活动/归档同任务 ID、分支基线去重、分页、搜索和详情。
- [ ] warm 投影事实、目录指纹和详情写入 `projection_state_json`，与 Board/双 revision 同事务提交。
- [ ] 服务重启复用持久化状态；版本或结构损坏回退 full。
- [ ] Team 主入口后台预热未停用 taskSpace，预热失败只告警且不阻塞监听。

### 阶段 4：凭据存储与安全原语

- [ ] 实现每来源一份凭据的 service，唯一键为规范化 `scheme + host + port`。
- [ ] AES-256-GCM 加密私钥和 Token，AAD 绑定 credential/origin/type/version。
- [ ] 主密钥独立文件，POSIX `0600`，Windows 继承数据目录 ACL。
- [ ] 私钥最大 32 KiB，Token 最大 8 KiB，拒绝 NUL、错误类型和格式。
- [ ] DTO 不返回 secret；只返回 origin、type、状态、指纹、时间和操作者。
- [ ] 审计记录 origin/type/action/result，不记录敏感值。
- [ ] 未提供 secret 的更新保留旧值；显式 rotate 才递增版本。
- [ ] 测试 `git.weintdata.cn:1022` 与 `github.com:443` 不互相匹配。
- [ ] 测试加密文件被篡改、主密钥缺失、明文泄漏和时间字段。

### 阶段 5：服务端 Git 只读导入

- [ ] 创建 `<data>/archive-git/<taskSpaceId>.git` bare cache。
- [ ] 禁止普通工作副本、checkout、commit、push、hooks 和 project config。
- [ ] 配置 promisor origin、`blob:none` filter，并保留 `extensions.partialClone=origin`。
- [ ] 按 active taskSpace 分支执行精确 refspec、`--depth=1 --filter=blob:none` fetch。
- [ ] 远端拒绝 partial clone filter 时失败关闭，不能静默下载完整源码 blob。
- [ ] 只执行 `ls-tree` 和 `cat-file --batch` 读取 `.trellis/tasks/archive`。
- [ ] 复用 branch/path/扩展名/UTF-8/1 MiB 校验。
- [ ] 对 source head、文件数和字节数做限制与状态记录。
- [ ] 完成 desired map diff、事务替换、墓碑/删除策略和 revision 递增。
- [ ] 无变化不写 SQLite、不增加 revision。
- [ ] fetch/import 失败写脱敏日志并保留最近尝试时间、最近成功时间。
- [ ] 失败保留上一份 `sync_archive_file`、index 和详情。
- [ ] 测试空 archive、删除 archive、非法路径、二进制文件、超限文件、符号链接、非 UTF-8。
- [ ] 测试两个 project 同一分支名、同一 project 多 branch、不同 host/port。

### 阶段 6：凭据匹配与进程隔离

- [ ] 从 `sync_project.remote_url` 解析 scheme/host/port，不读取客户端任意路径。
- [ ] SSH 只匹配 `ssh://host:port` 凭据；HTTPS 只匹配 `https://host:port`。
- [ ] 公开 HTTPS 无凭据可匿名；私有 HTTPS 有 Token 才认证。
- [ ] 无匹配 SSH 凭据立即失败，不发网络请求。
- [ ] 临时认证目录 `0700`、私钥 `0600`，finally 清理，启动清理残留。
- [ ] 使用隔离 `GIT_CONFIG_GLOBAL/NOSYSTEM`、空 hooks、禁用 credential helper/file/ext protocol。
- [ ] SSH 使用 `BatchMode`、`IdentitiesOnly`、`StrictHostKeyChecking=yes` 和已确认 known_hosts。
- [ ] HTTPS 保持证书校验，不关闭 TLS。
- [ ] 对 stdout/stderr 统一脱敏私钥、Token、Authorization、临时目录和绝对路径。
- [ ] 测试认证失败、host key 变化、网络超时、仓库不存在和凭据过期。

### 阶段 7：调度器与生命周期

- [ ] 实现串行轮询调度器，避免重叠执行。
- [ ] 默认 300 秒，页面可配置，限制合法范围。
- [ ] 全局并发最大 2；project 和 taskSpace 分别有锁。
- [ ] 项目/分支接入后可触发一次近时同步。
- [ ] 失败按 30s/1m/2m/5m/10m/30m 退避，成功重置。
- [ ] 服务关闭 abort 子进程并等待 scheduler 结束。
- [ ] 测试一个 taskSpace 慢同步不阻塞 HTTP 或另一个 taskSpace。

### 阶段 8：管理 API 与页面

- [ ] 增加仅 system admin 的 archive-sync GET/config/credentials/test/run API。
- [ ] 页面展示启用、周期、凭据列表和 project/branch 状态。
- [ ] 页面展示每个 taskSpace 的最近更新时间、最近尝试时间、最近成功时间和当前状态。
- [ ] 索引失败时打开该 taskSpace 的失败日志弹层，支持分页加载并按时间倒序显示阶段、错误码、摘要和时间。
- [ ] 支持新建/替换/删除 SSH 私钥和 HTTPS Token。
- [ ] 支持 SSH 主机指纹确认，禁止静默接受新主机。
- [ ] secret 字段只写不读；保存后清空表单。
- [ ] 日志使用现有 `sanitizeDiagnosticText()` / `diagnosticError()`，并测试私钥、Token、Authorization、Cookie 和绝对路径脱敏。
- [ ] 支持立即同步、手动重试和错误脱敏展示。
- [ ] 测试未登录、非管理员、CSRF、删除被引用凭据和重复 origin。
- [ ] 测试 taskSpace 日志分页、最多 100 条保留、级联删除和不同 taskSpace 隔离。

### 阶段 9：桌面 Agent archive 过滤

- [ ] 全根扫描跳过 `.trellis/tasks/archive`。
- [ ] `task_dirs` 中 archive 目录在读取正文前丢弃。
- [ ] watcher 过滤 archive 事件，不进入 debounce、ownership 或上传。
- [ ] HEAD diff、ownership 持久索引、deferred、baseline、conflict review 过滤 archive。
- [ ] pull 服务端 snapshot 不应用 archive 文件。
- [ ] 活动目录移动只生成活动删除墓碑，不再将归档路径加入批次。
- [ ] 迁移旧 pending：纯 archive 丢弃；混合批次重建为仅活动删除。
- [ ] 迁移不得复用被改写文件的原 batchId。
- [ ] 继续保留发送前目标目录重读、真实分支和 CAS 门禁。
- [ ] 测试 restart、pending retry、离线恢复、删除重建和冲突阻断。

### 阶段 10：原活动热路径优化

- [ ] `read_local_task_snapshot_files()` 有 `task_dirs` 时直接从目标目录 DFS。
- [ ] 删除 `upload_directories()` 的全空间正文读取。
- [ ] 保留发送前重读和完整路径/符号链接/UTF-8/大小校验。
- [ ] HEAD 差量使用受限 `diff-tree`，任何不安全输出回退 full。
- [ ] `create_task()` 删除无消费的全仓 status；保留唯一目录、origin、分支、task ID 校验。
- [ ] 命令直传后按内容摘要抑制一次 watcher 回波。
- [ ] 全局锁改为 per-taskSpace lock。
- [ ] 增加 stage 日志：trigger、targetDirs、git、localScan、cursor、http、pull、ownership、total。

### 阶段 11：代码完成后的唯一完整验证

所有产品代码完成后执行：

```text
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
yarn test
```

聚焦测试：

- shared archive path 与 batch 拒绝。
- v13/v14 schema 迁移与备份。
- 双 revision、archive-only Board event、Agent event 不触发。
- 跨 index 实例持久化状态复用、损坏回退和启动预热只扫描变化任务。
- per-origin credential 隔离、加密、轮换、审计脱敏。
- Git bare cache、ref 隔离、archive-only tree、失败保留。
- 客户端所有入口过滤 archive。
- 旧 pending 迁移不破坏 CAS/幂等。
- 原有活动任务创建、编辑、冲突、重开和 SSE 回归。

### 阶段 12：真实 E2E

使用 `wit-e2e-testing` 和真实 Windows 客户端：

- [ ] 创建活动任务，记录文件写完到 committed 的 P95。
- [ ] 活动任务归档并 push，等待或点击立即同步，确认 Board 归档出现。
- [ ] 确认归档前服务端活动卡片消失，归档同步前短暂缺失符合预期。
- [ ] 本地修改 archive 且不提交，服务端归档不变化。
- [ ] 本地修改 archive 并提交、push，下一轮同步显示新正文。
- [ ] 删除 archive 并 push，归档索引消失。
- [ ] 同一项目两个分支各有不同归档，确认不串分支。
- [ ] 两个项目使用不同 host/port 凭据，确认不串凭据。
- [ ] 错误凭据/错误主机/网络断开时旧归档仍可读。
- [ ] 仅归档同步变化时 Agent 不新建 pending、不做活动 pull。
- [ ] 退出重开客户端、重启服务端，活动 cursor 和归档状态可解释。
- [ ] 两个 taskSpace 并发时互不阻塞。
- [ ] 单任务创建 P50/P95 和看板首次可见 P50/P95 写入 `e2e-report.md`。

验收门槛：

```text
文件写完 -> activity revision committed P95 <= 2s
看板点击 -> 任务首次可见 P95 <= 5s
```

## 4. 风险文件

- `packages/server/database.js`
- `packages/server/team/task-snapshot-service.js`
- `packages/server/team/task-space-index.js`
- `packages/server/team/http.js`
- `packages/server/team/archive-git-sync.js`（新增）
- `packages/server/team/archive-git-credentials.js`（新增）
- `packages/server/team/archive-git-store.js`（新增）
- `packages/server/team/process.js`
- `packages/shared/task-snapshot.js`
- `packages/web/src/pages/admin/AdminPage.tsx`
- `packages/web/src/features/admin/ArchiveSyncTab.tsx`（新增）
- `packages/web/src/api/admin.ts`
- `packages/desktop/src-tauri/src/agent/task_sync.rs`
- `packages/desktop/src-tauri/src/agent/task_command.rs`
- `packages/desktop/src-tauri/src/agent/git.rs`

## 5. 独立回滚点

1. 先停止 archive scheduler；旧 `sync_archive_file` 和 Board cache 仍可读。
2. 关闭管理页 archive 配置入口，不删除已有加密凭据。
3. 回滚服务端 Agent archive 拒绝前，先恢复客户端 archive 过滤，避免双写。
4. 数据库保留 v14 数据结构；恢复 v13 代码时只读旧活动表，避免误用 archive 表。
5. 若索引投影失败，停止 scheduler 并回退到最后一个完整 Board cache。
6. 不通过删除用户数据库或强制重扫来恢复；先保留备份和审计证据。
