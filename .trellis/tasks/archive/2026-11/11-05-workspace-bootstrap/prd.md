# 客户端 workspace 初始化

## Goal

客户端在用户选择 workspace 目录后，一次性完成 Trellis 工作区初始化：注入 `.trellis`，生成 `.opencode` 与 `.agents`，并用服务端登录用户名（由管理员创建）初始化 Trellis developer，使该目录可以直接进入 Trellis 工作流并绑定到团队项目。

## Dependencies

- 依赖 `11-05-user-registration`：用户名来自登录后的管理员创建账号。
- 依赖 `11-05-team-isolation`：模板按团队下发，下载接口必须校验活动团队与成员身份。
- 目录选择与本地执行环境由 `11-05-desktop-client-package` 提供最小接口；workspace 初始化逻辑可以先以独立模块/CLI 测试，不阻塞 desktop 壳开发。
- 可与 `11-05-client-server-push` 并行；最终在 desktop 任务中做集成验收。
- 首次初始化需要服务端在线下载团队模板；客户端缓存最近一次成功下载的模板包，供服务端不可达时重试，无缓存则中止。

## Current State（仓库事实）

- Agent 目前只接受已有的 Git 仓库路径：`agent/cli.js:292-308` 的 `bind --path` 会调用 `inspectRepository()` 检查仓库根，不负责创建工作区；workspace 初始化必须发生在绑定之前。
- 仓库自带 `.trellis/scripts/init_developer.py`（入口 `main()` 在 `:25`），它创建 `.trellis/.developer`、`.trellis/workspace/<name>/journal-1.md` 和 `index.md`。
- 本仓库当前有 `.agents/skills/`、`.codex/`、`.pi/`，没有 `.opencode/`；`trellis init` 是唯一的官方脚手架入口。
- 在空目录执行 `trellis init -y --opencode --codex -u <name>` 会生成 `.trellis/`、`.opencode/`、`.agents/`、`.codex/`、`AGENTS.md`、`.gitattributes`；`--codex` 或 `--pi` 才会生成 `.agents/`，`--opencode` 只生成 `.opencode/`。
- `trellis init` 默认跳过已存在文件（`-y` 为非交互“skip existing”）；不会覆盖用户已有内容。
- 本机 `trellis --version` 为 0.6.16，项目要求 0.6.17；CLI 版本与项目版本可能漂移，因此模板由服务端锁定版本下发，不能依赖目标机 CLI 现场生成。
- 服务端已有一个 Windows 原生目录选择脚本 `server/pick-folders.ps1`（COM `IFileOpenDialog`），可作为客户端目录选择器的参考实现；当前 React 前端没有 workspace 选择页，桌面端也尚未接入。
- 服务端当前没有 workspace 模板存储或下载接口；静态文件只服务 `public/`（`server/team/http.js:1010`），没有 zip/模板包契约。

## In Scope

- 客户端“选择 workspace”流程：
  - 原生目录选择器（Windows），支持新建目录、UNC 路径、长路径；选择后做可写性与路径校验。
  - 登录前不允许初始化；使用当前登录账号的用户名。
- 初始化内容：
  - 若目录没有 `.trellis`：用服务端下发的团队模板生成完整 `.trellis`。
  - 默认固定生成 `.opencode` 与 `.agents`；这两个目录是首版验收必需项。
  - 额外提供“初始化/修复 Agent 工具”操作：点击后展开模板清单中所有支持的 agent 工具目录（至少 `.opencode`、`.agents`，可含 `.codex`、`.pi` 等），由用户勾选要生成/修复的目录。
  - 用登录用户名初始化 developer：`.trellis/.developer` 写入 `name=<username>`，创建 `.trellis/workspace/<username>/journal-1.md` 与 `index.md`。
  - 生成 `AGENTS.md`、`.gitattributes` 等 Trellis 标准文件（沿用 `trellis init` 的产物）。
- 模板来源与版本：
  - 服务端提供团队级 workspace 模板下载接口（例如 `GET /api/teams/:teamId/workspace-template`），返回锁定版本的 `.trellis` / `.opencode` / `.agents` 模板包（zip 或等价归档）。当前服务端没有该接口，需要新增模板存储、鉴权与下载路由。
  - 模板包带 manifest，声明支持的工具目录与文件清单；默认只展开 `.opencode` + `.agents`，其余按 manifest 提供给用户勾选。
  - 模板包至少包含 `.trellis` 与 manifest 声明的工具目录（默认 `.opencode`、`.agents`），不依赖目标机执行 `trellis init` 或选择平台参数；目标机 CLI 0.6.16 与项目 0.6.17 的版本差异不得影响初始化结果。
  - 下载必须携带登录会话或 Agent Bearer 凭证，并校验用户属于该团队；模板只能由系统管理员上传/更新，普通用户只读。
  - 客户端不依赖目标机全局 `trellis` CLI；首次初始化需在线下载，成功后缓存模板包与版本/哈希；服务端不可达时可用缓存重试，无缓存则中止并给出明确错误。
  - 模板包带版本号与 SHA-256；客户端校验哈希后才解包，拒绝哈希不匹配的包，不执行包内脚本。
  - 在初始化结果中记录版本（`.trellis/.version`、`.trellis/.template-hashes.json`），并上报客户端与服务端用于诊断。
- 已有工作区的处理：
  - 目录已有 `.trellis`：不覆盖；只补齐缺失的 `.opencode` / `.agents` 与缺失模板文件。
  - `.developer` 已存在且 name 不同：**默认中止并提示**；只有用户显式确认后才允许改为当前登录用户名，修改前备份原文件。
  - 冲突文件写入 `.trellis-backup-<timestamp>/` 或同名 `.bak`，并生成变更清单。
  - 任何情况下不删除用户已有文件、不执行工作区内的自定义脚本。
