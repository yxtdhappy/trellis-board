# PRD: web 控件统一（shadcn 优先 + 高度三档）

## Goal

把 `web/src` 各页面的交互控件收敛到统一高度档位与统一组件来源：优先 shadcn `components/ui/*`，消除 `h-7/h-8/h-9/h-10/h-7.5` 混用、页面层重复覆盖、以及本该用 `Button` 的裸 `<button>`。

## Background

- `web/src/components/ui/input.tsx:11` 默认 `h-7`，`select.tsx:41` 默认 `h-8`（`sm` 变体 `h-7`），`button.tsx:23-29` 默认 `h-7`、`sm h-6`、`lg h-8`、`icon size-7`。三个同排控件天然不等高。
- 页面层用 `h-8` 覆盖了约 30 处（`TopBar.tsx:87/94`、`ArchiveView.tsx:113/121/131/143`、`ExecutionHeader.tsx:79/141/199`、`TeamView.tsx:110/149/160/172/182/192/202/224/235`、`SavedViewsDialog.tsx:101/151/160/172/182/196/203`、`TaskDetailDialog.tsx:99/452/461/469/575/585/593/642/652/670`、`PublishOperationDialog`、`TaskOperationList.tsx:90/102`、`admin/TeamsTab.tsx:215`）。
- 离群高度：`ProjectManagerDialog.tsx:152 h-10`、`:161/:173 h-9`；`ProjectRail.tsx:302/321/322 h-7.5`。
- 裸 `<button>` 承担按钮职责：`AttentionQueue.tsx:38`、`Kanban.tsx:99`、`Pagination.tsx:81`、`ArchiveView.tsx:106/249`、`ExecutionHeader.tsx:62/76/96/99/110`、`TeamView.tsx:107/232`、`SavedViewsDialog.tsx:111/131`、`ProjectRail.tsx:298/316/347/384/406/441`、`TopBar.tsx:64`、`AdminPage.tsx:176`、`TaskDetailDialog.tsx:611`、`TaskCard.tsx:130/141`。

## Requirements

### R1 尺寸档位（唯一权威）

| 档位 | 高度 | 用途 | 组件 |
| --- | --- | --- | --- |
| 主档 | 32px (`h-8`) | 表单与工具栏默认控件 | `Input`、`SelectTrigger` 默认、`Button` 默认、`Button size="icon"` |
| 紧凑 | 28px (`h-7`) | 密集行内操作 | `Button size="sm"`、`SelectTrigger size="sm"`、`Button size="icon-sm"` |
| 微型 | 24px (`h-6`) | 标签/胶囊态操作 | `Button size="xs"`、`Button size="icon-xs"`、badge/pill |

- `Button size="lg"` 与 `size="icon-lg"` 为 36px (`h-9`)，仅用于强调型主操作（如空态 CTA）。
- 行内文字：控件内 ≥ `text-xs`（12px）；11px 仅允许出现在 badge/pill；删除 `text-[10px]`/`text-[11.5px]` 之类的控件字级。

### R2 组件原语改动（只改尺寸，不改结构）

- `web/src/components/ui/input.tsx` 默认 `h-7` → `h-8`，`px-2 py-0.5` → `px-2.5 py-1`。
- `web/src/components/ui/button.tsx`：`default h-7→h-8`、`xs h-5→h-6`、`sm h-6→h-7`、`lg h-8→h-9`、`icon size-7→size-8`、`icon-xs size-5→size-6`、`icon-sm size-6→size-7`、`icon-lg size-8→size-9`；`[&_svg]` 维持与档位匹配的 3.5/4。
- `web/src/components/ui/select.tsx`：默认 `h-8` 保持，`sm` 变体 `h-7` 保持；不新增档位。
- 其余 shadcn 原语（`table.tsx:60` 表头 `h-10`、`tabs.tsx` `h-8`、`dropdown-menu` 的 `min-h-7`）不动。

### R3 页面层收敛

- 删除与新默认值重复的 `h-8` 覆盖；删除全部 `h-9`/`h-10`/`h-7.5`；`ProjectRail.tsx:302/321/322` 与 `ProjectManagerDialog.tsx:152/161/173` 按档位选组件属性，不再手写高度。
- 胶囊态操作改用 `size="xs"`；密集行内操作改用 `size="sm"`；去掉手写 `h-6`/`h-8` 与 `text-[10px]`/`text-[11px]`/`text-[11.5px]`。
- 承担按钮职责的裸 `<button>` 改用 shadcn `Button`（`ghost`/`outline`/`secondary`），保留：卡片覆盖命中区（`TaskCard.tsx:56`）、拖拽容器、纯 tab 语义容器（需保留 `role="tab"` 时用 `Button variant="ghost"` 亦可）。
- `SelectField`（`web/src/features/board/SelectField.tsx`）去掉 `text-[13px]` 硬编码，跟随 `SelectTrigger` 默认字号。

### R4 不改动项

- 不改 token 色值、圆角尺度、间距体系；不改 dialog 的「固定 header/footer + 单一 `DialogBody` 滚动壳」结构。
- 不新增依赖，不新增 shadcn 组件文件。

## Acceptance Criteria

1. `Input`、`SelectTrigger`（默认）、`Button`（默认）在同一行渲染高度一致为 32px；`size="sm"` 为 28px；`size="xs"` 为 24px。
2. `grep -rn "h-9\|h-10\|h-7\.5" web/src` 仅剩 `web/src/components/ui/table.tsx:60`（表头行，非控件）。
3. `grep -rn "h-8" web/src/features web/src/components/layout web/src/pages` 无结果（页面层不再覆盖主档高度）。
4. 裸 `<button>` 仅剩豁免清单中的布局/命中区/tab 容器；其余全部为 shadcn `Button`。
5. 视觉验收：pipeline / team / archive / plugins / admin 七个 tab / login 截图，控件基线对齐、无换行溢出、dialog 滚动壳行为不变。
6. `npm --prefix web run lint`、`npm --prefix web run build`、`npm test` 通过；`npm run format` 后无 diff。
