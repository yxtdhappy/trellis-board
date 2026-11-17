# 服务端 Git 归档导入可行性研究

## 1. 结论

可以用按 taskSpace 隔离的 bare Git cache 实现“只请求 archive blob、不创建项目工作副本”：

```text
git init --bare
git fetch --depth=1 --filter=blob:none origin +refs/heads/<branch>:refs/heads/trellis-archive
git ls-tree -r -z --long <commit> -- .trellis/tasks/archive
git cat-file --batch
```

bare cache 配置 `remote.origin.promisor=true`、`remote.origin.partialclonefilter=blob:none` 和
`extensions.partialClone=origin`。首次 fetch 只获取当前 commit、tree 和必要元数据；`cat-file`
再按 archive blob OID 懒加载所需正文。

不执行 checkout，不运行项目脚本，不读取项目 `.gitattributes` 转换，也不写入远端。

## 2. 当前项目身份

`sync_project` 已有：

- `remote_url`
- `remote_identity_hash`
- `baseline_branch`
- `owner_team_id`
- `status`

`sync_task_space` 已有：

- `project_id`
- `branch_name`
- `status`
- `retired_at`

因此 Git 导入可以直接按现有 project/taskSpace 数据遍历，不需要重新让用户配置仓库地址。

依据：

- `packages/server/database.js:756`
- `packages/server/database.js:807`
- `packages/server/team/task-space-service.js:690`

## 3. 现有 Team 约束

当前规范明确 Team 服务端不 clone/fetch/push 项目仓库：

- `.trellis/spec/backend/desktop-realtime-sync.md:11`
- `.trellis/spec/backend/desktop-realtime-sync.md:503`
- `docs/team-operations.md:11`

本需求有意把边界收窄为：

- 允许只读 fetch。
- 禁止普通工作副本、提交和推送。
- 只读取 archive tree，并通过 partial clone 按需获取 archive blob。
- 凭据按 origin 隔离。

实现时必须同步更新规范，避免以后又按“服务端完全无 Git”检查代码。

## 4. 可复用的旧实现模式

旧 `git-manager.js` 已实现过：

- `gitEnvironment()` 隔离系统/全局 Git 配置。
- 禁止 terminal prompt 和 credential helper。
- 禁止 ext/file 协议。
- 临时认证目录和崩溃遗留清理。
- `runProcess()` argv 执行、超时、输出上限和脱敏。
- SSH 主机指纹扫描与管理员确认。
- AES-256-GCM 凭据加解密。

依据：

- `packages/server/team/git-manager.js:69`
- `packages/server/team/git-manager.js:318`
- `packages/server/team/git-manager.js:1485`
- `packages/server/team/git-credentials.js:180`
- `packages/server/team/git-credentials.js:493`

不能复用：

- `team_project`、`git_operation`、`git_credential` 的旧业务模型。
- clone 工作副本。
- commit、rebase、push。
- 旧 Team Git HTTP 路由。

应抽取安全原语或实现独立的归档服务，避免重新启用旧 Git 生命周期。

## 5. 凭据按来源隔离

当前项目来源：

```text
ssh://git.weintdata.cn:1022/prod-mdp/mdp-backend-service
https://github.com/yxtdhappy/trellis-board
```

建议唯一键：

```text
ssh://git.weintdata.cn:1022
https://github.com:443
```

匹配规则必须使用规范化后的 scheme/host/effective port：

- 不接受后缀或子串匹配。
- `git.weintdata.cn:1022` 与 `git.weintdata.cn:22` 是两个 profile。
- `https://github.com:443` 与 `ssh://github.com:22` 是两个 profile。
- SSH 未匹配时直接拒绝。
- HTTPS 未匹配时只尝试匿名；失败后显示需要 Token。

## 6. 读取 archive 的对象方式

### 6.1 列文件

```text
git ls-tree -r -z --long <commit> -- .trellis/tasks/archive
```

只接受：

- mode `100644` / `100755`
- type `blob`
- archive 路径
- 现有任务正文扩展名
- 单文件 `<= 1 MiB`

### 6.2 读内容

使用 `git cat-file --batch` 按 blob OID 批量读取，避免每个文件启动一个 Git 进程。
缺失对象由 promisor origin 按需获取；如果 Git 服务端忽略或拒绝 `blob:none` filter，客户端可能退化为
全对象下载，因此实现必须把该情况视为 `git_filter_unsupported` 并停止当前 branch 导入。

读取后：

- `TextDecoder("utf-8", { fatal: true })`
- `normalizeSnapshotText()`
- `snapshotSha256()`

确保与 Agent 路径生成的摘要语义一致。

## 7. 热更新与索引

Git archive 变化不能直接修改现有 Board JSON。流程应为：

1. Git 读取完成，生成 desired archive rows。
2. SQLite 事务更新 `sync_archive_file` 和 `archive_revision`。
3. 索引 worker 重新合并活动/归档文件。
4. 生成新的 `sync_task_index` 和 Board cache。
5. 仅归档变化时只发 Board `tasks.changed`。

不能让 Git 归档变化推进 Agent 的活动 `revision`，否则每次定时拉取都会让客户端误以为活动任务变化。

## 8. 失败与资源控制

必须处理：

- Git/SSH 可执行文件不存在。
- 凭据解密失败。
- SSH host key 变化。
- HTTPS 证书失败。
- branch 被删除。
- 网络超时。
- fetch 输出或对象数量过多。
- 单文件超限、非 UTF-8、非法路径。
- SQLite busy、索引投影失败。

失败策略：

- 保留最后成功 archive 快照。
- 不删除旧索引。
- 不推进 archive revision。
- 记录脱敏错误和退避时间。
- 管理页可手动重试。

## 9. 资源预期

当前最大单项目 archive 约 1,615 个正文文件、3.36 MiB 级别。`blob:none` partial clone 使常规 fetch
主要传输 commit/tree 元数据，archive blob 才按需下载。

风险主要来自：

- 第一次建立 bare cache。
- Git 托管端响应慢。
- 大型 ref/object 传输。
- archive 内容整体变化时的一次 SQLite 事务。

因此需要：

- 单 taskSpace 串行，同 project 的 branch 可受控并行。
- 全局并发上限。
- 超时、输出上限和对象数量上限。
- 无变化 no-op。
- 增量 ref 缓存。

### 9.1 taskSpace 失败日志

现有 `sanitizeDiagnosticText()` 已覆盖：

- PEM 私钥块。
- GitHub/GitLab/Slack Token 和 JWT。
- Authorization / Cookie。
- token/password/secret/private_key 等键值。
- Windows/POSIX 绝对路径。

依据：

- `packages/server/team/error-diagnostics.js:18`
- `packages/server/team/error-diagnostics.js:92`

因此归档同步失败日志复用该函数，并在 SQLite 中按 taskSpace 保留有界历史：

- 每个 taskSpace 最近 100 条。
- 记录 fetch/import/index 阶段、error code、摘要、详情、尝试时间。
- system admin 分页读取。
- 成功不写日志表，只更新 `last_indexed_at`。

## 10. 主要未决技术验证点

这些在实现计划中通过测试解决，不阻塞 MVP 产品范围：

- `git cat-file --batch` 在 Windows 下的大批量流式解析性能。
- 临时 SSH 私钥在当前 Windows OpenSSH 版本上的 ACL 兼容性。
- 现有 `runProcess()` 是否支持 AbortSignal 和服务关闭时终止子进程，若不足需做最小扩展。
- `ssh-keyscan` 在企业网络/DLP 环境中的可用性；不可用时提供管理员粘贴指纹/known_hosts 的受控回退。
