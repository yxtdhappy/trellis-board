# 团队运行数据外移与 .trellis 稀疏项目接入设计

## 1. 总体决策

- 运行数据根从源码目录迁出，支持 `TRELLIS_BOARD_DATA_DIR` 覆盖。
- 默认目录按平台解析，不依赖 Windows 盘符：
  - Windows：`%LOCALAPPDATA%\TrellisBoard\server`
  - macOS：`~/Library/Application Support/TrellisBoard/server`
  - Linux：`${XDG_DATA_HOME:-~/.local/share}/TrellisBoard/server`
- Ubuntu 部署在环境中显式设置 `/var/lib/trellis-board`，该目录由持久卷提供。
- 远端当前历史和后续提交均不包含 `data/` 路径。示例配置迁移到 `config/examples/`。
- 团队项目使用 partial clone + non-cone sparse checkout，工作副本只检出 `.trellis/`。
- 目标分支没有 `.trellis/` 时，服务端调用固定版本的本地 Trellis CLI 自动初始化，提交并推送后再收敛为 `.trellis` 稀疏检出。
- Agent 工具和首个负责人在“新增项目”表单确定；工具多选且默认不预选，负责人信息传给 `trellis init -u`。

## 2. 运行数据目录与迁移

### 2.1 路径所有者

在 `server/config.js` 增加纯函数：

```text
resolveBoardDataDir({ platform, env, homeDir, appDir }) -> absolute path
```

解析优先级：

1. 非空 `TRELLIS_BOARD_DATA_DIR`，使用 `path.resolve()`。
2. Windows：`LOCALAPPDATA/TrellisBoard/server`。
3. macOS：`homeDir/Library/Application Support/TrellisBoard/server`。
4. Linux：`XDG_DATA_HOME/TrellisBoard/server`，未设置时使用 `homeDir/.local/share/TrellisBoard/server`。

`dataDir`、`databaseFile` 和旧 JSON 路径继续由 `server/config.js` 导出，但全部基于新根目录。另导出 `legacyDataDir = <appDir>/data`，仅用于一次性迁移和禁用检查。

### 2.2 启动迁移

新增 `server/data-migration.js`，由 `server/index.js` 和 `server/team/cli.js` 在打开数据库、初始化 Git 管理器之前同步调用。`openDatabase()` 被测试显式传入临时路径时不得触发真实环境的迁移。

迁移步骤：

1. 源目录和目标目录相同则跳过。
2. 目标目录已存在 `board.sqlite` 则视为已完成，不再复制旧数据。
3. 在目标目录同级创建随机 staging 目录。
4. 只复制已知运行数据：
   - `board.sqlite`、`board.sqlite-wal`、`board.sqlite-shm`
   - `git-credentials.key`
   - `repos.json`、`task-metadata.json`、`scan-cache.json`、`board-state.json`
   - `plugins.json`、`plugins.secrets.json`、`plugins/`
   - `backups/`、`projects/`
5. 不复制 `.git-auth/`、`.empty-git-hooks/`、示例 JSON 或未知文件；这些由新位置重新生成或从源码迁移。
6. 若 staging 中存在数据库，打开 staging 数据库并把所有位于旧 `data/projects/` 下的 `repositories.path` 重写为新的 `projects/<workspace_key>`；同时重算 `path_key`。
7. 校验数据库可打开、路径存在、计数与源库一致，再把 staging 原子重命名为最终数据根。
8. 成功后只删除源目录中的已迁移运行数据；失败时保留源目录并删除 staging，启动报错，不允许带着部分数据继续运行。

不支持旧、新数据库同时存在且目标数据库已存在时的隐式合并；返回明确错误，要求人工确认。

### 2.3 示例文件

- `data/repos.example.json` → `config/examples/repos.json`
- `data/plugins.example.json` → `config/examples/plugins.json`
- `data/plugins.secrets.example.json` → `config/examples/plugins.secrets.json`
- 删除 `data/.gitignore`，根 `.gitignore` 增加 `/data/` 防复发规则。
- README、运维文档和测试夹具同步使用新示例路径。

## 3. SQLite schema v8

`team_project` 增加：

