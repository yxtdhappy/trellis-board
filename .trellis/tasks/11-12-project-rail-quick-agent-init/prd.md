# 项目栏快速初始化编码 Agent

## Goal

用户无需重新选择本地项目，即可从已关联项目行直接打开编码 Agent 列表，并为本机仓库追加初始化所需工具。

## Background

- 当前项目栏只提供“接入本地项目”和关联/重新关联入口；追加编码 Agent 必须重新走目录选择。
- 现有接入向导从 `shared/trellis-agent-tools.js` 读取完整 Agent 目录，以仓库实际文件判断已初始化工具，并调用本机初始化器完成增量初始化。
- 本次入口只服务于当前设备已批准关联的项目，不改变任务空间、服务端绑定或其他设备配置。

## Requirements

### R1 快速入口

- Tauri 客户端中，当前选中项目分支已有 `approved` 本地关联时，在关联文件夹图标右侧显示 Agent 快速初始化图标按钮。
- 未关联、关联已撤销/拒绝或其他未批准状态不显示该入口。
- 只读关联也可以使用该入口，因为初始化只修改当前设备的编码 Agent 配置。
- 按钮必须有明确的中文 `aria-label` 和悬停提示，并与现有项目栏图标尺寸、间距和交互风格一致。

### R2 快速初始化弹窗

- 点击入口后直接使用当前 `taskSpaceId` 定位本地已批准关联，不打开目录选择器，也不要求重新选择项目、团队或同步分支。
- 弹窗展示全部编码 Agent，支持按名称或 ID 做大小写不敏感搜索。
- 已初始化 Agent 必须禁用、置灰并标记“已初始化”；未初始化 Agent 可多选。
- 弹窗提供当前登录账号用户名作为默认 Trellis developer ID，允许用户修改；空值时不得提交。
- 初始化按钮只提交本次选中的缺失 Agent。没有选中项或所选内容均已初始化时按钮禁用。
- 初始化成功后显示成功提示并关闭弹窗；失败时保留当前选择和 developer ID，并展示经过统一错误提取的中文原因。
- 取消、Esc 或关闭弹窗不得写入仓库。

### R3 本机安全边界

- 远程 Board 只能提交 `taskSpaceId`、developer ID 和 Agent ID，不得提交任意本地路径。
- Rust 命令必须从当前设备本地关联中解析 `repoPath`，并再次确认关联状态为 `approved`。
- 继续复用现有 Git 根目录校验、Agent 工具白名单校验和 `initializeProject()` 增量初始化语义。
- 不自动 commit、push、重启任务同步 sidecar 或修改服务端任务数据。

## Acceptance Criteria

- [ ] 已关联项目的文件夹图标右侧出现 Agent 快速初始化按钮；未关联项目不出现。
- [ ] 点击按钮后无需目录选择即可看到当前仓库的 Agent 列表，布局与接入向导一致。
- [ ] 已存在工具被禁用并显示“已初始化”，搜索和未初始化工具多选正常工作。
- [ ] 选择至少一个缺失工具并使用有效 developer ID 后，可从原仓库成功生成对应工具文件并关闭弹窗。
- [ ] 再次打开弹窗时，新初始化的工具显示为“已初始化”且无法重复选择。
- [ ] 缺少有效批准关联、空 developer ID、空 Agent 列表或非白名单 Agent 时，在写入前失败并显示可理解的原因。
- [ ] 现有“接入本地项目”、重新关联、首次推送检查和任务同步行为不回归。
- [ ] 相关 Node/Rust 测试通过，最终只执行一次 Web 构建并以真实 Tauri 页面完成入口与弹窗验收。

## Technical Notes

- 现有 Agent 目录与探测规则分别位于 `shared/trellis-agent-tools.js:1` 和 `agent/project-onboarding.js:33`。
- 现有接入向导的列表、搜索和初始化逻辑位于 `web/src/features/board/dialogs/ProjectOnboardingDialog.tsx:306`。
- 项目栏关联图标位于 `web/src/components/layout/ProjectRail.tsx:479`。
- 本机初始化复用 `desktop/src-tauri/src/sidecar.rs:1222` 的项目预检和 `desktop/src-tauri/src/sidecar.rs:1244` 的初始化入口。
- 新远程命令仍必须经过 `ensure_board_caller()`，并补齐 capability 与 permission。

## Out of Scope

- 不新增服务端 API、数据库表或任务空间字段。
- 不提供移除非本机 Agent 工具、批量管理其他设备或远程初始化能力。
- 不改变现有首次接入流程、任务差异处理、commit/push 策略或 sidecar 生命周期。
- 不为普通浏览器增加本地项目或 Agent 初始化入口。
