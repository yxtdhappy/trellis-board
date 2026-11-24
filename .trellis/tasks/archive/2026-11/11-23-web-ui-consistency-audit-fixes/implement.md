# 实施计划：全局 UI 一致性与视觉缺陷治理

## 1. 推荐执行顺序

1. **阶段 A（基准建立与首报问题修复）**：
   - 实施并归档子任务 1：`11-23-task-detail-close-button-alignment`（轻量级单文件快速交付）
   - 实施并归档子任务 2：`11-23-ui-primitives-foundation`（全站原语底座）
2. **阶段 B（全站弹窗标准化）**：
   - 实施并归档子任务 3：`11-23-dialogs-ui-consistency-fixes`（依赖阶段 A）
3. **阶段 C（业务页面与桌面端并行推进，可任意顺序独立交付）**：
   - 子任务 4：`11-23-board-layout-views-ui-fixes`
   - 子任务 5：`11-23-admin-plugins-ui-fixes`
   - 子任务 6：`11-23-desktop-ui-fixes`
4. **阶段 D（父任务集成复核）**：
   - 全部 6 个子任务归档后，启动父任务做跨页视觉与代码一致性复核，整理可沉淀到 `.trellis/spec/` 的前端 UI 规范后归档父任务。

## 2. 统一验证门禁

每个子任务在提交前必须执行以下检查（遵循全局验证规则，不运行 build 与 dev server）：

```powershell
npx oxfmt <changed-files>
yarn format:check
yarn workspace @trellis-board/web lint
npx tsc -p packages/web/tsconfig.app.json --noEmit
yarn test
git ls-files --eol | rg 'i/crlf'
```

## 3. 回滚点

- 阶段 A（原语改造）单独提交，若引起全局意外样式偏移，可通过原语层单次回退恢复。
- 阶段 B/C 按业务域拆分为独立提交，互不耦合。
