# 支持从 env 配置初始管理员账号密码

## Goal

修改 Team Server 初始启动配置：支持从环境变量（含仓库根 `.env` 文件）读取初始系统管理员用户名和密码，并提供默认用户名 `admin` 与默认密码 `123456!@#$%^`。首次启动且数据库中尚无有效系统管理员时自动创建该管理员账号，免去必须先手工运行 `cli.js init-admin` 才能启动服务的前置步骤。

## Background & Anchors

- 入口加载顺序：[packages/server/index.js](packages/server/index.js#L1-L19) 首行导入 [packages/server/env-bootstrap.js](packages/server/env-bootstrap.js#L1-L4)，经由 [packages/server/env-file.js](packages/server/env-file.js#L8-L18) 使用 `dotenv`（`^17.4.2`）加载仓库根 `.env`；进程环境变量优先于 `.env`。
- 配置解析：[packages/server/config.js](packages/server/config.js#L118-L143) 的 `parseTeamConfig(env)` 负责解析服务端 Team 配置，环境变量沿用 `TRELLIS_BOARD_*` 前缀。
- 启动鉴权门禁：[packages/server/team/http.js](packages/server/team/http.js#L349-L355) 在 `createTeamRuntime` 中校验 `requireAdmin && !hasActiveAdmin(db)`，当前会直接抛出 `503 AUTH_REQUIRED`。
- 账号创建与校验：[packages/server/team/auth.js](packages/server/team/auth.js#L81-L110) 定义 `normalizeUsername`（3-64 位 ASCII 字母、数字、`.`、`_`、`-`，转小写）与 `validatePassword`（6 字符至 1024 字节）；`createUser` 位于 [packages/server/team/auth.js](packages/server/team/auth.js#L204-L261)。
- 强制改密拦截：[packages/server/team/http.js](packages/server/team/http.js#L161-L170) 对 `mustChangePassword: true` 的账号仅放行 `/api/auth/password` 与 `/api/auth/logout`。
- 环境模板与文档：仓库根 [.env](.env)（已入库）、[.env.example](.env.example)、[packages/server/team/cli.js](packages/server/team/cli.js#L148-L163)、[README.md](README.md#L180-L189)、[docs/team-operations.md](docs/team-operations.md#L25-L97)。

## Requirements

### R1. 环境变量读取与默认值解析

- 在 [packages/server/config.js](packages/server/config.js) 中定义并导出默认初始管理员常量：`admin` 与 `123456!@#$%^`。
- `parseTeamConfig(env)` 读取以下环境变量并产出 `initialAdmin: { username, password }`：
  - `TRELLIS_BOARD_ADMIN_USERNAME`：未设置或空白字符串时回退为 `admin`；使用 `normalizeUsername` 规范化并校验格式。
  - `TRELLIS_BOARD_ADMIN_PASSWORD`：未设置或空字符串 `''` 时回退为 `123456!@#$%^`；使用 `validatePassword` 校验合法性。
- 当环境变量提供非法用户名或非法密码时，`parseTeamConfig(env)` 立即抛出明确的中文校验错误，且错误信息不得包含明文密码。
- 命令行/进程环境变量自动优先于 `.env` 文件中的值（复用现有 `loadProjectEnv` 机制）。

### R2. 服务端首次启动自动初始化管理员

- 在 [packages/server/team/http.js](packages/server/team/http.js) 的 `createTeamRuntime` 中，当 `requireAdmin` 为 `true` 且 `!hasActiveAdmin(db)` 时：
  - 若 `config.initialAdmin` 存在，则自动调用 `createUser` 创建初始系统管理员：`username = config.initialAdmin.username`、`displayName = config.initialAdmin.username`、`password = config.initialAdmin.password`、`systemAdmin = true`、`mustChangePassword = true`。
  - 创建成功后记录结构化信息日志（仅包含 `userId`、`username`、`mustChangePassword`，严禁输出密码明文）。
  - 若 `config.initialAdmin` 未提供，保持原有 `503 AUTH_REQUIRED` 报错行为。
- 幂等保护：若数据库已存在有效系统管理员（`hasActiveAdmin(db) === true`），启动时直接跳过初始化，不创建新账号、不修改已有管理员密码或状态。
- 冲突保护：若数据库无有效系统管理员，但目标 `username` 已被已有账号（如已禁用或普通账号）占用，启动因 `createUser` 冲突报错中止，不静默提权或覆盖密码。

### R3. `.env` / `.env.example` 与文档同步

- 仓库根 [.env](.env) 显式写入默认值：
  - `TRELLIS_BOARD_ADMIN_USERNAME=admin`
  - `TRELLIS_BOARD_ADMIN_PASSWORD='123456!@#$%^'`（使用单引号包裹，避免 `dotenv` 将 `#` 解析为行内注释导致密码被截断）
- 仓库根 [.env.example](.env.example) 同步补充这两个配置项、默认值及含 `#` 等特殊字符需加引号的注释说明。
- 更新 [packages/server/team/cli.js](packages/server/team/cli.js) 的环境变量帮助文案，以及 [README.md](README.md) 和 [docs/team-operations.md](docs/team-operations.md) 中首次部署与环境变量说明（保留 `cli.js init-admin` 说明作为可选手动方式）。

## Out of Scope

- 不修改或移除 `packages/server/team/cli.js init-admin` 既有手工初始化命令及行为。
- 不支持通过修改 `.env` 在重启时覆盖或重置已存在系统管理员的密码。
- 不修改数据库表结构（SQLite schema 保持不变）。
- 不修改前端登录/改密页面逻辑（前端已原生支持 `mustChangePassword` 流程）。

## Acceptance Criteria

- [ ] 未配置 `TRELLIS_BOARD_ADMIN_USERNAME` 与 `TRELLIS_BOARD_ADMIN_PASSWORD`（或值为空串）时，`parseTeamConfig` 返回默认初始管理员 `{ username: 'admin', password: '123456!@#$%^' }`。
- [ ] 配置了自定义 `TRELLIS_BOARD_ADMIN_USERNAME` 与 `TRELLIS_BOARD_ADMIN_PASSWORD`（通过 `.env` 或进程环境变量）时，`parseTeamConfig` 正确读取且进程环境变量优先于 `.env`；带单引号的 `'123456!@#$%^'` 经 `loadProjectEnv` 解析后完整保留 `#` 及后续字符。
- [ ] 配置非法用户名（如长度 < 3 或含非法字符）或非法密码（如长度 < 6）时，`parseTeamConfig` 抛出校验错误且错误文案不含明文密码。
- [ ] 全新空库以 `requireAdmin: true` 启动 `createTeamRuntime` 时，自动创建系统管理员且无需预先运行 `cli.js init-admin`；可用该账号密码通过 `POST /api/auth/login` 登录，返回的 `user.systemAdmin === true` 且 `user.mustChangePassword === true`，首次访问受保护接口返回 `403 PASSWORD_CHANGE_REQUIRED`，调用 `POST /api/auth/password` 改密后恢复正常访问。
- [ ] 数据库已有有效系统管理员时再次启动服务（即使 env 中更换了用户名或密码），不会创建第二个初始管理员，也不会覆盖既有管理员密码。
- [ ] 数据库无有效系统管理员但目标用户名已被禁用/非管理员账号占用时，启动明确失败报错且不提权、不覆盖原账号密码。
- [ ] 仓库根 `.env` 与 `.env.example` 包含正确的默认配置及引号，实际通过 `loadProjectEnv()` 加载仓库根 `.env` 后解析到的默认管理员为 `admin` / `123456!@#$%^`。
- [ ] `yarn test` 与 `yarn format:check` 全部通过。
