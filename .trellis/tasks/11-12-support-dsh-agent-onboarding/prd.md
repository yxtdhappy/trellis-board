# 支持项目接入时选择 DSH Agent

## Goal

让用户在“接入本地 Git 项目”弹窗初始化本机 Agent 时，可以浏览 Trellis 当前支持的全部 Agent，并通过名称或 ID 快速找到目标工具。

## Requirements

- “本机编码 Agent”区域必须从共享工具目录读取并展示当前 Trellis 支持的全部 Agent，当前共 22 项，包含 DSH。
- Agent 显示名称、工具 ID 和初始化参数必须继续以共享工具目录为唯一来源，前端不再维护固定子集。
- “本机编码 Agent”标题区域必须提供搜索输入框，支持按显示名称或工具 ID 做大小写不敏感的包含匹配。
- 搜索只过滤当前可见列表，不改变已有勾选、已存在状态或初始化请求内容；清空搜索后恢复完整列表。
- 无匹配结果时必须显示明确的空状态，不能呈现空白列表。
- 当前分支已存在某个 Agent 的配置目录时，该项必须继续显示“已存在”并禁用，不重复初始化。
- 初始化请求继续提交所选配置项对应的工具 ID；选择 DSH 时必须提交 `dsh` 并复用现有 `--dsh` 初始化链路。
- 本次不改变项目接入协议、服务端校验、Agent 初始化命令或 Trellis CLI 行为。

## Acceptance Criteria

- [x] 搜索为空时，“本机编码 Agent”区域展示共享目录中的全部 22 项，包括 Cursor、Codex、DSH、Snow 等。
- [x] 输入 `dsh`、`DeepSeek` 或对应显示名称片段时，列表只保留 DSH；匹配不区分大小写。
- [x] 搜索过滤不会清除已勾选项；清空搜索后原选择仍然保留。
- [x] 无匹配项时显示“没有匹配的 Agent”空状态。
- [ ] 已有 `.dsh` 时，DSH 显示“已存在”且不可重复勾选。
- [ ] 勾选 DSH 并执行初始化时，传给 `initialize_pending_project` 的 `agentTools` 包含 `dsh`。
- [x] 前端 lint 与 TypeScript/Vite 构建通过；失败项仅为仓库既有告警或已明确记录的无关问题。

## Out of Scope

- 按 IDE、CLI 或厂商对 Agent 分组，以及增加常用项置顶。
- 支持筛选后“全选可见项”或批量勾选。
- 修改共享 Agent 目录、DSH 模板或 Trellis CLI 参数。
- 变更后端项目创建、任务空间接入和 Git 提交推送流程。

## Open Questions

无。
