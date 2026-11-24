# 统一全站业务弹窗布局、按钮层级与对齐规范

## 1. 目标与用户价值（Goal & User Value）

系统性消除全站业务弹窗（看板弹窗、设置弹窗、管理后台弹窗与插件日志弹窗）在底栏按钮高度、主次视觉层级、左右排列顺序、`DialogBody` 缩进、标题防遮挡、表单校验反馈及局部排版上的割裂与错位问题，确保全站弹窗呈现统一一致的交互节奏与视觉规范。

## 2. 前置依赖与范围边界

- **前置依赖**：
  - 子任务 1（`11-23-task-detail-close-button-alignment`）负责 `TaskDetailDialog.tsx:601-643` 底栏修复，本任务负责 `TaskDetailDialog.tsx` 其余区块（串行顺序：1 → 3）；
  - 子任务 2（`11-23-ui-primitives-foundation`）负责基础 `Dialog` / `Select` / `Alert` 原语修复。
- **范围外**：
  - 不改动桌面端专有弹窗 `LiveSyncControlDialog` 与 `UpdateDialog`（由子任务 6 负责）；
  - 不修改 `DesktopPluginsView` 内联日志弹窗替换逻辑（由子任务 5 复用本任务修复后的 `PluginLogsDialog`）；
  - 不改变弹窗业务接口字段与提交校验规则。

## 3. 需求明细（Requirements）

- **REQ-1 弹窗工具栏与日志/工件双倍缩进修复**：
  - `TaskOwnershipDialog.tsx:273-304`：为批量操作栏中的 `<SelectField id="ownership-other-branch" />` 传入约束宽度（如 `className="w-44"` 或 `w-auto min-w-36 max-w-52"`），防止默认 `w-full` 将单行工具栏撕裂为 3 行。
  - `PluginLogsDialog.tsx:54,56`：移除 `<DialogBody>` 上的 `mx-4` 覆写与背景色，改为内部包裹 `<div className="rounded-lg bg-muted px-3 py-2.5"><pre ... /></div>`，使日志框边缘与 `DialogHeader` 左缘对齐；补充 `DialogFooter`「关闭」按钮；为 L54 动态 `title` 描述补充 `break-words`。
  - `TaskDetailArtifactViewer.tsx:28-42`：将 `.markdown-body` 从 `<DialogBody>` 移入内部子 `<div>` 并覆盖 `!bg-transparent`，消除未分层 `github-markdown-css` 的 `margin: 0` 导致的 32px 双倍缩进与深色模式下 `#0d1117` 直角色块割裂；L29 文件路径描述补充 `break-all`；L38-41 底栏「关闭」按钮去掉多余 `<X className="size-3.5" />` 图标保持全站纯文字风格一致。

- **REQ-2 跨弹窗底栏按钮高度、主次层级与顺序统一**：
  - `SavedViewsDialog.tsx:90,97-204`：移除底栏按钮 `size="sm"` 统一为 `h-8`；表单改用 `Field` + `FieldLabel` 并绑定 `htmlFor`/`id`，统一 12px 标签字号；评估合理弹窗宽度（如 `sm:max-w-160` 避免 `sm:max-w-240` 960px 过度空旷）。
  - `PreferencesDialog.tsx:212-217`、`ResetPasswordDialog.tsx:76-127`、`OneTimeCredentialDialog.tsx:46-50,62-67`：移除底栏按钮 `size="sm"` 统一为 `h-8`；`ResetPasswordDialog` 将 `FieldLabel` 颜色与 `PasswordDialog` 统一、`<form>` 间距改为 `gap-4`；`OneTimeCredentialDialog` 动态标题与描述避让右上角关闭按钮。
  - `ProjectManagerDialog.tsx:181-192`：反转主次层级，改为左侧 `<Button variant="outline">关闭</Button>`、右侧 `<Button>重新扫描仓库</Button>`。
  - `PublishOperationDialog.tsx:87-92`：调换左右顺序，改为左侧 `<Button variant="outline">关闭</Button>`、右侧 `<Button>重试操作</Button>`，同步修复窄屏 `flex-col-reverse` 顺序。
  - `ProjectOnboardingDialog.tsx:563-568,647-651,686-702`：差异分支（`hasDifferences`）L688「仅同步无冲突项」改为 `variant="outline"`，消除并列双实心主按钮；L564-566 普通文本中的字面反引号改为 `<code>` 标签；L647-651 区分错误态改用 `<FieldError>` / `<Alert variant="destructive">`。
  - `AssignmentsDialog.tsx:75-108`：补充 `DialogFooter`「关闭」按钮（对齐初版设计 `12-dialog-assignments-light.png`）；去掉 L98 `<Button size="sm" className="ml-auto h-7 text-xs">` 中重复的 `h-7`。
  - `AssigneeWarningDialog.tsx:79-101`：修复 `< sm` 窄屏底栏右侧两按钮容器 `<div className="flex gap-2">` 未竖排/未满宽导致上方偏左留白、下方「取消」通栏的排版错乱（改为 `flex-col-reverse gap-2 sm:flex-row`）。

