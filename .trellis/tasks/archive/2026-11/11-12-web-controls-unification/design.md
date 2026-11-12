# Design: web 控件统一

## 变更面

三层，自底向上：

1. **shadcn 原语尺寸**：`web/src/components/ui/input.tsx`、`button.tsx`（`select.tsx` 已是 32/28，仅去掉页面层凑合用的覆盖）。
2. **业务包装**：`web/src/features/board/SelectField.tsx`（去 `text-[13px]`）。
3. **页面/弹层调用点**：删除冗余高度类、把裸 `<button>` 换成 `Button`。

不动 token（`web/src/index.css`）、不动 `@theme inline` 的 radius 尺度。

## 原语改动（精确 cva 差异）

`web/src/components/ui/input.tsx:11`

```
- h-7 w-full min-w-0 rounded-md border border-input bg-input/20 px-2 py-0.5 text-sm
+ h-8 w-full min-w-0 rounded-md border border-input bg-input/20 px-2.5 py-1 text-sm
```

`web/src/components/ui/button.tsx:23-29`

```
- default: h-7 gap-1 px-2 text-xs/relaxed … [&_svg…]:size-3.5
+ default: h-8 gap-1 px-2.5 text-xs/relaxed … [&_svg…]:size-4
- xs:      h-5 gap-1 rounded-sm px-2 text-[0.625rem] … :size-2.5
+ xs:      h-6 gap-1 rounded-sm px-2 text-[0.6875rem] … :size-3
- sm:      h-6 gap-1 px-2 text-xs/relaxed … :size-3
+ sm:      h-7 gap-1 px-2 text-xs/relaxed … :size-3.5
- lg:      h-8 gap-1 px-2.5 text-xs/relaxed … :size-4
+ lg:      h-9 gap-1 px-2.5 text-xs/relaxed … :size-4
- icon:      size-7 … :size-3.5     → size-8 … :size-4
- icon-xs:   size-5 … :size-2.5     → size-6 … :size-3
- icon-sm:   size-6 … :size-3       → size-7 … :size-3.5
- icon-lg:   size-8 … :size-4       → size-9 … :size-4
```

`default` 的 `px-2 → px-2.5` 让 32px 高的按钮与 `Input`（`px-2.5`）左右内边距对齐。

## 页面替换规则

| 现状 | 改为 |
| --- | --- |
| `Button className="h-8 …"` | 删除 `h-8`（默认已 32px） |
| `Input className="h-8 …"` | 删除 `h-8` |
| `SelectField className="h-8 …"` | 删除 `h-8`（`SelectTrigger` 默认 32px） |
| `Button size="sm" className="h-8 …"` | `Button`（默认档）或保留 `size="sm"` 去掉 `h-8`，按视觉密度二选一 |
| `Button size="sm" className="h-6 …"` / `h-6 text-[10px]` | `size="xs"` |
| `Button className="h-10 …"` / `h-9 …` | 删高度类（`ProjectManagerDialog.tsx:152/161/173`） |
| `className="h-7.5 …"` | `h-8`（`ProjectRail.tsx:302/321/322`） |
| `text-[11.5px]` / `text-[11px]`（控件内） | `text-xs`；pill/badge 内允许 `text-[11px]` |

### 裸 `<button>` → `Button` 映射

- 图标按钮（`ProjectRail.tsx:384/406/441`、`TopBar.tsx:64`、`ExecutionHeader.tsx:62/76/96/99/110`、`SavedViewsDialog.tsx:111/131`、`TeamView.tsx:107/232`、`ArchiveView.tsx:106/249`、`AdminPage.tsx:176`）：`<Button variant="ghost" size="icon-sm">` 或 `size="icon"`。
- 文本/主操作（`ProjectRail.tsx:298/316/347`、`AttentionQueue.tsx:38`、`Kanban.tsx:99`、`Pagination.tsx:81`、`TeamView.tsx:110/235`、`ArchiveView.tsx:113`、`ExecutionHeader.tsx:79`）：`variant="outline"/"ghost"/"default"` + 默认档。
- `TaskDetailDialog.tsx:611`（关闭/次级）→ `Button variant="ghost" size="sm"`。
- 保留裸元素：`TaskCard.tsx:56`（整卡覆盖命中区，`absolute inset-0`，改 `Button` 会引入 button 语义与 focus ring 冲突）、拖拽容器、`Pagination` 中纯文案类 `<span>`。

## 风险与对策

- `size="sm"` 从 24px 变 28px 会让密集列表（`TaskOperationList`、`TeamsTab`、`SavedViewsDialog`）行高增加 4px → 这些位置优先改用 `size="xs"`，保持 24px。
- `Input` `px-2 → px-2.5` 在固定宽度输入框（`TopBar.tsx:87 w-[230px]`）里让可用文字区少 4px → 视觉检查该处 placeholder 不截断。
- `Table` 表头 `h-10` 保持不变，避免表格行基线错位。
- 逐页截图对照是唯一有效的验收手段：高度类消失不等于视觉正确。

## 验证

- `npm --prefix web run lint`；`npm --prefix web run build`；`npm test`（根）。
- grep 断言见 PRD Acceptance 2/3/4。
- 浏览器逐页走查（`npm run web:dev` + `npm run board`），重点：TopBar、Team 筛选行、TaskDetailDialog 表单区、SavedViewsDialog、ProjectManagerDialog、ProjectRail。
