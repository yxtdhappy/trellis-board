# 客户端 workspace 初始化技术设计

## 1. 边界与目标

- 本任务交付两段可独立验证的能力：服务端团队模板分发接口，以及客户端本地 workspace 初始化模块。
- 服务端只负责**读取并鉴权分发已提交的静态模板**，不执行模板、不写数据库、不提供上传接口。
- 客户端只负责**校验、缓存、安全解包和本地写入**；不自动 `git init`、不访问模板清单之外的服务端地址、不执行模板内任意脚本。
- desktop 壳与目录选择器属于 `11-05-desktop-client-package`；本任务提供 Node 模块和 Node 测试，供 desktop 后续接入。

## 2. 模板资产与版本

固定资产提交在 `server/templates/workspace/`：

| 文件 | 说明 |
| --- | --- |
| `workspace-template.zip` | 团队统一模板归档，包含 `.trellis`、`.opencode`、`.agents`、`.codex`、`AGENTS.md`、`.gitattributes` 和包内 `template-manifest.json` |
| `manifest.json` | 服务端权威清单：版本、默认/可选工具、SHA-256、字节数、文件哈希表 |

- 归档来源：本机 `trellis init -y --opencode --codex -u template-user`（CLI `0.6.16`）产物，已删除 `.trellis/.developer`、`.trellis/workspace` 和任务内容。
- 清单版本 `0.6.16-template-1`，`cliVersion` 记录 `0.6.16`，`projectVersion` 记录项目基线 `0.6.17`。
- 目标机不需要全局 `trellis` CLI；即使安装的是 `0.6.16` 或其他版本，初始化结果只取决于服务端模板。
- 版本差异是显式记录项：`.trellis/.version` 来自模板（`0.6.16`），项目要求 `0.6.17`；客户端把模板版本写入 `.trellis/.template-hashes.json` 并在结果中返回，升级模板必须发布新的归档、版本号和哈希，客户端按内容寻址缓存，不静默覆盖旧缓存。
- 归档内的 `template-manifest.json` 供离线选择工具使用；服务端 `manifest.json` 供前端展示和诊断，两者版本与 SHA-256 必须一致。

## 3. 服务端 API

新增 `server/team/workspace-templates.js`，从静态目录懒加载归档并在首次读取时校验清单哈希。

| 方法与路径 | 权限 | 响应 |
| --- | --- | --- |
| `GET /api/teams/:teamId/workspace-template` | 登录会话或 Agent Bearer，且为目标团队成员 | `application/zip` + `X-Template-SHA256` / `X-Template-Version` / `ETag` / `Content-Disposition` |
| `GET /api/teams/:teamId/workspace-template/manifest` | 同上 | `application/json` 清单 |
| `HEAD` | 同上 | 与 GET 相同头部，无正文 |

鉴权与授权规则：

- 先读会话 Cookie；没有会话时读取 `Authorization: Bearer <agent credential>` 并调用现有 `agentService.authenticate()`。
- 目标团队不存在 → 404；团队 `status='disabled'` → 403；非成员 → 403；系统管理员可跨团队，但仍要求团队存在且启用。
- 未携带任何有效凭证 → 401。Agent 凭证撤销/账号停用沿用现有 401。
- 只读接口，不写审计、不改数据库 schema、不做 multipart 上传。
- `If-None-Match` 匹配强 ETag（`"<sha256>"`）时返回 304。
- 缓存头使用 `private, max-age=0, must-revalidate`；不把团队模板打进公共静态目录。
- 路由注册在 `requireActor()` 之前，避免 Bearer 请求被会话校验拦截；不改变既有 `/api/agent/*` 路由。

## 4. 客户端模块

| 文件 | 职责 |
| --- | --- |
| `agent/zip.js` | 最小 ZIP 读取：中央目录解析、store/deflate、CRC-32、路径与条目类型校验、解包到临时目录 |
| `agent/workspace.js` | 路径校验、下载与缓存、SHA-256 校验、模板选择、合并/备份、developer 初始化、结果与错误码 |

公开入口：

- `initializeWorkspace(options)`：下载（或使用传入 bundle）并完成本地初始化。
- `applyWorkspaceTemplate(options)`：对已校验 bundle 执行写操作，供离线/测试复用。
- `downloadWorkspaceTemplate(options)`：下载、校验哈希、写入内容寻址缓存；网络不可达时回落到最近成功缓存。
- `loadCachedWorkspaceTemplate(options)` / `loadTemplateBundle(archive, options)`：缓存与原始归档入口。
- `assertWorkspaceDirectory(target)`：目录选择后的路径校验。

### 4.1 路径校验

写入前完成，失败不留任何文件：

- 必须是绝对路径，且不是文件系统根。
- 拒绝系统目录本身（POSIX：`/etc`、`/usr`、`/bin`、`/var`、`/tmp`、`/home` 等；Windows：盘符根、`C:\Windows`、`C:\Program Files`、`C:\ProgramData`、`C:\Users` 等），允许其子目录。
- 必须是已存在的目录；`lstat` 发现符号链接/重解析点直接拒绝；`realpath` 与选择路径不一致时拒绝（覆盖 junction/symlink 父级逃逸）。
- 在目标目录创建并删除唯一探针文件验证可写；探针创建失败即中止。
- 归档条目路径另行校验：拒绝绝对路径、盘符、UNC、反斜杠、`..`、`.` 段、控制字符、Windows ADS 冒号、尾随点/空格和重复条目。

### 4.2 下载与缓存

