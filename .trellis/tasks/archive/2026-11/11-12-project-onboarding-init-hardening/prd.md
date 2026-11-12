# 加固项目初始化的 Pi 兼容与预检体验

## Goal

降低新项目首次接入时的初始化失败率，并让必须由用户先完成初始化或推送时，界面不再允许执行必然失败的
任务预检。本父任务只负责拆分、跨子任务验收和最终集成跟踪，不直接承载实现。

## Background

- Windows 环境下同时选择 Pi Agent 初始化时，Trellis CLI 在
  `.pi/extensions/trellis` 内执行同目录临时文件重命名，实际返回
  `EXDEV: cross-device link not permitted`。
- 仓库尚未初始化 Trellis 时，接入对话框仍允许点击“检查任务差异”；sidecar 返回
  `MISSING_TRELLIS`，但前端最终只显示通用“任务预检失败”。
- 两个问题可独立验证：Pi 初始化属于 runtime/文件写入兼容；预检门禁和错误提示属于桌面接入 UI。

## Child Tasks

- `11-12-fix-pi-init-exdev`：修复 Pi 初始化 EXDEV 失败和不完整目录误判。
- `11-12-fix-project-preflight-guidance`：修复预检按钮时序、sidecar 错误透传和提示。

## Requirements

- R1：两个子任务分别完成规划、实现、检查和验收。
- R2：父任务最终验收必须覆盖 Pi 初始化成功，以及未初始化项目无法发起任务预检。
- R3：不混入无关桌面、Team 同步或本地测试仓库改动。

## Acceptance Criteria

- [x] 两个子任务均已完成并通过各自验收。
- [x] Pi Agent 在目标 Windows 环境可完成初始化，失败时不会留下被误判为已安装的半成品。
- [x] 未完成 Trellis 初始化时无法点击“检查任务差异”，界面明确提示先初始化。
- [x] 实际 sidecar 错误能够显示在对话框中，不再退化为通用失败文案。

## Out of Scope

- 不改变 Team 服务端任务快照协议、远端身份规则或 GitHub 仓库配置。
- 不自动提交或推送用户项目。
- 不通过关闭安全软件规避问题；修复必须在正常安全环境中可验证。
