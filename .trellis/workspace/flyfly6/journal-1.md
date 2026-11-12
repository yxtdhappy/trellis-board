# Journal - flyfly6 (Part 1)

> AI development session journal
> Started: 2026-11-05

---



## Session 1: 设计稿还原与插件面板移植
<!-- trellis-session: v=2 fp=6335806368f079eb -->

**Date**: 2026-11-05
**Task**: 设计稿还原与插件面板移植
**Branch**: `codex/team-board`

### Summary

按 39 张设计帧还原看板：语义色 token、状态标签、执行头/流动信号/注意力队列/概览/100vh 看板列、团队与归档改表格分页、弹层宽度与底栏对齐、原生 select 全量换 shadcn Select；whistle mock 打通管理台并压缩审计行；合并远端插件运行时并把它在重构前页面上的插件页完整移植为 React 视图（轮询、启停、日志弹层）。

### Git Commits

| Hash | Message |
|------|---------|
| `fbad32d` | feat(web): 按设计稿还原看板界面 |
| `e3f5fec` | merge: 合并远端插件运行时工作 |
| `daf351c` | feat(web): 移植插件运行面板 |

### Status

[OK] **Completed**


## Session 2: 设计稿缺陷修复与界面还原对齐
<!-- trellis-session: v=2 fp=33775c04358e8d70 -->

**Date**: 2026-11-06
**Task**: 设计稿缺陷修复与界面还原对齐
**Branch**: `codex/team-board`

### Summary

修复 Pencil 设计稿缺陷（顶栏宽度与间距、深色弹层关闭图标、Frame 19 状态规范），重构 TrellisLogo 品牌矢量图标，标准化控件高度为 32px，重构负责人选择组件为 SelectField 消除原生 datalist，修复团队视角项目切换与表格联动过滤，解决 useBoard 750ms 轮询死循环及 Base UI onSelect 事件响应兼容，并通过 Tabbit 浏览器完成全量页面与弹层的深浅色还原度核验。

### Git Commits

| Hash | Message |
|------|---------|
| `bfc4b59` | feat(web): 修复设计稿缺陷并对齐界面还原 |

### Status

[OK] **Completed**


## Session 3: 统一弹层骨架、下拉宽度与 Markdown 预览改造
<!-- trellis-session: v=2 fp=6090c09cf7fbb868 -->

**Date**: 2026-11-09
**Task**: 统一弹层骨架、下拉宽度与 Markdown 预览改造
**Branch**: `codex/team-board`

### Summary

统一 16 处弹层骨架（DialogContent flex 列 + 新增 DialogBody 唯一滚动区，表单弹层保留 submit 语义）、修正 Base UI Select 弹层宽度与选项换行、Markdown 预览改为 markdown-it + github-markdown-css + highlight.js/common（主题切换注入对应 CSS），归档索引项目筛选统一走 BoardPage 的 filters.projectId；接入 oxfmt 作为唯一格式化工具并全仓统一格式（220 个纯格式化文件单独提交）。浏览器实测弹层滚动/Flex 与下拉宽度、Markdown 排版与深浅主题、归档联动均符合预期；合并远端 5 个提交后 oxfmt 279 files、tsc、oxlint、379 项测试全部通过。

### Git Commits

| Hash | Message |
|------|---------|
| `0981be5` | chore(format): 接入 oxfmt 统一全仓代码格式 |
| `f0f84ca` | feat(web): 统一弹层骨架与下拉宽度并切换 Markdown 渲染 |
| `4ee7d80` | merge: 合并远端团队同步与 Trellis 换行符规范 |

### Status

[OK] **Completed**


## Session 4: web 控件高度统一到 32/28/24 三档并优先 shadcn
<!-- trellis-session: v=2 fp=d194f529ad767cd4 -->

**Date**: 2026-11-12
**Task**: web 控件高度统一到 32/28/24 三档并优先 shadcn
**Branch**: `codex/rust-desktop-agent-single-exe`

### Summary

Input/Button/icon 尺寸改为 32/28/24 三档，删除页面层 h-8/h-9/h-10/h-7.5 覆盖与控件字级离群值，动作型裸 button 换 shadcn Button，并把控件尺度与 shadcn 优先写进前端规范

### Main Changes

- web/src/components/ui/input.tsx 与 button.tsx 尺寸改为 32/28/24 三档
- TopBar、ProjectRail、ExecutionHeader、TeamView、ArchiveView、Pagination、TaskCard、ConditionChecks、TaskOperationList、TeamsTab、PluginsView、ProjectManagerDialog、PublishOperationDialog、SavedViewsDialog、TaskDetailDialog 清理高度与字级覆盖
- .trellis/spec/frontend/quality-guidelines.md 新增控件尺度表与 shadcn 优先/裸 button 豁免清单

### Git Commits

| Hash | Message |
|------|---------|
| `849c8df` | feat(web): unify control heights to 32/28/24 scale |
| `669672f` | chore(task): archive 11-12-web-controls-unification |

### Testing

- [OK] npm run format + npm --prefix web run lint（无 error）+ npm --prefix web run build
- [OK] npm test：433 pass / 0 fail / 5 skipped
- [OK] 浏览器实测流水线、团队视角、任务详情弹窗与 /admin.html：Input/Select 32px、Button 32/28px 无离群高度

### Status

[OK] **Completed**

### Next Steps

- 任务 B：接入本地项目弹窗即时打开并 loading 占位
- 任务 A：客户端 UI 迁移到 web 的 Vite+React+shadcn 构建（需等 11-12-rust-desktop-agent-single-exe 归档）
