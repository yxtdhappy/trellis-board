# Implement: web 控件统一

## 执行顺序

1. **原语**：改 `web/src/components/ui/input.tsx`、`web/src/components/ui/button.tsx` 的尺寸类（见 `design.md` 的精确 diff）。`select.tsx` 不改。
2. **包装层**：`web/src/features/board/SelectField.tsx` 去掉 `text-[13px]`。
3. **页面清理（按文件跑一遍，删除冗余 `h-8` 与离群高度）**：
   - `web/src/components/layout/TopBar.tsx`（`:64` 裸按钮、`:87` Input、`:94` Button）
   - `web/src/components/layout/ProjectRail.tsx`（`:298` 接入本地项目、`:302/321/322` `h-7.5`、`:316/347/384/406/441`）
   - `web/src/features/board/ExecutionHeader.tsx`（`:62/76/79/96/99/110/141/199`）
   - `web/src/features/board/TeamView.tsx`（`:107/110/149/160/172/182/192/202/224/232/235`）
   - `web/src/features/board/ArchiveView.tsx`（`:106/113/121/131/143/249`）
   - `web/src/features/board/AttentionQueue.tsx:38`、`Kanban.tsx:99`、`Pagination.tsx:81`、`TaskCard.tsx:130/141`（保留 `:56`）
   - `web/src/features/board/dialogs/TaskDetailDialog.tsx`（`:99/452/461/469/575/585/593/611/642/652/670`）
   - `web/src/features/board/dialogs/SavedViewsDialog.tsx`（`:101/111/131/151/160/172/182/196/203`）
   - `web/src/features/board/dialogs/ProjectManagerDialog.tsx`（`:152/161/173`）
   - `web/src/features/board/dialogs/PublishOperationDialog.tsx`、`TaskOperationList.tsx:90/102`
   - `web/src/pages/admin/AdminPage.tsx:176`、`web/src/features/admin/TeamsTab.tsx:215`
4. **grep 收口（必须为空的断言）**：
   - `grep -rn "h-8" web/src/features web/src/components/layout web/src/pages` → 0
   - `grep -rn "h-9\|h-10\|h-7\.5" web/src` → 仅 `web/src/components/ui/table.tsx:60`
   - `grep -rn "text-\[10px\]\|text-\[11.5px\]" web/src` → 0（`text-[11px]` 仅允许 badge/pill）
5. **规范沉淀**：把「32/28/24 三档 + 优先 shadcn」写进 `.trellis/spec/frontend/quality-guidelines.md`（或新建 `control-sizing.md` 并在 `index.md` 索引），含离群值豁免清单。
6. **验证**：`npm run format`（oxfmt）→ `npm --prefix web run lint` → `npm --prefix web run build` → `npm test`；`npm run web:dev` 逐页走查并截图。

## 注意

- 改 `components/ui/*` 属于「必要修改」，只动尺寸类，不重排 JSX 结构、不改 `cn()` 之外的逻辑。
- `Button` 高度变化会影响 `TaskCard`/`Kanban` 内的 `size="sm"` 用法：把这些位置的 `sm` 降为 `xs`，保持原 24px 观感。
- 不顺手重构无关代码；每个文件只做高度/字级/裸按钮替换。

## 实施记录

已完成。落地清单：

- 原语：`web/src/components/ui/input.tsx:11` 改 `h-8 px-2.5 py-1`；`web/src/components/ui/button.tsx:23-30` 六档尺寸按 design 改写（default `h-8`、xs `h-6`、sm `h-7`、lg `h-9`、icon `size-8`、icon-xs `size-6`、icon-sm `size-7`、icon-lg `size-9`）；`select.tsx`/`tabs.tsx`/`table.tsx` 未改。
- 包装层：`web/src/features/board/SelectField.tsx:37` 去掉 `text-[13px]`。
- 页面清理：TopBar、ProjectRail、ExecutionHeader、TeamView、ArchiveView、Pagination、TaskCard、ConditionChecks、TaskOperationList、TeamsTab、PluginsView、ProjectManagerDialog、PublishOperationDialog、SavedViewsDialog、TaskDetailDialog 删除全部 `h-8`/`h-9`/`h-10`/`h-7.5` 覆盖与 `text-[11.5px]` 控件字级；裸 `<button>` 除命中区/导航行外全部换成 `Button`（含 `PluginsView` 启停/日志、`TaskCard` 计划/复制任务名）。
- 规范沉淀：`.trellis/spec/frontend/quality-guidelines.md` 新增「控件尺度」与「shadcn 优先」两节（32/28/24 三档表、自定义控件豁免、裸 `<button>` 豁免清单）。
- 验证：`npm run format` → `npm --prefix web run lint`（仅既有 warning）→ `npm --prefix web run build` 通过 → `npm test` 433 pass / 0 fail / 5 skipped；浏览器实测 `/`（流水线、团队视角、任务详情弹窗）与 `/admin.html`：Input/SelectTrigger 均为 32px，`Button` default 32px、`size="sm"` 28px、胶囊 26px，无离群高度。
- 收口 grep 结果：`h-9|h-10|h-7.5` 仅剩 `web/src/components/ui/table.tsx:60`；`h-8` 仅剩 `web/src/features/admin/shared.tsx:7`、`web/src/features/admin/MultiSelectField.tsx:55`（自定义控件）与 `web/src/components/layout/ProjectRail.tsx:322-323`（32px 导航行）。

