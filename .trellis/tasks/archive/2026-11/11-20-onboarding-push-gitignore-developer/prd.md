# 接入初始化：一键提交推送、自动忽略 Agent 目录与 developer 默认值

## Goal

把“初始化本地项目”从手动拼 Git 命令改为可一键完成，并让初始化产生的本机 Agent 配置默认不进入 Git；同时在两个初始化入口中优先采用项目已有的 Trellis developer 身份，减少重复填写和误填。

## Background / Confirmed facts

- 首次推送确认当前只展示手动命令 `git add .trellis && git commit && git push` 和“检查推送状态”，并明确“客户端不会自动 commit 或 push”（`packages/web/src/features/board/dialogs/ProjectOnboardingDialog.tsx:540`）。
- 桌面端 Git 层目前只有只读操作与 fetch/merge 白名单（`packages/desktop/src-tauri/src/agent/git.rs:36`），没有 add/commit/push。
- 初始化由 `onboarding::initialize_project` 统一处理完整 init 与 Agent-only 两条路径（`packages/desktop/src-tauri/src/agent/onboarding.rs:287`）；两个入口都调用它：
  - 接入本地项目：`initialize_pending_project`（`packages/desktop/src-tauri/src/main.rs:564`）
  - 项目列表新增 Agent：`initialize_associated_project_agents`（`packages/desktop/src-tauri/src/main.rs:748`）
- Agent 工具表包含 22 个平台的本地目录（`packages/shared/trellis-agent-tools.js:1`，Rust 镜像在 `packages/desktop/src-tauri/src/agent/trellis_cli.rs:42`）。
- Trellis 的 developer 身份写在 `.trellis/.developer`，格式为 `name=<name>\ninitialized_at=...`（本仓库 `.trellis/.developer`；与 Trellis 0.6.17 模板一致）。
- 当前 developer 默认值：接入弹窗优先按远端身份匹配已有项目的 trellisDevId，否则用账号（`packages/web/src/features/board/dialogs/ProjectOnboardingDialog.tsx:133`）；快速初始化弹窗用项目 trellisDevId 或账号（`packages/web/src/components/layout/ProjectRail.tsx:560`）。

## Requirements

### R1 一键提交并推送

- 在“首次推送确认”区域、手动命令旁新增“一键提交并推送”按钮。
- 点击后由客户端只暂存并提交初始化生成的 `.trellis`、`.gitignore`、`AGENTS.md`、`.gitattributes`、`.agents/`（后四者存在时），commit message 固定为 `初始化trellis`，随后把当前分支推送到 `origin` 同名分支。
- 不得提交或推送其他文件；其他已暂存或未暂存改动保持原状。
- 按钮只在待接入项目上下文中可用；不接受前端传入路径、分支或提交信息。
- 成功后刷新推送状态；失败时显示可读错误，不能把状态误报为已就绪。
- 手动命令与“检查推送状态”保留。

### R2 初始化后自动写 `.gitignore`

- 成功初始化（完整 init 或 Agent-only）后，把本次所选 Agent 工具对应的本机配置路径追加到项目根 `.gitignore`。
- 已存在的等价规则不重复写入；保留原文件内容和换行风格；重复执行幂等。
- 两个初始化入口都生效（共享后端初始化路径）。
- `.github` 这类共享目录只忽略 Trellis 生成的精确子路径，不整目录忽略。
- 更新失败必须向用户报错，不能静默跳过。

### R3 developer 默认值读取 `.trellis/.developer`

- 若项目根下 `.trellis/.developer` 存在且 `name` 非空，两个初始化表单的 Trellis developer ID 默认值优先使用该值。
- 若不存在或 `name` 为空，保持现有逻辑不变（接入弹窗：远端身份匹配的项目 trellisDevId → 账号；快速初始化：项目 trellisDevId → 账号）。
- 用户在预检返回前已手动编辑时，不被后到的预检结果覆盖。
- 项目预检响应新增 `developerName` 字段，供两个入口共用。

## Acceptance Criteria

- [ ] AC-R1.1 首次推送确认里同时存在“一键提交并推送”、手动命令和“检查推送状态”。
- [ ] AC-R1.2 点击一键按钮后，本地仅新增一个 message 为 `初始化trellis` 的提交，内容只包含初始化生成的 `.trellis`、`.gitignore`、`AGENTS.md`、`.gitattributes`、`.agents/`（后四者存在时）；其他已暂存或未暂存文件不进入该提交。
- [ ] AC-R1.3 没有可提交内容但本地领先远端时，只推送、不创建空提交；远端尚无分支时也能创建同名分支。
- [ ] AC-R1.4 推送成功后界面状态变为“已就绪”；认证、网络、非快进、Git 身份缺失等失败会显示可读错误，且不会误报为已就绪。
- [ ] AC-R1.5 一键命令只对 `inspect_local_project` 记录的待接入项目生效，远程 Board 通过独立权限声明调用。
- [ ] AC-R2.1 初始化所选 Codex、Claude Code、Pi 等工具后，项目根 `.gitignore` 出现对应规则（如 `/.codex/`、`/.claude/`、`/.pi/`）。
- [ ] AC-R2.2 已有 `.gitignore` 内容与换行风格保持不变；等价规则不重复添加，末尾无换行时也能正确追加。
- [ ] AC-R2.3 对同一项目重复初始化不会产生重复规则。
- [ ] AC-R2.4 从项目列表“初始化编码 Agent”入口追加 Agent 时，同样更新 `.gitignore`。
- [ ] AC-R2.5 `.gitignore` 无法写入时，初始化调用返回包含原因的明确错误，而不是静默成功。
- [ ] AC-R3.1 项目存在 `.trellis/.developer` 且 `name=yhj` 时，两个入口的 developer ID 默认显示 `yhj`。
- [ ] AC-R3.2 不存在或 `name` 为空时，两个入口维持原有默认值来源。
- [ ] AC-R3.3 用户在预检返回前手动改过 developer ID 时，不被后到的 `developerName` 覆盖。
- [ ] AC-R3.4 `normalizeProjectInspection` 对缺失 `developerName` 返回空字符串，既有调用方不受影响。

## Out of scope

- 不做无用户点击的自动 commit/push。
- 不开放任意 Git 写命令；不提供自定义 commit message 或路径。
- 不在“项目列表初始化编码 Agent”入口提供提交/推送。
- 不清理已提交的 Agent 目录（不执行 `git rm --cached`），不做历史迁移。
- 不修改服务端任务同步、Trellis CLI 本体或 Agent 模板内容。

## Key Decisions

- 一键按钮同时提交 `.gitignore`：忽略规则需要随项目共享，否则其他开发者仍会误提交 Agent 目录。
- `.trellis/.developer` 优先于项目 trellisDevId：本地文件代表当前 checkout 的实际身份，符合用户要求；可能与团队映射不一致，接入时由服务端校验兜底。
- Copilot 写入 `.github` 下的多个位置，使用精确子路径忽略；Antigravity 的 `.agent/` 整体忽略。
- `.gitignore` 更新失败按初始化失败处理，但文案说明初始化文件可能已生成；重复执行幂等，允许直接重试。

## Risks

- 新增可写 Git 命令扩大客户端能力面：通过“只对待接入项目路径生效 + 固定路径 + 固定提交信息 + 空 hooks + 无交互凭据 + 超时”收敛。
- 用户 Git 未配置 `user.name`/`user.email` 时 commit 失败：展示 Git 原始错误，保留手动命令兜底。
- `.gitignore` 只读或被 DLP 锁定时初始化报错：提示原因，可重试或手动添加规则。

## Open Questions

无。