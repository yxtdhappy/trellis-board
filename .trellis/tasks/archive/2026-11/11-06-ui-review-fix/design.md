# 技术设计 · 设计稿缺陷修复与界面还原对齐

## 1. 架构与改动边界

```
web/src/
├── components/
│   ├── layout/
│   │   ├── TrellisLogo.tsx         <-- [新增] 统一 Trellis 网格晶格矢量图标组件
│   │   ├── TopBar.tsx              <-- [修改] 使用 TrellisLogo 替换 "T"
│   │   └── ProjectRail.tsx         <-- [保持] 项目列表触发 filters.projectId 更新
│   └── ui/
│       ├── select.tsx              <-- [修改] 修复 SelectTrigger 的 h-8 覆盖与高度基线
├── features/
│   ├── board/
│   │   ├── SelectField.tsx         <-- [修改] 统一尺寸默认值，支持标准 h-8 交互
│   │   ├── TeamView.tsx            <-- [修改] 联动 filters.projectId 进行客户端过滤
│   │   ├── ArchiveView.tsx         <-- [修改] 对齐搜索框、下拉框与刷新按钮的 h-8 高度
│   │   └── dialogs/
│   │       └── CreateTaskDialog.tsx<-- [修改] 将负责人字段替换为标准 SelectField
│   └── admin/
│       ├── ProjectsTab.tsx         <-- [修改] 对齐筛选下拉与操作按钮高度
│       └── shared.tsx              <-- [修改] controlClass 统一基准高度
├── pages/
│   ├── admin/
│   │   └── AdminPage.tsx           <-- [修改] 顶栏引入 TrellisLogo 与主题切换开关
│   └── login/
│       └── LoginPage.tsx           <-- [修改] 使用 TrellisLogo 矢量图标
└── hooks/
    └── useBoard.ts                 <-- [修改] 用 ref 跟踪 generatedAt，终止 750ms 轮询死循环；补齐 idempotencyKey
```

## 2. 核心技术方案

### 2.1 矢量 Logo 组件 (`TrellisLogo.tsx`)
- 尺寸：默认 24×24px（可定制 `size`），圆角 6px（`rounded-md`），背景使用语义色 `bg-primary`。
- 内部图形：以 SVG 形式绘制与设计稿 `Grid Bar` 一致的 2×2 / 3×3 Trellis 晶格网络线条（前景色使用 `text-primary-foreground`），保证在深色/浅色模式以及高分屏下锐利清晰。

### 2.2 控件尺寸（Size Scale）系统对齐
- **问题根因**：`select.tsx` 中 `SelectPrimitive.Trigger` 写死了 `data-[size=default]:h-7`，Tailwind 编译时属性选择器与类选择器冲突，使得传入的 `className="h-8"` 无法按预期撑开高度。
- **解决方案**：
  1. 在 `select.tsx` 中，优化 `SelectTrigger`，支持 `size?: "sm" | "default" | "md" | "lg"`，当外部显式传入高度类或 `size="default"` 时确保为标准 32px（`h-8`）。
  2. 统一 `SelectField` 的默认类名，与 `Input`（默认 `h-8`）保持一致。
  3. `ArchiveView`、`TeamView` 的工具栏并排元素，全部统一应用 `h-8`，行高与 padding 严格居中对齐。

### 2.3 创建任务负责人 Select 重构
- 移除 `CreateTaskDialog.tsx` 中的 `<input list="create-assignee-options" />` 及 `<datalist>`。
- 引入 `SelectField`：
  ```tsx
  <SelectField
    id="create-assignee"
    value={assignee}
    options={[
      { value: '', label: '未指定负责人' },
      ...assignees.map((name) => ({ value: name, label: name }))
    ]}
    onChange={setAssignee}
    placeholder="请选择负责人"
  />
  ```
- 行为与右侧的“优先级”Select 完全保持一致。

### 2.4 独立模式 750ms 轮询死循环修复
- **根因**：`useBoard.ts` 的轮询 effect 闭包读取的是初始 `board`（为 null），`next.lastRefreshAt !== board?.generatedAt` 恒为 true。
- **修复**：
  ```ts
  const boardGeneratedAtRef = useRef<string | null>(null)
  useEffect(() => {
    boardGeneratedAtRef.current = board?.generatedAt ?? null
  }, [board?.generatedAt])

  // 在轮询中：
  if (next?.lastRefreshAt && next.lastRefreshAt !== boardGeneratedAtRef.current) {
    boardGeneratedAtRef.current = next.lastRefreshAt
    await loadBoardRef.current(false, true)
  }
  ```
  只有服务端真正产生新版本时才触发全量加载，避免死循环请求。

### 2.5 团队视角切换项目联动
- **根因**：`TeamView.tsx` 的 `rows` 仅根据 `keyword` 进行简单匹配，忽略了外部传入的 `filters.projectId`。
- **修复**：
  在 `TeamView.tsx` 中引入项目匹配：
  ```ts
  const targetProject = filters.projectId
  const projectMatched = !targetProject || targetProject === 'all'
    ? tasks
    : tasks.filter(t => t.projectId === targetProject || t.projectName === targetProject || t.dirName === targetProject)
  ```
  在 `ProjectRail` 点击不同项目时，`TeamView` 的表格和统计卡片将即时按照选中项目展示，实现与主看板一致的项目筛选联动。

### 2.6 Pencil 设计稿对齐修订
- 使用 Pencil MCP 对 `design/trellis-board-redesign.pen` 进行增量修订：
  1. 在画板 05（管理台）顶栏添加暗黑模式切换按钮，保持 SaaS 顶栏统一。
  2. 在组件库帧中注册标准的 `Trellis Logo` 组件，消除孤立的手绘散落图层。