```sql
agent_tools_json TEXT NOT NULL DEFAULT '[]'
bootstrap_lead_user_id TEXT
bootstrap_lead_trellis_dev_id TEXT
```

- `agent_tools_json` 保存已校验的工具 ID 数组，用于审计、批准和历史显示。
- 两个 bootstrap 字段保存“新增项目”阶段选定的负责人，批准接口必须与它们一致。
- 旧项目默认空数组和空负责人；批准旧 provisioning 项目时继续接受请求中的负责人字段作为兼容回退。
- 数据库版本升至 8；v6/v7 升级前分别生成 `board.sqlite.pre-v8.*` 备份。v8 重复打开必须幂等。

## 4. Agent 工具契约

新增无 Node/DOM 依赖的 `shared/trellis-agent-tools.js`：

```js
export const TRELLIS_AGENT_TOOLS = [
  { id: "codex", flag: "--codex", label: "Codex" },
  ...
]
export function normalizeTrellisAgentTools(value) -> string[] | throws
```

- 工具 ID 是 API 和数据库的稳定标识；CLI flag 只由服务端目录映射产生。
- 支持当前 Trellis CLI 的非弃用工具：Cursor、Claude Code、OpenCode、Codex、Kilo、Kiro、Gemini、Antigravity、Devin、Qoder、CodeBuddy、Copilot、Droid、DSH、Pi、Reasonix、ZCode、OMP、Trae、Grok、Kimi、Snow。
- 拒绝空数组、未知 ID、重复 ID、非字符串和非数组输入。
- 前端通过 `@shared/trellis-agent-tools.js` 渲染多选下拉，不硬编码第二份工具列表。

## 5. Git 稀疏检出与自动初始化

### 5.1 新项目 clone

`createGitManager()` 新增统一工作流：

```text
cloneForTeam(project, credential, { agentTools, leadTrellisDevId })
```

1. `git clone --filter=blob:none --no-checkout --branch=<syncBranch> --single-branch -- <remote> <target>`。
2. `git sparse-checkout init --no-cone`。
3. `git sparse-checkout set .trellis`。
4. 检出共享分支。
5. 使用 `git cat-file -e HEAD:.trellis` 或等价树查询判断远端是否已有目录。

已有 `.trellis/` 时直接进入工具链校验。目标分支不存在目录时：

1. 保持业务源码为空，只运行 Trellis 初始化。
2. 使用项目内置依赖的固定 CLI：

```text
node node_modules/@mindfoldhq/trellis/bin/trellis.js init -y --skip-existing <selected flags> -u <leadTrellisDevId>
```

3. 设置 180 秒超时、最小环境、`NO_COLOR=1`，不执行目标仓库 hooks。
4. 校验 `.trellis/scripts/task.py`、`.trellis/workflow.md`、`.trellis/workspace/<leadTrellisDevId>`。
5. 读取 `.trellis/.template-hashes.json`，确认非 `.trellis` 变更属于 `AGENTS.md`、`.gitattributes` 或初始化清单；出现其他路径立即失败。
6. 提交全部已确认的初始化产物，提交者使用现有服务身份，消息为 `trellis(team): initialize Trellis workspace`。
7. 非强制推送 `HEAD:<syncBranch>`；非快进时只允许一次 fetch + rebase 重试，冲突则清理项目并返回可恢复错误。
8. 推送成功后重新应用 `.trellis` sparse pattern，确保业务源码不留在工作副本。

### 5.2 已有项目迁移

启动后对已接入项目执行受控 `ensureSparseTrellis()`：

- 工作副本不干净、分支不匹配或仓库损坏时标记 `needs_repair`，不自动删除文件。
- clean 项目执行 `git sparse-checkout init --no-cone` 和 `git sparse-checkout set .trellis`。
- 完成后确认工作副本只剩 `.trellis/**`；失败记录 `last_error`，项目停止写任务。

### 5.3 依赖

根 `package.json` 将 `@mindfoldhq/trellis` 固定到当前兼容版本并使用本地 bin 调用，避免 Ubuntu 部署依赖全局 npm 安装。测试向 Git 管理器注入 `trellisRunner`，不依赖测试机全局 CLI。

