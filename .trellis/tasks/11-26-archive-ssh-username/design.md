# SSH 用户名持久化设计

## Architecture

归档 SSH 登录用户名复用 `sync_archive_git_credential.username`，不需要 schema 迁移。用户名属于公开配置，私钥仍只保存在加密 payload 中。

```text
管理页 SSH 用户名
  -> POST/PATCH /api/admin/archive-sync/credentials
  -> sync_archive_git_credential.username
  -> resolveForRemote().credential.username
  -> 临时 ssh wrapper: -o User=<username>
  -> Git fetch / ls-remote
```

## Boundaries

- `packages/server/team/archive-git-credentials.js`：SSH 用户名校验、默认值、更新语义，以及生成临时 SSH wrapper 时显式传入用户。
- `packages/web/src/features/admin/ArchiveSyncTab.tsx`：SSH/HTTPS 共用用户名输入；新增 SSH 默认 `git`。
- `packages/web/src/features/admin/archive-sync-format.ts`：凭据草稿默认值和编辑态回填。
- `packages/web/src/api/admin/*`：请求和归一化模型已包含 `username`，只补类型使用和双向透传，不新增 API 路径。
- `packages/server/test/archive-git-credentials.test.js`：默认值、自定义值、存量空值兼容和 SSH 命令参数。
- `docs/team-operations.md` 与后端 spec：记录 SSH 用户持久化在凭据中，不依赖容器 SSH 配置。

## Contracts

- SSH 凭据 API 的 `username` 为可空字符串；创建时缺省或空值归一为 `git`，显式值去除首尾空白后保存。
- HTTPS 用户名行为保持现状：缺省 `x-access-token`，仍可自定义。
- 已有 SSH 行 `username IS NULL` 不批量改库；运行时以 `credential.username || 'git'` 兼容，后续编辑或轮换时自然写入 `git`。
- SSH wrapper 使用 `-o User=<quoted username>`；用户名不拼接进远端 URL，因此现有 remote identity、项目去重和 taskSpace 不变。
- `identity`、`known_hosts`、`GIT_SSH_COMMAND`、`BatchMode`、`IdentitiesOnly` 和临时目录清理边界保持不变。

## Validation

- 用户名使用现有文本边界：去空白、非空、最长 200 字符、无 NUL/换行；SSH 允许常见字符
  `A-Z a-z 0-9 . _ @ + -` 且不能以 `-` 开头，写入脚本时再按平台 shell 规则引用。
- 同一 `scheme + host + port` 唯一约束不变；用户名不是凭据来源键。
- 进程输出继续对私钥和 Token 脱敏；用户名可作为公开配置展示，但写入 shell 包装脚本前必须安全引用。

## Compatibility

- 无数据库迁移，无数据删除，无 taskSpace 重建。
- 新版本读取旧行的空用户名时默认 `git`，所以容器重建后无需 `/root/.ssh/config`。
- 旧版本若回滚，会忽略 SSH `username` 列；数据库仍可被旧版本读取，但会重新依赖进程 SSH 用户。

## Operations

- 部署只需更新服务端和前端静态产物；不得在镜像或运行容器中生成 `/root/.ssh/config`。
- 验收使用现有 `wit-ci` 凭据执行“测试 + 立即同步”，失败日志不应再出现 `root@... Permission denied (publickey)`。
- SSH 私钥已有截图暴露风险，本任务不负责轮换；上线前应按安全流程撤销并替换 Deploy Key。
