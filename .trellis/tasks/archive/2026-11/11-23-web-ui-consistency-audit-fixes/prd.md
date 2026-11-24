# 全局 UI 一致性与视觉缺陷治理

## 1. 目标与用户价值（Goal & User Value）

承接 2026-11-23 对 `packages/web/src/` 全量前端代码的系统性 UI Review（并对照 `design/` 初版设计稿过滤掉合理需求演进），通过结构化父子任务树分批治理全站控件高度不齐、布局对齐偏移、滚动裁切、文本溢出、状态语义色失效与深浅色主题同步缺陷，实现桌面端与 Web 端统一、精致、可预测的视觉与交互体验。

## 2. 拆解任务地图（Task Map）

| 序号 | 任务目录 | 性质 | 核心范围 | 依赖关系 |
| --- | --- | --- | --- | --- |
| 1 | `11-23-task-detail-close-button-alignment` | 轻量级（PRD-only） | `TaskDetailDialog` 底栏关闭按钮高度（去 `size="sm"`）与同操作行垂直居中对齐 | 无（可独立立即实施） |
| 2 | `11-23-ui-primitives-foundation` | 复杂（前置基础） | `components/ui/*`、`SelectField`、`SearchableSelect`、`index.css` 基础原语高度、截断、导航、主题与滚动条修复 | 无（其他 4 个复杂子任务的前置基础） |
| 3 | `11-23-dialogs-ui-consistency-fixes` | 复杂 | 全站 20+ 业务弹窗布局、底栏按钮尺寸/主次/顺序、产物与条件检查对齐、长文本与错误提示规范 | 依赖子任务 1、子任务 2 |
| 4 | `11-23-board-layout-views-ui-fixes` | 复杂 | `TopBar`、`ProjectRail`/`ProjectEntry`、`BoardPage` 窄屏入口、`Kanban`、`AttentionQueue`、`TaskCard`、`StageTape`、`ExecutionHeader`、`OwnershipInboxPanel`、`TeamView`、`ArchiveView`、`Pagination`、`TaskOperationList`、`FlowSignals`/`Overview`/`StatTile`、`LoginPage` | 依赖子任务 2 |
| 5 | `11-23-admin-plugins-ui-fixes` | 复杂 | `AdminPage`、`ArchiveSyncTab`、`ArchiveSyncTaskSpaceRow`、`AuditTab`、`BranchManagementPanel`、`DevicesTab`、`PluginsTab`、`PluginBindingForm`、`ProjectsTab`、`TeamsTab`、`TeamSwitcher`、`UsersTab`/`AccountForm`、`DesktopPluginsView`、`PluginPanel`、`admin-shared.ts` | 依赖子任务 2（`DesktopPluginsView` 复用 `PluginLogsDialog` 需协同子任务 3） |
| 6 | `11-23-desktop-ui-fixes` | 复杂 | `HandoffNotice`、`LiveSyncControlDialog`、`ActionBar`、`DiffViewer`、`UpdateDialog`、`LoginApp` | 依赖子任务 2 |

## 3. 跨子任务验收标准（Cross-Child Acceptance Criteria）

- [ ] **AC-P1 控件尺寸统一**：全站主输入/按钮/选择控件（`Button`、`Input`、`SelectTrigger`、`InputGroup`、`Combobox`、`Toggle`、`TabsList`）统一基准 `h-8`（32px）；同一操作行与同一表单底栏不再混用 `h-8`/`h-7`/`h-6`。
- [ ] **AC-P2 弹窗规范统一**：所有弹窗 `DialogHeader` 避让右上角关闭按钮，`DialogBody` 与 `DialogHeader`/`DialogFooter` 左缘对齐（消除 Windows `both-edges` 缩进错位与 `mx-4` 双倍缩进），底栏默认 `h-8` 且保持「取消/关闭（`outline`）在左、主动作（`default`/`destructive`）在右」。
- [ ] **AC-P3 滚动与防溢出**：`ProjectRail`、`Kanban`、`AttentionQueue`、`AuditTab`、`DiffViewer` 等列表与容器可正常滚动不裁切；所有动态项目/分支/用户/路径/错误文案均具备 `min-w-0` + `truncate`/`break-words`/`break-all` 保护。
- [ ] **AC-P4 语义色与主题一致**：浅色/深色模式及 `sm`/`md`/`lg`/`xl` 字体缩放下，Toast（`Sonner`）、插件 iframe、`StatusPill`、`Badge`、`Alert`、`Progress` 均准确响应当前主题与状态语义，无严重对比度不足。
- [ ] **AC-P5 全量质量门禁**：6 个子任务全部独立通过 `@trellis-board/web` 的 `oxlint`、`tsc --noEmit`、`oxfmt --check` 与根仓库 `yarn test` 且归档后，完成父任务集成复核。

## 4. 范围边界（Out of Scope）

- 不回滚相对 `design/` 初版设计稿已按业务演进的新增功能与字段。
- 不改动服务端 HTTP API 契约、SQLite schema、Tauri Rust 命令协议或核心业务逻辑。
- 不触发额外构建打包（遵守环境验证规则，仅做 lint、类型检查、格式检查与单测）。