## 6. 项目接入 API

`POST /api/admin/projects` 请求新增：

```json
{
  "agentTools": ["codex", "opencode"],
  "leadUserId": "uuid",
  "leadTrellisDevId": "yhj"
}
```

服务端在任何 clone 或子进程前校验：

- `agentTools` 非空且全部在共享目录内。
- `leadUserId` 是 active 用户并属于目标团队。
- `leadTrellisDevId` 符合现有 developer ID 规则。

响应继续返回 `project` 和 `approval`。`project` 增加 `agentTools` 与 bootstrap 负责人字段，供批准页只读展示。

`POST /api/admin/projects/:id/approve`：

- 新项目的负责人必须与 bootstrap 字段一致。
- 旧项目缺少 bootstrap 字段时允许沿用当前请求负责人，保持兼容。
- 批准仍执行工具链摘要、hooks 预检和负责人 workspace 校验。

## 7. 前端交互

新增 `MultiSelectField` 领域组件，使用现有 Dropdown Menu 和 Checkbox Item 原语：

- 触发器显示已选数量及工具名称摘要。
- 下拉项可多选，提交中禁用。
- 支持键盘操作、`aria-label`、空选择提示，不写死颜色。

“新增或升级项目”表单增加：

- Agent 工具多选，默认不选择，至少选择一项后才能提交。
- 首个负责人下拉。
- 负责人 Trellis developer ID 输入。
- 提交按钮文案改为“克隆、初始化并检查工具链”。

批准面板复用 bootstrap 负责人和工具数据：

- 新项目只读展示负责人、developer ID、Agent 工具。
- 旧 provisioning 项目继续显示现有可编辑负责人表单。

## 8. 远端历史清理

在功能代码完成、测试通过并形成本地提交后执行：

1. 创建本地 mirror 和 bundle 备份。
2. 使用 Git 内置历史重写从所有 refs 删除 `data/`。
3. 清理 `refs/original`、reflog 和不可达对象。
4. 对 `origin/codex/team-board` 使用 `--force-with-lease` 推送。
5. 在全新临时克隆验证：

```text
git log --all --name-only --pretty=format: | rg '^data/'
git ls-tree -r origin/codex/team-board -- data
```

两个命令均不得有输出。

GitHub 可能在其他分支、PR 缓存或内部对象回收周期中暂时保留旧对象；交付报告明确“远端可达历史已清除”，不声称存储介质立即物理擦除。

## 9. 错误与回滚

| 条件 | 行为 |
| --- | --- |
| 数据迁移复制失败 | 保留旧 data，删除 staging，启动失败 |
| 新数据目录已有数据库 | 不覆盖，要求人工确认 |
| 项目路径重写后目录缺失 | 保留旧数据，启动失败 |
| 工具为空或未知 | 400，不 clone |
| 负责人无效或不属于团队 | 400/403，不 clone |
| CLI 缺失或初始化失败 | 503/409，删除本次全新 clone |
| 初始化文件越界 | 409，删除本次 clone，不推送 |
| 初始化推送冲突 | 一次性 rebase 重试，仍失败则返回可恢复错误 |
| 既有项目转稀疏失败 | `needs_repair`，保留现场供管理员修复 |

回滚代码不会自动回滚已经推送的 Trellis 初始化提交；数据目录回滚需停止服务并恢复旧数据库、WAL、SHM、密钥和项目目录。

## 10. 验证设计

- 纯函数测试覆盖 Windows/macOS/Linux/环境变量路径。
- 迁移测试覆盖仅复制运行数据、staging 失败回滚、数据库路径重写、旧数据保留。
- schema 测试覆盖 v7→v8、新列默认值、幂等升级和备份。
- Git 测试覆盖已有 `.trellis` 的稀疏 clone、缺目录自动初始化、文件越界拒绝、推送失败清理。
- API 测试覆盖工具/负责人校验、bootstrap 与批准一致性、旧项目兼容。
- 前端构建与浏览器测试覆盖多选、负责人前移、初始化进度和错误展示。
- 最终在临时远端仓库完成“无 .trellis → 自动初始化 → push → 只检出 .trellis”的 E2E。