- Agent 工具重复初始化：
  - workspace 设置页提供“初始化/修复 Agent 工具”按钮；默认折叠，点击后按模板 manifest 列出所有支持目录及当前状态（已存在/缺失/版本不符）。
  - 用户勾选后只创建/修复所选目录；未勾选的已有目录不删除、不修改。
  - 离线时只能使用缓存模板中已声明的工具，缓存缺项则禁用对应选项并提示。
  - 与首次初始化共用幂等、备份、路径校验和冲突中止规则。
- 初始化后验证：
  - `.trellis/.developer` 的 name 等于登录用户名。
  - `.trellis/workspace/<username>/journal-1.md`、`index.md` 存在。
  - `.opencode/`、`.agents/` 存在且非空。
  - 可选：运行 `task.py list` 或等效只读检查，确认脚本可执行。
- 初始化结果：
  - 展示摘要（创建/跳过/备份的文件数、版本、developer 名称、路径）。
  - 记录本地日志（脱敏路径），不上传完整绝对路径；服务端只保存目录基名/哈希（沿用 Agent 现有边界）。
  - 成功后可直接进入“绑定项目/开始同步”步骤。
- 运行环境检查：
  - 检测 Git 是否可用（后续 Agent 同步需要）。
  - 检测 Python 是否可用（Trellis `.trellis/scripts/task.py` 需要）；缺失时给出明确提示，但 `trellis init` 本身不依赖 Python。
  - 目录只读、磁盘空间不足、权限不足时，在写入前失败并给出可操作错误。

## Out of Scope

- 自动 `git init`、创建远端仓库、首次提交或推送。
- 迁移旧版 `.trellis` 到新模板的完整升级器（首版只补齐缺失文件 + 备份）。
- 远程模板仓库、模板在线编辑、模板灰度发布与多版本回滚。
- macOS/Linux 目录选择器。
- 自动安装 Python/Git。

## 已确认决策（2026-11-05）

1. **模板来源**：从服务端下载团队统一模板；客户端缓存最近成功版本，不依赖全局 `trellis` CLI。
2. **平台目录**：首次初始化固定生成 `.opencode` + `.agents`；另有“初始化/修复 Agent 工具”按钮，展开全部支持的工具目录由用户勾选。
3. **已有 `.trellis` 且 developer 不同**：默认中止；用户显式确认后才备份并切换。
4. **是否自动 `git init`**：不自动；初始化只写模板文件。

## Acceptance Criteria

- [ ] 在空目录选择 workspace 后，默认生成非空的 `.trellis/`、`.opencode/`、`.agents/`，且 `.trellis/.developer` 的 `name` 等于当前登录用户名。
- [ ] “初始化/修复 Agent 工具”展开的选项来自模板 manifest；勾选多个工具时只生成所选目录，未勾选的已有目录保持不变。
- [ ] 初始化不自动创建 `.git`；目录是否已是 Git 仓库不影响初始化结果。
- [ ] `.trellis/workspace/<username>/` 包含 `journal-1.md` 与 `index.md`，内容格式与 `init_developer.py` 一致。
- [ ] 目标目录已有 `.trellis` 时，不删除、不覆盖已有文件；缺失文件被补齐；被修改文件有备份。
- [ ] 已有 `.developer` 且用户名不同，默认中止；确认切换时先备份，且日志与 UI 明确显示。
- [ ] 重复执行初始化是幂等的：第二次不产生内容变化，不重复追加 journal。
- [ ] 只读目录、根目录、系统目录、无权限路径、符号链接逃逸路径被拒绝，且失败发生在写入前或完整回滚。
- [ ] 初始化过程只访问服务端模板下载接口，不访问其他网络、不执行工作区或模板内脚本、不读取工作区 `.env` 或凭证文件。
- [ ] 模板下载校验登录会话/Agent 凭证与团队归属；非团队成员返回 403/404；哈希不匹配时中止且不写入。
- [ ] 服务端不可达时，有缓存可重试成功，无缓存则中止且不留下半成品；重复下载同一版本结果幂等。
- [ ] 初始化完成后可立即被 Agent 绑定；绑定失败时保留工作区并给出原因。
- [ ] 目标机未安装 `trellis` CLI，或安装的是 0.6.16/其他版本时，仍能通过服务端模板完成初始化；结果与项目 0.6.17 的 `trellis init` 产物结构一致。
- [ ] 在已有 `.trellis`、`.agents`、`.codex`、`.pi` 但缺少 `.opencode` 的目录执行初始化时，只补齐缺失默认目录，不删除或改写已有工具目录。
- [ ] Windows 10/11 x64 上通过自动化测试验证空目录、已有 `.trellis`、用户名冲突、只读目录四类场景。
- [ ] 日志不记录完整用户绝对路径、密码、token 或邀请码。

## Notes

- `trellis init -y --opencode --codex -u <name>` 的实测产物包含 `.codex/`；如果产品只接受 `.opencode` + `.agents`，需要在设计里明确额外目录的处理方式（保留或清理），不能静默删除。
- `.trellis/.developer` 是 gitignored 的本机身份文件；同一目录换用户时必须显式确认。
- 模板由服务端统一存储与分发，客户端只负责校验、缓存和解包；模板更新必须带新版本号与哈希，不能静默覆盖客户端缓存。
- 初始化属于客户端本地写操作，必须限制在用户选定目录内，并处理 Windows 重解析点（junction/symlink）。
