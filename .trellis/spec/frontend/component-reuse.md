# 组件复用与 ui 层规范

适用范围：`packages/web/src`。目标是同一类 UI 只有一处实现：原语在 `components/ui/`，业务组合在 `features/`，页面只做组装。

## 分层与依赖方向

| 层 | 目录 | 职责 | 允许 import |
| --- | --- | --- | --- |
| ui 原语 | `components/ui/*` | Base UI / shadcn 包装，唯一接触底层原语的地方 | `@base-ui/react/*`、`cn`、其它 `ui/*` |
| 布局外壳 | `components/layout/*` | `TopBar`、`ProjectRail` 等应用外壳 | `ui/*`、`lib/*`、`hooks/*` |
| 业务组件 | `features/<domain>/*` | 领域组件与领域内组合 | `ui/*`、`lib/*`、`api/*`、`hooks/*`、同域文件 |
| 页面 | `pages/*` | 路由入口与组装 | 以上全部 |

- **只有 `components/ui/*` 可以 import `@base-ui/react/*`。** 视图层直接 import 会把底层 API 散到全仓，升级 Base UI 时无法收敛。
- `ui/*` 里的 `cn` 从 `'cn'` 导入（shadcn CLI 产物约定，`cn` 是已声明依赖，等价 clsx + tailwind-merge）；业务代码用 `@/lib/utils`。
- 依赖单向：`pages → features → ui`。`features` 不 import `pages`，业务组件不 import 另一个域的**内部**实现。
- 共享纯逻辑放 `src/lib/`（`dom/markdown/execution-filter/archive-sort/team-client`），它们被 `packages/test-support/` 直接 import，改行为等于改公共契约。

## 组件选择矩阵

| 需求 | 用它 | 不要用 |
| --- | --- | --- |
| 带内容面板的视图切换 | `ui/tabs`（`Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`） | 自写 button + state |
| 无面板的纯选项切换（单选集合） | `ui/toggle-group` | `Tabs`（会多出面板语义） |
| 布尔开关 | `ui/switch`；表单内勾选 | 裸 `input type="checkbox"` |
| 下拉单选（受控 `string`） | `features/board/SelectField` | 原生 `<select>` |
| 需要搜索/多选的下拉 | `ui/combobox` | 自写 popover + input |
| 状态药片 | `ui/status-pill`：`StatusPill`、`toneDot(tone)`、`toneSurface(tone, quiet?)` | 手拼 `bg-*-soft text-*` |
| 通用徽章 / 计数 | `ui/badge`（`Badge`、`badgeVariants`） | 自写圆角 span |
| 面板容器 | `ui/panel`（`as="section|div|aside|article"`） | 自写 `rounded-xl bg-card p-4` |
| 只读展示卡 | `ui/card` | 用 `Card` 包业务面板 |
| 表格 | `ui/table`；需要 sticky 表头时用 `Table` 的 `containerClassName` 保证滚动祖先正确 | 手写 `<table>` |
| 表单行 | `ui/field`：`Field`/`FieldLabel htmlFor`/`FieldDescription`/`FieldError` | 自写 label + div |
| 空态 | `ui/empty-row`（单行）、`ui/empty`（整块） | 自写 `<p class="text-muted-foreground">` |
| 加载占位 | `ui/skeleton` | 文字「加载中…」 |
| 提示 / 错误条 | `ui/alert`（`AlertTitle`/`AlertDescription`/`AlertAction`） | 自写带底色的 div |
| 图标按钮 | `Button size="icon-xs|icon-sm|icon"` + `ui/tooltip` | 裸 `<button>` + `title` |
| 进度 | `ui/progress`（`trackClassName`/`indicatorClassName` 覆盖高度与配色） | 自写两层 span |
| 分隔线 | `ui/separator`（`orientation`） | `border-l` 手绘树线 |
| 客户端分页 | `features/board/Pagination` | `ui/pagination` 的 `PaginationLink/Previous/Next`（渲染 `<a>`，丢键盘语义） |
| 统计块 | `features/board/StatTile` | 自写 value + caption 卡片 |

## 禁止清单

