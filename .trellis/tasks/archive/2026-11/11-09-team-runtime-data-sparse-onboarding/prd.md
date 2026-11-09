# 团队运行数据外移与 .trellis 稀疏项目接入

## Goal

让 Trellis Board 的运行时数据不再污染开发者源码工作区，同时把团队项目接入收敛为只同步 `.trellis`；目标仓库尚未初始化 Trellis 时，服务端应自动初始化、提交并推送，再继续项目接入。

## Background

- 当前运行数据根目录为 `D:\wit\trellis-board\data`，定义在 `server/config.js:6`。
- 团队项目克隆目录为 `data/projects`，定义在 `server/team/git-manager.js:234`，接入时执行完整克隆，目标路径为 `data/projects/<workspaceKey>`，见 `server/team/git-manager.js:476`。
- 完整克隆会把目标仓库的 `.git` 放到当前 IDE 工程目录内。IntelliJ 日志已确认于 2026-11-09 20:43:17 和 20:47:04 自动注册两个嵌套 Git 根；服务端代码没有修改 `.idea`。
- `data/standalone-backup-20261108-142014/board.sqlite` 已由提交 `ef7eb4f` 加入版本库，并存在于 `origin/codex/team-board`，文件大小 5,271,552 字节。该备份库没有用户、团队或项目记录，但包含 5 条本地仓库路径，仍属于不应发布的运行数据。
- 当前工作区已删除该备份文件，但删除尚未提交。
- `trellis init` 由全局 `@mindfoldhq/trellis@0.6.17` 提供；`-y` 为非交互模式，已有文件默认跳过，至少需要选择一个 AI 工具目录。
- 团队服务当前依赖 `.trellis/scripts`、`.trellis/workspace` 和 `.trellis/tasks` 执行工具链校验、任务创建和扫描。
- 桌面端已有平台数据根约定：Windows 默认位于 `%LOCALAPPDATA%\TrellisBoard\data`，并支持 `TRELLIS_DESKTOP_HOME` 重定向；Agent 默认位于 `%LOCALAPPDATA%\TrellisBoardAgent`，并支持 `TRELLIS_AGENT_ROOT`。
- Ubuntu 服务端不存在 Windows 盘符语义，因此运行数据位置不能写死为 `D:\...`。
- 用户已确认采用跨平台数据目录策略：`TRELLIS_BOARD_DATA_DIR` 优先；Windows 本地默认 `%LOCALAPPDATA%\TrellisBoard\server`；Linux/macOS 默认用户数据目录下的 `TrellisBoard/server`；Ubuntu 部署显式使用持久化目录 `/var/lib/trellis-board`。
- 用户已确认远端历史必须清除整个 `data/` 路径，并接受使用受控强制推送。
- 用户已确认 Agent 工具在项目接入页面多选，且首个负责人和 Trellis developer ID 前移到接入表单。

## Requirements

### R1 运行数据外移

- 运行数据库、凭据密钥、备份、插件配置、插件密钥和服务端项目克隆不得继续位于开发者源码 Git 工作树内。
- 服务端运行数据根必须支持 `TRELLIS_BOARD_DATA_DIR` 等环境变量显式配置，部署文档必须以独立持久卷目录为最终配置来源。
- 未配置环境变量时，各平台使用平台数据目录派生默认值：Windows 使用 `%LOCALAPPDATA%\TrellisBoard\server`，Linux/macOS 使用用户数据目录下的 `TrellisBoard/server`。
- 默认数据位置必须稳定、可备份，且不能因应用升级、源码切换或重新构建而丢失。
- 迁移现有数据时不得丢失账号、团队、项目、审计、实时同步状态、Git 凭据或待恢复 Git 操作。
- 数据库中的现有项目路径必须迁移到新克隆目录，无法迁移的项目应保留并进入可诊断状态，不得静默删除。
- `.idea` 不得被产品代码直接修改。

### R2 `data` 远端泄漏审计与处置

- 远端所有可达提交历史中不得继续包含任何 `data/` 路径或备份信息；不能只从当前树删除。
- `data/` 下的示例配置若仍需保留，必须迁移到运行数据目录之外并重新命名，避免继续占用 `data/` 路径。
- 重写历史前必须创建可恢复的本地镜像和当前工作区补丁，推送使用 `--force-with-lease`，禁止无条件强推。
- 交付报告必须列出已进入远端的 `data` 文件、引入提交、是否包含敏感数据类别以及处置方式。
- 交付报告必须说明 GitHub 对失联对象和缓存的延迟回收限制，不能承诺远端存储介质立即物理擦除。

### R3 仅拉取 `.trellis`

- 新接入项目必须使用 Git 稀疏检出，只检出 `.trellis/`。
- 服务端仍必须能够识别远端共享分支、校验 `.trellis/scripts` 工具链、扫描任务以及提交任务变更。
- 项目工作副本不得出现其他业务源码文件，除非某个 Git 操作被证明必须临时获取且会自动清理。

### R4 自动初始化 Trellis

- 接入时若目标分支不存在 `.trellis/`，服务端应自动执行受控的 Trellis 初始化。
- 初始化必须使用明确的非交互参数、开发者身份、平台选择和超时限制。
- 项目接入表单必须提供 Agent 工具多选下拉；所选工具传给 `trellis init`，并至少选择一项。
- 项目接入表单必须选择首个负责人和负责人 Trellis developer ID；服务端校验负责人属于目标团队且 developer ID 格式有效。
- 初始化产生的预期文件必须先提交并推送到同一共享分支，成功后再完成项目接入和 `.trellis` 稀疏拉取。
- 推送失败、权限不足、钩子拒绝、远端分叉或部分初始化失败时，不得把项目标记为可用。

### R5 安全与兼容

- 自动初始化和稀疏检出不得执行目标仓库中的生命周期 hooks 来生成初始脚手架。
- 已有 Git 凭据、SSH 主机信任、分支保护与推送失败恢复机制必须继续生效。
- 其他运行数据入口不得继续默认写入源码目录。

## Acceptance Criteria

- [ ] AC1：全新启动时，所有运行数据默认创建在新数据根目录，源码 Git 工作树中不再产生 `data/board.sqlite`、`data/projects` 或其他运行态文件。
- [ ] AC2：在 IDE 打开源码工程并接入至少两个项目后，IntelliJ 不再自动注册 `data/projects` 下的 Git 根，Git Log 只显示源码仓库分支。
- [ ] AC3：现有运行数据迁移后，管理员登录、团队成员、两个已接入项目、审计事件、Git 凭据、任务索引和实时同步配置均保持可用。
- [x] AC4：审计报告可证明误提交的 `data/standalone-backup-20261108-142014/board.sqlite` 是否仍在远端、由哪个提交引入，并记录当前树处置结果。
- [x] AC5：接入已有 `.trellis` 的仓库时，工作副本只有 `.trellis/**` 被检出；任务列表与工具链摘要可正常读取。
- [x] AC6：接入没有 `.trellis` 的仓库时，服务端自动初始化、提交并推送初始化结果，随后只检出 `.trellis/**`；远端分支可见初始化提交。
- [x] AC7：初始化后推送失败时，接入失败并返回可恢复错误，不产生状态为 `current` 的残缺项目。
- [x] AC8：自动初始化不会覆盖目标分支已有文件，也不会在未配置平台或开发者身份时猜测并继续。
- [x] AC9：针对外移、迁移、稀疏检出、自动初始化、推送失败和回滚路径存在自动化测试。

## Out of Scope

- 不改变 Trellis 的任务生命周期语义和现有权限模型。
- 不在本次任务中实现业务源码的完整本地开发副本。
