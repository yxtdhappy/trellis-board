# 技术设计：Git 凭据管理与项目远端自动识别

## 1. 目标与边界

- 团队管理员维护多套可复用的 HTTPS/SSH Git 凭据，项目只能引用同团队、同主机、同认证类型的凭据。
- Git 凭据只由 Board 服务端使用，绝不下发浏览器或桌面 Agent。
- 项目接入通过显式“识别远端”动作读取真实默认分支和 remote heads，不创建工作副本。
- 已有无凭据项目保持兼容；新增字段可为空。

## 2. 现有边界与复用点

- Git URL 规范化和分支格式校验继续复用 `normalizeGitRemote()`、`assertValidBranch()`：[git-manager.js](../../../server/team/git-manager.js:48)。
- 项目接入、克隆和团队权限继续由 `createProjectService()` 与 `requireTeamAdmin()` 持有：[projects.js](../../../server/team/projects.js:127)、[http.js](../../../server/team/http.js:326)。
- 子进程继续使用无 shell 的 `runProcess()`，并补充输出截断标记和显式敏感值脱敏：[process.js](../../../server/team/process.js:61)。
- 前端继续使用 `api/admin.ts -> useAdminConsole/useAdminProjects -> features/admin` 的单一数据流。
- 现有 `team_project` 不记录认证来源；访问私有 HTTPS 时 credential helper 被禁用，SSH 只能依赖服务进程默认身份和 `known_hosts`。

## 3. 数据模型

数据库 schema 从 `v6` 升到 `v7`，只做附加式迁移。

### `git_credential`

| 字段 | 约束与含义 |
| --- | --- |
| `id` | UUID 主键 |
| `team_id` | 必填，引用 `team(id)`，凭据按团队隔离 |
| `name` | 团队内不区分大小写唯一，1–80 字符 |
| `host` | 规范化小写主机名，不含协议、用户名、路径和端口 |
| `auth_type` | `https_token` 或 `ssh_key` |
| `username` | HTTPS 必填；SSH 为空 |
| `public_key_fingerprint` | SSH 可展示的 SHA256 指纹；HTTPS 为空 |
| `secret_version` | 加密载荷格式版本，首版为 `1` |
| `secret_iv` / `secret_tag` / `secret_ciphertext` | AES-256-GCM 的随机 IV、认证标签和密文 |
| `created_by` / `updated_by` | 账号 ID |
| `created_at` / `updated_at` | ISO 时间 |

加密载荷是 JSON：

- `https_token`: `{ "token": "..." }`
- `ssh_key`: `{ "privateKey": "...", "passphrase": "..." }`

凭据主机和认证类型创建后不可修改；录入错误或确需换主机时删除未引用记录后重新创建。名称、HTTPS 用户名和密钥材料可更新；更新时秘密字段留空表示保持原值。

### `git_ssh_known_host`

| 字段 | 约束与含义 |
| --- | --- |
| `team_id` | 团队隔离 |
| `host` / `port` | 规范化主机与 SSH 端口 |
| `algorithm` / `key_base64` | 主机公钥算法和公钥体 |
| `fingerprint_sha256` | OpenSSH SHA256 指纹 |
| `known_hosts_line` | 严格校验时写入临时 `known_hosts` 的完整行 |
| `trusted_by` / `trusted_at` | 首次或变更后确认人及时间 |

主键使用 `(team_id, host, port, algorithm, key_base64)`。同一团队同一主机端口出现不同公钥时不得覆盖，必须走“主机密钥变化”确认流程。

### `team_project.git_credential_id`

- 新增可空列，引用 `git_credential(id) ON DELETE RESTRICT`。
- `NULL` 表示无需服务端凭据；已有项目迁移后保持 `NULL`，行为与当前版本一致。
- 项目引用凭据时，主机和认证类型必须与 `remote_url` 一致。

## 4. 主密钥与加密

- 数据目录新增 `git-credentials.key`，保存 32 字节随机二进制主密钥。
- 首次创建凭据时用 `wx` 原子创建，POSIX 权限 `0600`；Windows 依赖数据目录继承 ACL，并在运维文档和风险说明中注明。
- 数据库已有凭据但密钥缺失、长度错误或无法解密时返回 `GIT_CREDENTIAL_KEY_MISSING` / `GIT_CREDENTIAL_DECRYPT_FAILED`，禁止静默生成新密钥。
- 使用 `AES-256-GCM`，每次写入生成 12 字节随机 IV，AAD 绑定 `git-credential:<id>:v1`。
- `data/` 备份必须同时包含 SQLite 与主密钥；没有主密钥的数据库备份不能恢复 Git 凭据。
- HTTPS Token 和 SSH 口令只作为短生命周期变量传给 Git 子进程环境，不进入命令行参数、日志或错误详情；SSH 私钥仅在操作级临时文件中短暂存在并在 `finally` 中删除。

## 5. 凭据服务与权限

新增 `server/team/git-credentials.js`：

