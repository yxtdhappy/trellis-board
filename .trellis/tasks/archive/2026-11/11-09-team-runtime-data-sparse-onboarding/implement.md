# 团队运行数据外移与 .trellis 稀疏项目接入实施计划

## 实施约束

- 使用现有 `codex/team-board` 分支完成；该分支是当前唯一远端分支，也是历史清理目标。
- 不修改无关工作区文件，不覆盖用户未提交的任务和 `data/projects` 现场。
- 开发过程中不执行构建；全部代码完成后只执行一次 `npm --prefix web run build`。
- 远端历史重写放在最后，前面所有代码、测试和文档必须先完成并形成可恢复备份。

## Step 1：迁移静态示例并建立防复发规则

文件：

- `data/repos.example.json` → `config/examples/repos.json`
- `data/plugins.example.json` → `config/examples/plugins.json`
- `data/plugins.secrets.example.json` → `config/examples/plugins.secrets.json`
- `.gitignore`
- `README.md`
- `docs/team-operations.md`

操作：

- 移动示例文件，内容保持不变。
- 删除 `data/.gitignore`；根 `.gitignore` 增加 `/data/`。
- 更新所有示例路径和备份说明。

验证：

- `rg -n "data/(repos|plugins).*example|data/plugins\\.json" README.md docs server tests`
- 仅允许出现“旧路径迁移/禁止使用”的说明，不再引用可执行的新默认路径。

## Step 2：跨平台数据根与一次性迁移

文件：

- `server/config.js`
- 新增 `server/data-migration.js`
- `server/index.js`
- `server/team/cli.js`
- 新增 `tests/data-migration.test.js`

操作：

- 实现 `resolveBoardDataDir()`，覆盖环境变量、Windows、macOS、Linux。
- 增加 `legacyDataDir`，保持为 `<appDir>/data`。
- 实现 staging 迁移、运行文件白名单复制、目标冲突拒绝、staging 失败回滚和源数据保留。
- 迁移后重写数据库中的受管项目路径。
- 在真实启动入口和 `init-admin/status` CLI 入口打开数据库前调用迁移。
- 不改变测试中显式数据库/数据目录的行为。

验证：

- 路径解析纯函数覆盖四个平台分支。
- 迁移测试断言示例文件不复制、未知文件不复制、旧源在失败时保留。
- 迁移测试断言 `projects/<workspace_key>` 与 `repositories.path` 一致。
- `node server/team/cli.js status` 在临时数据根可正常工作。

## Step 3：数据库 schema v8

文件：

- `server/database.js`
- `tests/database.test.js`
- `tests/plugin-store.test.js`

操作：

- `DATABASE_SCHEMA_VERSION` 更新为 8。
- 为 `team_project` 增加：
  - `agent_tools_json`
  - `bootstrap_lead_user_id`
  - `bootstrap_lead_trellis_dev_id`
- 支持 v6/v7 → v8，升级前生成 `board.sqlite.pre-v8.*` 快照。
- 无 `schema_version` 的新库直接创建 v8。
- 旧 v8 以及重复打开保持幂等。

验证：

- 更新表结构断言和精确列顺序断言。
- 增加 v7→v8 升级、备份文件、默认值、幂等打开测试。
- 保留 v5/更高未知版本拒绝测试。

## Step 4：固定 Trellis CLI 与共享工具目录

文件：

- `package.json`
- `package-lock.json`
- 新增 `shared/trellis-agent-tools.js`
- 新增 `tests/trellis-agent-tools.test.js`
- `web/vite.config.ts` / `web/tsconfig.app.json`（仅在本项目路径别名缺失时）

操作：

- 固定 `@mindfoldhq/trellis` 运行时依赖版本。
- 建立工具 ID、CLI flag、显示名唯一映射。
- 实现 `normalizeTrellisAgentTools()`，拒绝空值、未知值、重复值和非法类型。
- 前端复用同一共享模块，避免前后端枚举漂移。

验证：

- 测试所有 ID/flag 唯一，合法输入保序去重前先拒绝重复，未知值拒绝。
- `npm ls @mindfoldhq/trellis` 显示项目本地固定版本。

## Step 5：Git 稀疏克隆与自动初始化

文件：

- `server/team/git-manager.js`
- `server/team/process.js`（仅补充 Trellis 子进程所需环境键）
- `tests/team-core.test.js`
- 新增 `tests/team-sparse-onboarding.test.js`

操作：

- 新增 team clone 流程：partial clone、no checkout、non-cone sparse `.trellis`。
- 新增远端 `.trellis` 存在性检查。
- 缺失时在空工作区调用本地 Trellis CLI：
  `init -y --skip-existing <flags> -u <leadTrellisDevId>`。
- 初始化后校验 scripts、workflow、负责人 workspace 和初始化文件清单。
- 提交、非强制推送、最多一次非快进恢复。
- 推送成功后重新应用 `.trellis` sparse。
- 提供 `ensureSparseTrellis()` 供既有 clean 项目迁移。
- 通过 `trellisRunner` 依赖注入测试命令参数、超时和失败分支。

验证：

- 本地临时 Git 远端夹具证明已有 `.trellis` 时业务源码不会检出。
- 缺 `.trellis` 时 stub initializer 生成预期文件，提交和推送可被远端读取。
- 越界初始化文件、CLI 失败、push 冲突、sparse 失败分别有测试。
- 项目 clone 失败时不残留目标目录。

