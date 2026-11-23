# 修复管理后台与插件视图对齐、状态色与响应缺陷

## 1. 目标与用户价值（Goal & User Value）

修复管理后台（`AdminPage`、`ArchiveSyncTab`、`AuditTab`、`BranchManagementPanel`、`DevicesTab`、`PluginsTab`、`PluginBindingForm`、`ProjectsTab`、`TeamsTab`、`TeamSwitcher`、`UsersTab`、`AccountForm`、`shared`）与插件视图（`DesktopPluginsView`、`PluginPanel`）中的同行按钮高度混用、状态语义色完全失效、Tab 栏窄屏左裁切、审计表格横向撑破、插件选中态缺失、主题切换断开 iframe/SSE 与卡片底栏不齐等问题。

## 2. 前置依赖与范围边界

- **前置依赖**：
  - 子任务 2（`11-23-ui-primitives-foundation`）提供基础 `Panel`、`DialogHeader`/`DialogBody` 与 `Select` 能力；
  - 建议在子任务 3（`11-23-dialogs-ui-consistency-fixes`）完成 `PluginLogsDialog.tsx` 修复后，本任务让 `DesktopPluginsView` 直接复用 `PluginLogsDialog`。
- **范围外**：不修改管理后台内嵌独立的 `OneTimeCredentialDialog` 与 `ResetPasswordDialog`（由子任务 3 负责）；不改动服务端权限或审计脱敏逻辑。

## 3. 需求明细（Requirements）

- **REQ-1 管理后台同行按钮高度、表单对齐与原生控件替换**：
  - `ArchiveSyncTab.tsx:186-193,257,261,409-418,444-527,607-622`：
    - 凭据编辑表单底栏容器（L409）改为 `flex items-center gap-2`，移除「取消编辑」（L414）的 `size="sm"`，与「保存凭据」统一为 `h-8`；
    - 凭据 `Row` 展开 `AffectedProjectList`（L444-527）时改为 `Row` 下方全宽折叠区（或展开态 `items-start`），防止右侧「测试/编辑/删除」按钮垂直悬空；
    - 失败日志弹窗底栏（L607-622）按钮移除 `size="sm"` 统一为 `h-8`；
    - 错误态 `Alert`（L186-193）重试按钮补充 `text-foreground`、`AlertDescription` 补充 `mt-1.5`；
    - 编辑标题（L257）`editing.origin` 补充防溢出折行，L261 `grid-cols-[1fr_100px]` 改为 `grid-cols-[minmax(0,1fr)_100px]`。
  - `DevicesTab.tsx:106-139`：一次性令牌展示框（L106-111）将原生 `<input>` 替换为 `<Input>`；令牌操作行（L118-139）补充 `items-center` 并移除「打开桌面客户端」多余 `px-3`。
  - `UsersTab.tsx:157-175,208-277` & `AccountForm.tsx:78-98`：上下两张同构表单提交按钮统一为默认 `h-8` + 左对齐 `self-start`，统一「系统管理员 / 所属团队」字段顺序；右侧账号列表为当前编辑的 `selectedId` 行添加选中高亮；L256 `系统管理员` 补充 `shrink-0 whitespace-nowrap`，L249 用户名补充 `title`。
  - `PluginBindingForm.tsx:34-69`（调用处 `PluginsTab.tsx:253`、`ProjectsTab.tsx:501-503`）：统一表单提交按钮为默认 `h-8` + `self-start`；将 `disabled` prop 透传给 `<SelectField>` 与两个 `<Input>`。
  - `ProjectsTab.tsx:144-163,310-339,366,384-391,429,491-496,527-534`：去掉「生成我的配对码」（L387）硬编码 `rounded-full` 并统一管理后台所有 `Panel` 头部 `action` 按钮尺寸；跨团队访问（L310）改为 `grid-cols-[minmax(0,1fr)_128px_auto] items-center`；「选择项目」行（L145）`SelectField` 补充 `className="min-w-0 flex-1"`；补充团队名/报错/外部项目信息 `truncate`/`break-words`/`break-all`。
  - `TeamsTab.tsx:120,122,140,184,204,208-216`：外层网格改 `grid gap-3.5 lg:grid-cols-[320px_minmax(0,1fr)]`；左侧团队项补充 `gap-2`；角色下拉放宽至 `w-32`；成员「移出」（L208-216）改为 `variant="ghost" size="sm" className="text-destructive"`；补充 `Panel` `kicker` 与 `truncate`/`items-center`。