- **REQ-3 任务详情弹窗（除底栏外）与条件检查规范修复**：
  - `TaskDetailDialog.tsx:328,339,388-399,437-439,446,454,477-521,563-568`：
    - 收敛单弹窗主按钮数量：L388「编辑计划」改为 `variant="outline" size="sm"` 并根据 `editingPlan` 切换文案（如「收起编辑」），L563「创建阻断依赖」改为 `variant="outline"`；
    - L478、L502 依赖双列容器补充 `min-w-0`，配合 `TaskDetailDependencyItem.tsx:21,27` 的标题与阻断原因补充 `break-words`；
    - L328 摘要卡片补充 `min-w-0`、L339 负责人补充 `truncate`、L446 序号与 L454 来源标签补充 `shrink-0 whitespace-nowrap`。
  - `TaskDetailArtifactsSection.tsx:28-44`：按钮对齐由 `items-start` 改为 `items-center`，`MD` 徽标与右侧「查看」补充 `shrink-0`，文本容器补充 `flex-1`。
  - `TaskDetailArchiveFiles.tsx:24,25,37,40,71`：将任意像素字号 `text-[0.6875rem]`、`text-[0.71875rem]`、`text-[0.625rem]` 统一替换为项目语义字号 `text-xs` 与 `text-2xs`。
  - `ConditionChecks.tsx:36-68,74-83,136,174,202,218`：
    - L74-83 `SuccessSummary` 改为 `flex items-center gap-1.5`（或覆盖 `*:[svg]:translate-y-0`）消除对勾图标下沉；
    - L36-47 `ConditionTable` 外层由 `overflow-hidden` 改为 `overflow-x-auto`，适度收窄最小列宽（如 `minmax(160px,1.2fr)`），L51 `row.label` 补充 `min-w-0 break-words`，L66 `ArrowRightIcon` 补充 `shrink-0`；
    - L136、L202、L218 `size-7` 图标盒补充 `shrink-0`，标题容器补充 `flex-1`；
    - L174「查看明细」`ghost` 按钮补充 `hover:bg-destructive/10 hover:text-destructive`。

- **REQ-4 表单校验提示、标题字号与细部防挤压**：
  - `CreateTaskDialog.tsx:191,288-292` & `PasswordDialog.tsx:64`：`<form>` 间距改为 `gap-4` 保持 Header↔Body 与 Body↔Footer 对称；`CreateTaskDialog` 将失败/校验错误与普通提示区分，错误改用 `<FieldError>` 红色展示。
  - `AgentToolSelector.tsx:37-52`：左侧说明文本块补充 `min-w-0 flex-1`，搜索 `<Input>` 补充 `sm:shrink-0` 防止被挤窄。
  - `BranchListenersDialog.tsx:71-74`：动态分支名描述补充 `break-words`。
  - 统一全站弹窗 `DialogTitle` 字号/字重（消除 `text-base`、`text-sm font-medium` 与 `text-sm font-semibold` 的无序混用）。

## 4. 验收标准（Acceptance Criteria）

- [ ] **AC-1**：所有业务弹窗底栏按钮高度统一为默认 `h-8`（32px），且保持左次（`outline` 取消/关闭）右主（`default` 主动作）的顺序与层级；单弹窗内不再同时堆叠 4 个实心主按钮或并列双主按钮。
- [ ] **AC-2**：`TaskOwnershipDialog` 工具栏单行正常排布；`PluginLogsDialog` 与 `TaskDetailArtifactViewer` 无 32px 双倍缩进，暗色模式下 Markdown 查看区底色与弹窗融合无割裂。
- [ ] **AC-3**：`TaskDetailArtifactsSection` 条目垂直居中、`ConditionChecks` 成功条图标居中且表格可横向滚动不裁切；`TaskDetailDialog` 依赖双列、`AgentToolSelector`、`AssigneeWarningDialog` 窄屏与长文本均无挤压/溢出；所有表单报错统一使用红色错误提示。
- [ ] **AC-4**：`@trellis-board/web` 的 `oxlint`、`tsc --noEmit`、`oxfmt --check` 与根仓库 `yarn test` 全部通过。