## Step 6：项目接入服务与 API

文件：

- `server/team/projects.js`
- `server/team/http.js`
- `tests/team-core.test.js`
- `tests/team-release.test.js`

操作：

- `connect` 输入增加 `agentTools`、`leadUserId`、`leadTrellisDevId`。
- 在 clone 前完成工具、用户、团队和 developer ID 校验。
- 把 bootstrap 数据写入 `team_project` 和审计详情。
- 新项目批准时校验负责人与 bootstrap 一致；旧项目保持兼容。
- `publicProject()`、runtime/status 和 admin 项目响应返回工具与 bootstrap 负责人字段。
- 审计事件记录工具列表、初始化是否发生和目标提交。

验证：

- 空工具、未知工具、无团队用户、非法 developer ID 均在 clone 前失败。
- 自动初始化项目在数据库中为 `provisioning`，批准后为 `current`。
- 初始化 push 失败时数据库不产生可用项目。

## Step 7：前端多选与负责人前移

文件：

- `web/src/api/admin.ts`
- `web/src/hooks/useAdminProjects.ts`
- `web/src/features/admin/OnboardingTab.tsx`
- `web/src/features/admin/ApproveProjectDialog.tsx`
- 新增 `web/src/features/admin/MultiSelectField.tsx`

操作：

- 使用现有 Dropdown Menu/Checkbox Item 实现可访问的多选下拉。
- 新增表单状态：`agentTools`、`leadUserId`、`leadTrellisDevId`。
- 工具默认不预选，至少选择一项后才能提交；负责人默认第一个 active 团队用户，developer ID 需用户确认。
- 提交时发送完整字段；成功后的批准面板显示只读 bootstrap 信息。
- 旧 provisioning 项目继续显示可编辑负责人表单。
- 错误保留输入，提交中禁用控件。

验证：

- `npm --prefix web run build` 在最终阶段一次通过。
- 浏览器验证键盘打开、多选/取消、空选择禁用、窄屏和深色模式。
- 页面请求体与 `/api/admin/projects` 新字段一致。

## Step 8：文档与运维契约

文件：

- `README.md`
- `docs/team-operations.md`
- `.trellis/spec/backend/architecture-and-runtime.md`
- `.trellis/spec/backend/http-and-filesystem.md`
- `.trellis/spec/frontend/rendering-and-state.md`

操作：

- 更新数据根、Ubuntu `/var/lib/trellis-board`、持久卷和备份/恢复步骤。
- 说明只检出 `.trellis`、项目初始化提交、工具多选和负责人前移。
- 更新 HTTP 字段、schema v8、错误码和回滚步骤。
- 记录 GitHub 失联对象延迟回收，不承诺即时物理擦除。

验证：

- 文档中不存在把 `data/` 当作生产默认目录的有效指引。
- 所有旧示例路径已替换。

## Step 9：完整验证

执行顺序：

1. `npm run format`
2. `npm test`
3. `npm --prefix web run build`（仅此一次）
4. 临时数据根启动服务并执行真实 HTTP 接入测试。
5. 浏览器打开 `/admin.html`，验证工具多选、负责人字段、自动初始化提示和批准。
6. 临时远端仓库 E2E：
   - 分支无 `.trellis` → 自动初始化并推送 → 本地只检出 `.trellis`
   - 分支已有 `.trellis` → 直接稀疏检出
7. 检查真实 IDE 工程内不再生成 `data/projects`。

阻塞条件：

- schema 测试失败。
- 初始化文件越界或推送后工作区仍有业务源码。
- 数据迁移失败但源数据被删除。
- 前端构建失败或页面请求字段不匹配。

## Step 10：远端历史清理与发布

前置：

- 功能代码已形成本地提交。
- 工作区干净。
- 已创建 mirror/bundle 备份。

操作：

1. 使用 Git 内置历史重写从所有 refs 删除 `data/`。
2. 清理 `refs/original`、reflog 和不可达对象。
3. `git push --force-with-lease origin HEAD:codex/team-board`。
4. 在全新临时克隆执行：

```powershell
git log --all --name-only --pretty=format: | rg '^data/'
git ls-tree -r origin/codex/team-board -- data
```

5. 两个命令必须无输出。

回滚：

- 推送前失败：从 mirror/bundle 恢复本地 ref，不触碰远端。
- 推送后发现功能问题：远端历史已重写且不可简单回滚，必须用备份对象和新的修复提交恢复；禁止反向强推覆盖协作者新提交。

## 风险文件

- `server/database.js`：迁移错误会影响全部数据。
- `server/config.js`：任何路径错误会读写错误目录。
- `server/team/git-manager.js`：稀疏检出和 push 影响目标仓库内容。
- `server/team/projects.js`：接入失败可能留下 DB 或项目目录残留。
- `web/src/features/admin/OnboardingTab.tsx`：表单状态和批准流跨层契约。
- `package-lock.json`：固定 Trellis CLI 依赖会扩大安装体积。

## 完成定义

- PRD 全部验收项有测试或真实环境证据。
- 运行数据不在源码工作树，Ubuntu 路径由环境变量控制。
- 新接入项目只检出 `.trellis`，缺目录时自动初始化、提交、推送后再收敛。
- 页面支持 Agent 工具多选和负责人前移。
- 远端所有可达历史不再包含任何 `data/` 路径。