- `list(actor, teamId)`：只返回元数据、认证类型、主机、引用项目数和引用项目摘要。
- `create(actor, input)`、`update(actor, id, input)`、`remove(actor, id)`：均通过团队管理员权限。
- `resolveForRemote(actor, { teamId, credentialId, remoteUrl })`：校验团队、认证类型和主机匹配后返回内存中的解密载荷。
- `resolveForProject(project)`：内部刷新、推送和探测使用，不经过前端。
- 删除前查询 `team_project.git_credential_id`；有引用时返回 `409 GIT_CREDENTIAL_IN_USE`，并附引用项目名称。
- 审计动作使用 `git_credential_created`、`git_credential_updated`、`git_credential_deleted`、`git_ssh_host_trusted` / `git_ssh_host_replaced`；只记录主机、类型、名称和变更字段，不记录秘密。

系统管理员可跨团队管理；团队管理员只能管理自己担任 `admin` 的团队。项目使用凭据时再次校验凭据团队等于项目团队。

## 6. Git 认证注入

扩展 `createGitManager({ db, config, dataDir, credentialService })`，所有远端 Git 操作接收可选 `credentialId`。

### HTTPS

- 保留 `credential.helper=`，避免读取系统 credential store。
- 生成不含秘密的临时 askpass 包装脚本，由 Node helper 根据提示输出用户名或 Token。
- 用户名与 Token 仅放在子进程环境；`GIT_ASKPASS_REQUIRE=force`，结束或失败后清理临时目录。
- HTTPS 凭据禁止用于 SSH/local remote，反向同理。

### SSH

- 私钥材料写入随机临时目录中的临时文件；POSIX 权限 `0600`，Windows 限制在应用数据目录。
- 从 `git_ssh_known_host` 生成操作级临时 `known_hosts`，使用 `StrictHostKeyChecking=yes`、`IdentitiesOnly=yes`，不读取无关全局身份。
- 有私钥口令时通过 askpass 环境传递，不把口令放入命令参数。
- 每次操作在 `finally` 中清理私钥、known_hosts 和包装脚本；错误信息传播前按已知秘密值再次脱敏。

### 无凭据项目

- 继续走当前行为：HTTPS 只能访问公开仓库，SSH 使用服务进程默认身份和系统 `known_hosts`。
- 新逻辑不能改变已有项目的默认同步结果。

## 7. 远端探测

新增 `POST /api/admin/projects/probe`：

```json
{
  "teamId": "t1",
  "remoteUrl": "https://github.com/example/repo.git",
  "credentialId": null
}
```

处理顺序：

1. `requireTeamAdmin()`。
2. `normalizeGitRemote()`，提取 `scheme`、`host`、`path`。
3. 若有 `credentialId`，通过 `credentialService.resolveForRemote()` 校验团队、主机和认证类型。
4. 应用进程内限流：同一用户 60 秒最多 5 次，同一用户最多 1 个并发，全局最多 4 个并发；超限返回 `429 GIT_REMOTE_PROBE_RATE_LIMITED`。
5. 执行 `git ls-remote --symref -- <normalizedUrl>`，超时 30 秒，输出上限 1 MiB；超限不得返回部分分支列表。
6. 解析 `refs/heads/*` 和 `ref: refs/heads/<name>\tHEAD`。
7. 返回推荐名称、默认分支、排序后的全部分支和使用的凭据元数据。

探测成功响应：

```json
{
  "remote": {
    "url": "https://github.com/example/repo.git",
    "scheme": "https",
    "host": "github.com"
  },
  "recommendedName": "repo",
  "defaultBranch": "main",
  "branches": ["main", "develop"]
}
```

- 推荐名称取规范化仓库路径最后一段，解码后去掉末尾 `.git`，截断到现有项目名称 80 字符限制。
- 有效 symbolic HEAD 只在目标分支也存在于 remote heads 时生效。
- 没有有效 symbolic HEAD 时 `defaultBranch=null`，前端不得猜 `main`/`master`。
- 没有 remote heads 时返回 `422 GIT_REMOTE_NO_HEADS`。
- 认证失败、不可达、仓库不存在或输出超限返回不同错误码，不返回包含秘密的原始命令。
- 探测不创建目录、不写数据库、不运行项目脚本，也不写审计；SSH 信任确认是唯一会写库的后续独立动作。

## 8. SSH 主机首次确认

使用托管 SSH 凭据且团队尚未信任目标主机时：

1. 服务端用参数数组执行 `ssh-keyscan -p <port> -T 10 <host>`，输出上限 256 KiB。
2. 在服务端内存中保存一次性 challenge：随机 ID、actor、team、host、port、凭据 ID、扫描到的公钥行和 SHA256 指纹，5 分钟后过期。
3. 探测返回 `409 SSH_HOST_UNTRUSTED`，响应只含 challenge ID、主机、端口和公钥指纹，不含可伪造的信任写入字段。
4. 前端显示指纹确认弹窗；确认后调用 `POST /api/admin/git-ssh-hosts/trust`，只提交 `challengeId`。
5. 服务端核对 challenge 的 actor/team，写入信任行和审计，消耗 challenge；前端自动重试探测。

