# 完善项目接入预检门禁与错误透传

## Goal

未完成核心 Trellis 初始化或首次推送时，接入对话框不得允许执行必然失败的“检查任务差异”；
一旦调用失败，必须展示 sidecar 返回的实际原因，而不是通用“任务预检失败”。

## Background

- 当前仓库没有 `.trellis/tasks` 时，底部“检查任务差异”按钮仍可点击。
- `preflightProject()` 在
  [agent/project-onboarding.js](../../../agent/project-onboarding.js)
  中抛出 `MISSING_TRELLIS: 项目还没有初始化 Trellis，请先选择编码 Agent 并完成初始化`。
- 前端 catch 只识别 `Error` 实例；Tauri `invoke` 拒绝值可能是字符串，因此落入通用兜底文案。

## Requirements

- R1：`hasTrellis=false` 或 `hasTasks=false` 时禁用“检查任务差异”。
- R2：需要首次推送且推送状态未 ready 时继续禁用预检，并明确提示先 commit/push。
- R3：仅缺少可选 Agent 工具但 Trellis tasks 已存在时，不阻塞任务预检。
- R4：预检、初始化和关联的 catch 分支都能提取 `Error`、字符串或可序列化错误中的真实消息。
- R5：消息为空或不可读时才使用通用兜底，不得暴露敏感内容。

## Acceptance Criteria

- [x] 未初始化项目打开对话框时，“检查任务差异”不可点击，并提示先初始化 Trellis。
- [x] 初始化完成但尚未 commit/push 时，预检仍不可点击，并提示推送状态。
- [x] 任务树已存在、只是未安装某个可选 Agent 工具时，不错误阻塞预检。
- [x] `MISSING_TRELLIS`、网络错误和 sidecar 字符串错误均显示具体消息。
- [x] 前端纯逻辑测试覆盖禁用条件和 Error、字符串、可序列化对象三种错误输入；组件接入通过构建与真实界面验证。

## Out of Scope

- 不改变 sidecar 的 `MISSING_TRELLIS` 判定规则。
- 不自动初始化、commit 或 push。
- 不调整 Team 服务端预检接口。
