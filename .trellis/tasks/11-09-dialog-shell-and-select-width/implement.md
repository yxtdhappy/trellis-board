# 实施计划

## 步骤

1. **共享骨架** `web/src/components/ui/dialog.tsx`
   - `DialogContent`：`grid` → `flex flex-col`，加 `max-h-[calc(100dvh-2rem)] overflow-hidden`。
   - `DialogHeader`、`DialogFooter`：加 `shrink-0`。
   - 新增并导出 `DialogBody`（`data-slot="dialog-body"`，`min-h-0 flex-1 overflow-y-auto overscroll-contain`）。

2. **Markdown 引擎** `web/src/lib/markdown.js`
   - `npm --prefix web install markdown-it`（只加这一个依赖）。
   - 重写为 `new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false })` 单例；`link_open` 规则补 `target="_blank" rel="noopener noreferrer"`。
   - `md.core.ruler.after("inline", "task-lists", …)`：把 `[x] ` / `[ ] ` 前缀换成 `<span class="md-checkbox …">`，保留 `aria-label`。
   - 保留 `escapeHtml` 与 `renderMarkdown(markdown)` 导出；删除 `renderInline`/`renderList`/`renderTable` 等自研解析函数。
   - 更新 `tests/markdown.test.js`：结构断言改为新输出（`<s>`、`<pre><code class="language-js">`、无 `.md-table-wrap`），安全断言（无 `<script>`、`javascript:` 不生成链接、`rel="noopener noreferrer"`）保持并通过。

3. **board 弹层**（`web/src/features/board/dialogs/`）
   - `TaskDetailDialog`：主弹层内容包 `DialogBody`；工件弹层改为 header → body（Markdown）→ footer，Markdown 容器换成 design.md 中的换行/表格/代码块类，删 `prose prose-sm`。
   - `ProjectManagerDialog`、`AssignmentsDialog`、`AssigneeWarningDialog`、`PublishOperationDialog`：内容包 `DialogBody`。
   - `CreateTaskDialog`、`PasswordDialog`：form 变 `flex min-h-0 flex-1 flex-col`，字段包 `DialogBody`，footer 留在 form 内。
   - `SavedViewsDialog`：去掉 `max-h-[88dvh] overflow-y-auto`，表单包 `DialogBody`。

4. **admin / plugins 弹层**
   - `AccountDialog`（`AccountForm` 字段区）、`ApproveProjectDialog`（摘要 + `ApprovalForm` 字段区）、`ResetPasswordDialog`（form）、`SshTrustDialog`、`ProjectCredentialDialog`、`OneTimeCredentialDialog`：内容包 `DialogBody`。
   - `PluginLogsDialog`：`<pre>` 包 `DialogBody`，删除 `max-h-[52vh]`，保留 `whitespace-pre-wrap`。

5. **Select** `web/src/components/ui/select.tsx`
   - `SelectContent`：`w-(--anchor-width) min-w-32` → `min-w-(--anchor-width) max-w-(--available-width)`。
   - `SelectItemText`：`shrink-0 ... whitespace-nowrap` → `min-w-0 ... whitespace-normal break-words`。

6. **格式化与检查**
   - `npm run format`（`oxfmt .`，配置见步骤 9）。
   - `npm test`（markdown 渲染与安全断言）。
   - `npm --prefix web run lint`（oxlint）。
   - `npx tsc -b web`。
   - 不跑 build / dev server。

7. **Markdown 样式与高亮**
   - `npm --prefix web install github-markdown-css markdown-it-highlightjs highlight.js`。
   - `web/src/lib/markdown.js`：`md.use(highlightjs, { hljs })`，`hljs` 取 `highlight.js/lib/common`（37 种常用语言，不引全量包）；围栏代码块输出 `<pre><code class="hljs language-js">`。
   - 新增 `web/src/lib/markdown-theme.ts`：`github-markdown-light/dark.css?inline` 与 `highlight.js/styles/github{,-dark}.css?inline` 合并；导出 `applyMarkdownTheme(theme)`，写入 `<style id="markdown-theme">`（不存在则创建并 append 到 `document.head`）。
   - `web/src/app/theme.tsx` 的 effect 里调用 `applyMarkdownTheme(theme)`，与 `.dark` class 切换同帧生效。
   - `TaskDetailDialog` 工件容器：`className="markdown-body max-w-none break-words [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_img]:max-w-full"`。
   - `tests/markdown.test.js` 代码块断言改为 `hljs` 结构（`<code class="hljs language-js">`、`<span class="hljs-string">`），安全断言不变。

8. **归档项目筛选同步**
   - `ArchiveView` 删除 `project` state 与项目 `SelectField`，改为接收 `projectId` prop；`rows` 过滤与右侧项目文案都读它。
   - `BoardPage` 传 `projectId={filters.projectId}`；切换左侧 `ProjectRail` 即同步（`setFilters` 已存在）。
   - 切项目时重置分页：`BoardPage` 用 `<ArchiveView key={filters.projectId} …>` 重挂载；不用 `useEffect` + `setPage`，避免 oxlint `react(set-state-in-effect)`。

9. **oxfmt 接入**
   - 根 `package.json` 加 devDependency `oxfmt`，脚本 `format` / `format:check`。
   - 配置文件与现有风格对齐（无分号、单引号、2 空格、printWidth 100），忽略 `public/`、`.trellis/`、`node_modules/`。
   - 全仓跑一次 `npm run format`，再 `npm run format:check` 确认幂等。

## 自检清单

- [x] `grep -n "overflow-y-auto" web/src/features/**/dialogs/*.tsx` 不再出现在 `DialogContent` 上。
- [x] 每个 `<DialogContent>` 内部都有且只有一个 `<DialogBody>`（`PluginLogsDialog` 同样）。
- [x] 表单弹层的 `<Button type="submit">` 仍在 `<form>` 内。
- [x] Markdown 工件预览的容器含 `break-words` 与 `[&_pre]:whitespace-pre-wrap`。
- [x] `web/src/lib/markdown.js` 只剩 markdown-it 实例、`link_open` 规则、任务清单规则与 `escapeHtml`，无自研解析函数残留。
- [x] `npm test` 全绿，安全断言（无 `<script>`、`javascript:` 不生成链接、`rel="noopener noreferrer"`）仍在。
- [x] Select 改动只落在共享组件，业务调用点无改动。

## 风险与回退

- 弹层宽度/高度视觉变化集中在 `max-h` 与 header/footer 固定；如出现内容被裁切，优先检查是否漏包 `DialogBody`。
- 下拉变宽属预期；若个别场景需要固定宽度，可在调用点用 `className` 覆盖（本轮不做）。