已信任主机返回不同公钥时返回 `409 SSH_HOST_CHANGED`，需要新的替换 challenge 和明确确认，不得自动更新。

## 9. HTTP 契约

新增接口：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/admin/git-credentials?teamId=` | 凭据元数据与引用项目 |
| `POST /api/admin/git-credentials` | 创建凭据 |
| `PATCH /api/admin/git-credentials/:id` | 更新名称、用户名或秘密 |
| `DELETE /api/admin/git-credentials/:id` | 删除未被引用凭据 |
| `POST /api/admin/projects/probe` | 探测远端名称、默认分支和 heads |
| `POST /api/admin/git-ssh-hosts/trust` | 确认首次信任或明确替换 SSH 主机密钥 |
| `PUT /api/admin/projects/:id/credential` | 更换项目凭据，保存前验证远端访问 |

现有 `POST /api/admin/projects` 请求增加可选 `credentialId`。项目公开响应增加：

```json
{
  "credential": {
    "id": "credential-id",
    "name": "GitHub 运维账号",
    "host": "github.com",
    "authType": "https_token"
  }
}
```

凭据公开元数据只返回 `id`、`name`、`host`、`authType`、引用关系和时间；不返回 Token、私钥、口令或加密载荷。

## 10. 前端

### 凭据管理

- `AdminView` 增加 `git-credentials`，管理台增加“Git 凭据”页签。
- 新页签包含凭据表单和列表；系统管理员处于 `all` 团队范围时禁止新增/编辑，并提示先选择具体团队。
- 表单字段：名称、主机、认证类型、HTTPS 用户名/Token、SSH 私钥/可选口令。
- 编辑时秘密字段始终为空，占位说明“留空保持现有秘密”；主机与认证类型禁用。
- 列表显示名称、主机、类型、引用项目和更新时间，只提供编辑/删除，不提供查看或复制秘密。
- 删除被引用凭据时展示服务端返回的引用项目，并保留记录。

### 项目接入

- 表单第一行固定为 Git URL 输入框和右侧“识别远端”按钮。
- 第二行是 Git 凭据下拉框，默认“无需凭据（公开仓库）”，列出当前团队凭据。
- 其后为可编辑项目名称和共享分支下拉框；分支结果提供本地搜索过滤。
- 仅按钮点击触发探测。URL 或凭据变化时立即清空上一次探测结果；若项目名称来自自动回填则清空，用户手动修改过的名称保留。
- 探测成功自动回填项目名称和分支；无有效 symbolic HEAD 时只填充分支选项，必须手动选择。
- 请求期间禁用按钮并显示进度；迟到的旧请求响应通过请求序号丢弃。
- SSH 未信任/主机变化响应打开指纹确认弹窗；确认成功后自动重试一次探测。
- “克隆并检查工具链”仅在最近一次 URL + 凭据 + 分支探测有效时启用。

### 项目凭据更换

- 已接入项目行显示当前凭据名称，无凭据显示“无需凭据”。
- 增加“更换凭据”弹窗，选择同团队凭据或无需凭据；提交前服务端使用新选择访问现有远端，验证失败不更新项目。
- 该入口用于解除引用，使未被引用的凭据可以删除。

## 11. 兼容、迁移与回滚

- `v6 -> v7` 仅新增表、索引和可空列；迁移前复制数据库到 `data/backups/board.sqlite.pre-v7.<timestamp>`。
- 迁移在事务中执行，重复启动保持幂等；高于 `v7` 或迁移失败继续拒绝启动并保留原库。
- 已有项目 `git_credential_id=NULL`，不会因本功能突然改用其他凭据。
- 回滚应用时必须同时恢复 v6 数据库；主密钥文件可保留，旧版本会忽略。
- `data/git-credentials.key` 与数据库同目录是已接受风险：数据目录备份或泄露可同时获得密文和密钥，因此部署侧必须把 `data/` 视为高度敏感目录。

## 12. 验证策略

- 数据库：v6 到 v7 迁移、重复迁移、备份、外键与可空兼容。
- 加密：密钥只生成一次、密文不含明文、错误密钥/认证标签失败、密钥缺失时不静默重建。
- 凭据服务：团队隔离、主机/类型匹配、CRUD、引用阻止删除、秘密永不出现在公开结果和审计。
- 远端探测：HTTPS/SSH 名称推导一致、有效默认分支、无 symbolic HEAD、无 heads、输出超限、超时、认证失败、限流和迟到请求。
- SSH：首次 challenge、跨用户/团队 challenge 拒绝、确认后重试、主机密钥变化必须重新确认。
- 集成：真实本地 bare Git 仓库完成探测和项目接入；带认证夹具验证凭据环境不会进入命令行或日志。
- 前端：API 类型、表单失效逻辑、秘密不回显、SSH 指纹弹窗和错误保留输入。
- 最终执行一次 `npm test`，再执行一次 `npm run build`；随后启动真实服务做管理员凭据管理和项目接入浏览器 E2E。