- **REQ-2 状态语义色映射修复**：
  - `lib/admin-shared.ts:15-34`：`TONE_BY_STATUS` 补齐 `index_error: 'destructive'`、`running: 'success'`、`starting: 'warning'`、`syncing: 'info'`、`importing: 'info'`、`indexing: 'info'`、`crashing: 'destructive'`、`incompatible: 'destructive'`。
  - `ArchiveSyncTaskSpaceRow.tsx:37,40-45,81`：L40 分支名胶囊固定 `tone="neutral"`（避免分支名为 `error`/`active` 等误触发状态色）；L43 改为传入原始英文 `taskSpace.status` 给 `statusTone()`；L37 项目名补充 `min-w-0` + `title`，L81 `lastError` 补充 `break-words`。
  - `ArchiveSyncTab.tsx:489`：`已配置` 状态胶囊固定 `tone="success"`（替代中文传参 `statusTone('已配置')`）。
  - `PluginsTab.tsx:131`：配合 `admin-shared.ts` 补齐后正确渲染运行/启动/崩溃语义色。

- **REQ-3 管理页导航、审计表、团队切换器与长文本防溢出**：
  - `AdminPage.tsx:113-115,200-209`：`TabsList` 增加 `justify-start`，修复系统管理员 7 个 Tab 在窄屏时左侧「项目协作」被 `justify-center` 推出滚动起点外无法滚回的缺陷；品牌区（L113-115）补充 `shrink-0` 与 `whitespace-nowrap`。
  - `TeamSwitcher.tsx:28-41`：`SelectField` 增加最大宽度上限 `max-w-48` 防止长团队名撑破顶栏，L29 `团队` 标签补充 `shrink-0 whitespace-nowrap`。
  - `AuditTab.tsx:104-120,127-180`：头部 `action` 容器补充 `shrink-0`、计数文案补充 `whitespace-nowrap tabular-nums`；对象列补充 `max-w-72 whitespace-normal break-all`（或 `truncate` + `title`）；展开详情行 `<TableCell colSpan={5}>` 改 `whitespace-normal`，`<pre>` 补充 `max-w-full whitespace-pre-wrap break-all`。
  - `BranchManagementPanel.tsx:51,70,252,270,290-295,345-352` & `shared.tsx:53-54`：补全长分支名/未归档任务 `break-all`/`break-words` 与截断项 `title`；内嵌弹窗 `DialogHeader` 避让关闭按钮。

- **REQ-4 插件列表、桌面插件卡片与 iframe 主题同步修复**：
  - `PluginsTab.tsx:127-205,220-251`：为当前 `selected` 插件行添加明确选中高亮与 hover 态；`<Puzzle>`/版本/人数补充 `shrink-0`、`row.name` 补充 `min-w-0 truncate`、`row.lastError` 独立用 `text-destructive break-words` 渲染；窄屏操作区防挤压；右侧绑定列表（L220）移除 `gap-2` 修复分隔线偏上并补充 `truncate`。
  - `DesktopPluginsView.tsx:166-170,195-345`：复用 `PluginLogsDialog` 消除 `mx-4` 双倍缩进和重复弹窗；卡片 `Panel` 补充 `h-full`、去除叠加 `mt-2`/`mt-3`、底栏改为 `mt-auto pt-1`；标签行补充 `items-center` 并统一高度；`lastError` 补充 `break-words`；`hostVersion` 改为条件渲染消除空 `<span>` 幽灵间隙；拖拽手柄补充 `focus-visible:ring-2` 与热区、`↑`/`↓` 改 `size="icon-sm"`、「日志」去 `px-2.5`。
  - `PluginPanel.tsx:66-170`：将 `theme`/`projectName` 同步拆分为独立 effect，在 iframe 已完成握手时立即通过 `postMessage` 推送新 `theme` 与 `readPanelTokens()`，不再因切换亮/暗色主题销毁并漏建 `EventSource`。

## 4. 验收标准（Acceptance Criteria）

- [ ] **AC-1**：管理后台所有表单提交/取消按钮、列表行级操作按钮、`Panel` action 按钮高度与圆角规范统一；`DevicesTab` 令牌框使用标准 `<Input>`；`UsersTab` 与 `PluginsTab` 选中行清晰高亮。
- [ ] **AC-2**：归档同步分支/状态胶囊、插件状态胶囊准确显示成功/警告/失败/运行中语义色；窄屏下 `AdminPage` Tab 栏可完整横向滚动至首项；`AuditTab` 长 JSON 详情不撑破表格。
- [ ] **AC-3**：`DesktopPluginsView` 卡片等高贴底对齐、日志复用 `PluginLogsDialog` 无双重缩进；`PluginPanel` 切换浅/深色主题时已加载插件 iframe 实时切换主题且 SSE 监听不断开。
- [ ] **AC-4**：`@trellis-board/web` 的 `oxlint`、`tsc --noEmit`、`oxfmt --check` 与根仓库 `yarn test` 全部通过。
