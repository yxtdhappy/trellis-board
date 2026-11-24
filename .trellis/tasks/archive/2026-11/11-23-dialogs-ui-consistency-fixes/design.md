# 技术设计：统一全站业务弹窗布局、按钮层级与对齐规范

## 1. 全站弹窗规范矩阵

| 规范维度 | 统一目标 | 涉及修改文件 |
| --- | --- | --- |
| 底栏按钮尺寸 | 默认 `h-8`（移除 `size="sm"`） | `SavedViewsDialog`, `PreferencesDialog`, `ResetPasswordDialog`, `OneTimeCredentialDialog` |
| 底栏顺序与主次 | 左 `outline`（取消/关闭）→ 右主动作 | `ProjectManagerDialog`, `PublishOperationDialog`, `ProjectOnboardingDialog` |
| 只读列表关闭按钮 | 补充 `DialogFooter` 纯文字 `outline`「关闭」 | `AssignmentsDialog`, `PluginLogsDialog`, `TaskDetailArtifactViewer`（去 `<X>`） |
| `DialogBody` 缩进 | 不在 `DialogBody` 覆写 `mx-4` 或直挂 `.markdown-body` | `PluginLogsDialog`, `TaskDetailArtifactViewer` |
| 标题字号/字重 | 统一对齐 `dialog.tsx` `DialogTitle` 基准 | `PublishOperationDialog`, `SavedViewsDialog`, `TaskDetailDialog`, `TaskDetailArtifactViewer`, `PreferencesDialog` |
| 表单错误提示 | 区分普通状态提示与错误态（`<FieldError>` / `destructive`） | `CreateTaskDialog`, `ProjectOnboardingDialog` |

## 2. 关键技术方案

1. **`TaskDetailArtifactViewer.tsx` Markdown 容器隔离**：
   - `github-markdown-css` 通过 `<style id="markdown-theme">` 注入全局无 `@layer` 的 `.markdown-body { margin: 0; background-color: ...; }`。
   - 若挂在 `<DialogBody>` 上，无 `@layer` 规则优先级高于 Tailwind v4 的 `@layer utilities`（`-mx-4`），造成左右双倍缩进与底色突变。
   - 方案：将 `.markdown-body` 下沉到 `<DialogBody>` 内部 `<div>` 并使用 `bg-transparent!`（或 `!bg-transparent` 适配当前 Tailwind 配置）覆盖背景色，保留 `DialogBody` 自身的滚动与负边距对齐职责。
2. **`TaskDetailDialog.tsx` 与子任务 1 的边界隔离**：
   - 子任务 1 负责 `L601-L643` 底栏区域；本任务仅调整 `L328-L568` 的主按钮收敛、双列 `min-w-0`、摘要/证据截断防折行与 `DialogTitle` 一致性。
3. **`CreateTaskDialog.tsx` 与 `ProjectOnboardingDialog.tsx` 消息态分离**：
   - 在 `CreateTaskDialog` 中，保留成功/普通提示的 `statusMessage`（或仅在提交失败/校验失败时设 `error` 状态并用 `<FieldError>` 渲染），避免错误与成功共用灰色 `text-muted-foreground`。

## 3. 兼容与回滚

- 各弹窗彼此独立，按模块分组（通用弹窗规范 / 任务详情与条件检查 / 表单与日志弹窗）提交或回滚均不影响底层 `Dialog` 原语。