- 数据根由 `defaultAgentRoot()` 或显式 `dataRoot` 决定；缓存目录 `<dataRoot>/templates/workspace/`。
- 缓存按内容寻址：`<sha256>/template.zip` + `<sha256>/manifest.json`；`latest.json` 只在哈希校验和清单解析成功后原子更新。
- 下载使用 `fetch`（可注入），带 30 秒超时、32MB 响应上限；请求头只带会话 Cookie 或 Agent Bearer，不记录凭证。
- 响应必须带 `X-Template-SHA256`；客户端重新计算 SHA-256，与响应头及包内清单版本交叉校验。
- 网络错误或服务端 5xx（服务不可用）才回落缓存；401/403/404/4xx/哈希错误是终态，不掩盖权限或完整性问题。无缓存时返回明确的中断错误。

### 4.3 选择与合并

- 选择集 = 清单 `baseFiles`（`AGENTS.md`、`.gitattributes`、`.trellis`）+ 工具目录；默认工具固定 `.opencode`、`.agents`，可选 `.codex` 由调用方勾选。
- 归档先解包到 workspace 内的唯一临时目录，校验通过后再逐文件合并；完成后删除临时目录。
- 初始化模式：目标文件已存在一律跳过，不删除、不覆盖用户文件；缺失文件补齐。
- 修复模式（“初始化/修复 Agent 工具”）：只处理显式勾选的工具目录；同内容跳过，不同内容先复制到 `.trellis-backup-<timestamp>/<相对路径>` 再覆盖。
- `.trellis/.template-hashes.json` 由客户端生成，记录模板版本、归档 SHA-256、工具集合和已展开文件的哈希；已存在且内容不同时先备份再更新。
- 任何失败都回滚本次新建文件、恢复被覆盖文件并删除临时目录；不创建 `.git`、不执行 `git init`。

### 4.4 developer 初始化

- 用户名必须匹配服务端账号规则 `[A-Za-z0-9._-]{3,64}`，且不能是 `.`/`..`。
- 读取 `.trellis/.developer` 的 `name=`：
  - 不存在：调用 `.trellis/scripts/init_developer.py <username>`。
  - 已存在且同名：跳过，不重复追加 journal；仅补齐缺失的 `workspace/<name>/journal-1.md`、`index.md`。
  - 已存在且不同名：默认抛出 `DEVELOPER_CONFLICT` 并在写入前中止；仅 `confirmDeveloperSwitch: true` 时先备份 `.developer`，再移除并调用脚本。
- 调用脚本前预检 Python 3；缺失时返回可操作的错误。脚本以 `shell: false`、参数数组、固定相对路径执行，并设置 `PYTHONUTF8=1`、15 秒超时；stdout/stderr 不进入日志。
- 只执行这一个已知的 developer 初始化脚本；不执行归档内其他脚本。归档已通过 SHA-256 校验，脚本来自该归档。
- 完成后验证 `.developer` 名称、`journal-1.md` 和 `index.md` 存在；不匹配则视为失败。

### 4.5 日志与结果

- 日志只包含模板版本、哈希前缀、计数、`workspace` 基名或 `[workspace]`；不包含 token、Cookie、完整绝对路径。
- 结果包含：模板版本/哈希、来源（`network`/`cache`）、developer 名称、工具集合、创建/更新/跳过/备份数量、备份目录相对名、是否切换 developer、是否发生变化。
- 不返回或记录工作区内的 `.env`、凭证文件内容；初始化过程不读取这些文件。

## 5. 错误码

| 错误码 | 触发条件 |
| --- | --- |
| `WORKSPACE_PATH_INVALID` | 非绝对路径、根/系统目录、非目录、重解析点、路径逃逸 |
| `WORKSPACE_PATH_UNWRITABLE` | 探针写入失败 |
| `WORKSPACE_USERNAME_INVALID` | 用户名不符合账号规则 |
| `TEMPLATE_UNAVAILABLE` | 网络失败且无缓存 |
| `TEMPLATE_AUTH_FAILED` | 401/403 |
| `TEMPLATE_NOT_FOUND` | 404 |
| `TEMPLATE_HTTP_ERROR` | 其他非 2xx |
| `TEMPLATE_HASH_MISMATCH` | 响应头、缓存或调用方期望哈希不一致 |
| `TEMPLATE_INVALID` | 归档结构/清单/条目不安全或缺少必需目录 |
| `DEVELOPER_CONFLICT` | `.developer` 名称不同且未显式确认 |
| `PYTHON_MISSING` | 需要初始化 developer 但找不到 Python 3 |
| `DEVELOPER_INIT_FAILED` | 初始化脚本非零退出或结果校验失败 |

## 6. 测试

- `tests/team-workspace-template.test.js`：会话/Agent 下载、哈希头与 ETag/304、清单、非成员、停用团队、系统管理员跨团队、未登录。
- `tests/workspace-bootstrap.test.js`：真实模板空目录初始化、已有 `.trellis` 补齐且不覆盖、developer 冲突与确认切换、只读目录无半成品、zip slip/符号链接拒绝、哈希不匹配、离线缓存/无缓存中止、可选工具、二次幂等、不生成 `.git`。
- 测试使用 Node 内置 `node:test`，临时目录在 `finally` 清理，不引入第三方依赖。
- Linux 实机验证；Windows 的解包路径/重解析点分支按代码审查覆盖，报告中记录未实机验证。

## 7. 明确不做

- 模板上传、在线编辑、灰度/回滚。
- 旧版 `.trellis` 完整升级器。
- 自动安装 Python/Git。
- 自动 `git init`、创建远端或提交。
- 数据库 schema 变更。