1. 视图层 import `@base-ui/react/*`。
2. 手写状态色组合：`bg-(success|warning|destructive|primary)-soft`、`text-(success|warning|destructive)` 配底色。一律走 `toneSurface()` / `StatusPill` / `Badge`。边框透明度（`border-warning/35`）由调用侧给，helper 只管底色与文字色，两者属性不重叠。
3. 裸 `<button>` 承担按钮语义。**登记例外**（需在任务 `implement.md` 写理由）：整行/整卡热区容器、直接吃 `badgeVariants` 的 chip、拖动把手等 Button 的 `inline-flex/justify-center/active:translate-y-px` 会改布局的场景。
4. 把 `ui/` 组件实现复制到业务层。
5. 为「以后可能用到」加 props、变体或开关；只加当前调用点需要的。
6. 写死颜色（`#rrggbb`、`rgb()`）或手写 `dark:` 反色；只用 token 类。
7. 业务组件互相 import 对方的内部子组件；需要共享就提升（见下）。

## 新增与提升流程

1. **先查矩阵**，再 `rg` 一遍现有实现，确认没有可复用组件。
2. 原语缺失 → 用 shadcn CLI 生成到 `components/ui/`，不要手写一份「差不多的」。
3. 视觉不符 → 调用侧 `className` 覆盖。确实需要新钩子时**只做加法**（例如 `Progress` 的 `trackClassName`/`indicatorClassName`），默认视觉保持不变。
4. **第三处才提升**：同域重复 → `features/<域>/X.tsx`；跨域重复 → 先定落点再动，别直接塞进 `components/ui`（`ui/` 只放原语）。
5. 提升后删除原实现与遗留的 re-export 壳，不留双份入口。
6. 提升出的组件同样受本规范约束：props 用命名类型、可选 prop 有默认值、`className` 透传。

## 审计命令

在 `packages/web` 下执行；前 5 条预期无输出，例外必须在任务 `implement.md` 登记。

```bash
rg -n "<button[ >]" src -g '!**/components/ui/**'
rg -n "bg-(success|warning|destructive|primary)-soft" src -g '!**/components/ui/**'
rg -n "type=\"checkbox\"" src
rg -n "@base-ui/react" src -g '!**/components/ui/**'
rg -n "<table" src -g '!**/components/ui/**'
rg -n "<select" src -g '!**/components/ui/**'
rg -n "#[0-9a-fA-F]{6}\b" src
```

排除 glob 必须写成 `-g '!**/components/ui/**'`；写成 `-g '!components/ui/**'` 不会生效，会误报 `ui/` 自身。

## PR 前自查

- `npx tsc -b`、`npx oxlint src`、`npx oxfmt <改动文件>` 全绿。
- 新增的重复结构是第三处了吗？第二处就抽象属过度设计。
- 改动里有没有把状态色类带出 `ui/`？
- Tooltip 的触发器是否可聚焦？禁用态是否保留 `title`（Tooltip 在禁用元素上不触发，`span tabIndex=0` 会让读屏误判可操作）？
- 深色模式验证过吗？写死颜色的类在 `.dark` 下会失效。
- `ui/` 的改动是否只有加法、默认视觉未漂移？

## 旧 → 新对照

| 旧写法 | 收敛到 |
| --- | --- |
| 手写 `size-1.5 rounded-full bg-*` 圆点 | `toneDot(tone)` / 局部 `StatusDot` |
| 手写两层 span 进度条 | `ui/progress` + `trackClassName`/`indicatorClassName` |
| `border-l border-border/70` 树线 | `ui/separator orientation="vertical"` |
| 手写 `<table>` | `ui/table` |
| 手写页码按钮 | `features/board/Pagination` |
| 手写药片 / 状态徽章 | `StatusPill` / `Badge` |
| 图标按钮 + `title` | `Button` + `Tooltip`（禁用态保留 `title`） |
| 手写空态段落 | `EmptyRow` / `Empty` |
| 手写提示条 div | `Alert` |
| 手写统计卡片 | `StatTile` |
| 原生 `<select>` | `SelectField` |
| 自写 label + checkbox | `Field` + `Checkbox` |
| 重复的 `rounded-xl bg-card p-4` 容器 | `Panel` |
| 重复的「团队勾选列表」 | `features/admin/TeamCheckboxList` |
| 重复的「插件绑定表单」 | `features/admin/PluginBindingForm` |
| 重复的「受影响项目列表」 | `ArchiveSyncTab` 内 `AffectedProjectList` |
