# 统一弹层骨架与下拉宽度

## Goal

统一 `web/src` 里所有 Dialog 的骨架（header/footer 固定、内容区滚动），让 Markdown 工件预览沿用同一骨架并支持自动换行，并修复 Select 下拉选项文字被截断的问题。

## Background

- 现有 `DialogContent` 是 `grid` 容器，没有高度上限，也没有内部滚动区：[dialog.tsx](../../../web/src/components/ui/dialog.tsx:100)。
- 只有 3 处弹层自己加了 `max-h-[..] overflow-y-auto`（`TaskDetailDialog` 主弹层/工件弹层、`SavedViewsDialog`），滚动的是整个弹层，header 和 footer 会一起滚走；其余 13 处弹层内容变长时直接撑出视口。
- Markdown 工件预览容器只带 `prose` 类（项目未安装 typography 插件，该类实际不生效），`renderMarkdown()` 产出的 `<pre class="md-code">` 默认 `white-space: pre`，长行不会换行，会把弹层横向撑破：[TaskDetailDialog.tsx](../../../web/src/features/board/dialogs/TaskDetailDialog.tsx:598)。
- `SelectContent` 固定为 `w-(--anchor-width)`，选项文字又带 `whitespace-nowrap`，超出触发器的文字被 `overflow-x-hidden` 裁掉；项目名、负责人名较长时下拉只显示半截：[select.tsx](../../../web/src/components/ui/select.tsx:84)、[select.tsx](../../../web/src/components/ui/select.tsx:125)。

## Requirements

### 1. Dialog 骨架

- 在 `components/ui/dialog.tsx` 增加 `DialogBody`：`min-h-0 flex-1 overflow-y-auto`，作为唯一滚动区；导出给业务弹层使用。
- `DialogContent` 改为 `flex flex-col`、`max-h-[calc(100dvh-2rem)]`、`overflow-hidden`，保持现有 `p-4 gap-4` 与默认宽度。
- `DialogHeader` / `DialogFooter` 增加 `shrink-0`，滚动时保持不动。
- 全部 16 处 `<DialogContent>` 改用新骨架：内容主体包进 `<DialogBody>`，删除各自临时的 `max-h-*`/`overflow-y-auto`。
- 表单类弹层（`PasswordDialog`、`CreateTaskDialog`、`ResetPasswordDialog`、`AccountDialog`、`ApproveProjectDialog`）保持 `<form>` 包裹内容主体与 footer，form 自身 `flex min-h-0 flex-1 flex-col`，保证提交按钮仍作用于表单。

### 2. Markdown 预览弹层

- 工件预览弹层改用同样的 header/body/footer 骨架，header 与关闭按钮固定。
- **渲染引擎换成 `markdown-it`**（新增依赖，替换 `web/src/lib/markdown.js` 里自研的逐行解析器），保留导出名 `renderMarkdown` / `escapeHtml`，调用点不变。
- 保持安全边界：`html: false` 不解析原始 HTML，链接协议白名单（`http/https/mailto/#`）沿用 markdown-it 的 `validateLink`，外链统一补 `target="_blank" rel="noopener noreferrer"`。
- 保持现有语义能力：表格、围栏代码块、引用、嵌套列表、任务清单（`- [x]`）；任务清单继续输出 `.md-checkbox` 标记，不为它再引入插件依赖。
- 内容区支持自动换行：普通文本、链接、行内代码、`<pre>` 代码块、表格单元格都要 `break-words`，代码块 `whitespace-pre-wrap`，不出现横向滚动条撑破弹层。
- 同步更新 `tests/markdown.test.js`：断言改为 markdown-it 的输出结构，XSS / 危险链接 / `rel=noopener` 安全断言必须继续生效。

### 3. Select 下拉宽度

- 只改共享组件 `components/ui/select.tsx`，不改业务调用点（`SelectField` 与直接使用 `Select` 的 `ExecutionHeader` 同时生效）。
- `SelectContent` 宽度：`min-w-(--anchor-width)` + `max-w-(--available-width)`（Base UI 官方推荐写法），按内容自适应，不再固定等于触发器宽度。
- 选项文字：移除 `whitespace-nowrap`/`shrink-0`，改为可换行（`whitespace-normal break-words min-w-0`），极端长文本也不会被裁切。
- 触发器内的选中值仍保持单行（`line-clamp-1`），不改现有高度。

### 4. 代码统一格式化（oxfmt）

- 引入 `oxfmt`（Oxc 官方格式化器，与仓库现有 `oxlint` 同厂）作为唯一格式化工具，不再引入 Prettier。
- 根 `package.json` 暴露 `format`（写入）与 `format:check`（只校验）两个脚本，覆盖 `web/src`、`web/*.ts(x)`、`tests/`、`server/`、`shared/`。
- 配置与现有风格对齐（无分号、单引号、2 空格缩进、printWidth 100），排除构建产物 `public/` 与 `.trellis/`。
- 首次接入时对全仓跑一次，之后新代码只需 `npm run format`。

### 5. Markdown 预览样式与代码高亮

- markdown-it 只输出 HTML、**不自带任何 CSS**，需要外部样式；当前表格、代码块、引用、任务标识都没有样式（旧渲染器同样没有，`.md-table-wrap` 从未被定义过）。
- 引入 `github-markdown-css`（GitHub 官方 Markdown 版式，`.markdown-body` 作用域）承担排版；`web/src/index.css` 不建 `.md-preview` 规则，也不引 tailwind typography（两者版式功能重复，只保留一套）。
- 引入 `markdown-it-highlightjs` + `highlight.js`（`lib/common` 37 种常用语言，不用全量包）给围栏代码块上 token 高亮；配套 `highlight.js/styles/github.css` / `github-dark.css` 主题。
- 主题跟随应用开关：`github-markdown-css` 的浅色/深色是两份字面颜色文件（`.markdown-body` 直接写 `color`/`background-color`，没有变量层），不能同时全局引入。做法是把两份 markdown CSS 与两份 hljs 主题都用 `?inline` 引入，合并注入一个 `<style id="markdown-theme">`，由 `ThemeProvider`（`web/src/app/theme.tsx`，切换时给 `<html>` 加 `.dark`）按当前主题改写其内容。
- 工件预览容器改用 `markdown-body` 类，保留 `break-words` 与代码块 `whitespace-pre-wrap` 的自动换行要求。
- 同步更新 `tests/markdown.test.js`：代码块断言改为 `hljs` 输出结构，安全断言（无 `<script>`、`javascript:` 不生成链接、`rel="noopener noreferrer"`）必须继续生效。

### 6. 归档索引项目筛选同步

- 归档页的项目筛选必须与左侧 `ProjectRail` 共用同一个 `filters.projectId`；删除 `ArchiveView` 内部的 `project` state 和「项目」下拉框。
- 保留负责人筛选、搜索框与右侧当前项目文案（文案读取同一个 `projectId`）。

## Acceptance Criteria

- [x] 任意弹层内容超长时，header 和 footer 始终可见，只有中间内容区滚动；页面本身不出现弹层纵向滚动。
- [x] 16 处弹层全部使用 `DialogBody`，不再残留 `max-h-[..dvh] overflow-y-auto` 的整层滚动写法。
- [x] 打开任务详情里的 Markdown 工件预览，长段落、长代码行、长表格单元格都自动换行，弹层不出现横向滚动。
- [x] 工件预览由 `markdown-it` 渲染：标题/粗体/斜体/删除线/行内码/列表/嵌套列表/表格/代码块/引用/任务清单均正确；原始 HTML 不执行，`javascript:` 链接不生成 `<a>`，外链带 `rel="noopener noreferrer"`。
- [x] `npm test` 通过（`tests/markdown.test.js` 已按新引擎更新，安全断言保留）。
- [x] 项目/负责人等长选项在任意页面（团队视角、归档、管理台、创建任务、任务详情）下拉中完整显示，不超过视图可用宽度。
- [x] `npm --prefix web run lint` 与 `npx tsc -b web` 通过；不运行 build/dev server。
- [x] 现有 `tests/` 不受影响（本次不改 `web/src/lib/` 纯逻辑导出）。
- [x] 归档索引：左侧切换项目后列表立即按该项目过滤，页面里只剩负责人下拉；选「全部项目」时恢复全量。
- [x] Markdown 预览使用 `.markdown-body` 版式：表格有表头底色与边框、代码块有底色、引用有左边线；围栏代码块带 `hljs` token 高亮；切换应用主题时预览配色随之切换，自动换行不回退。
- [x] `npm run format` 幂等（连续运行第二次无 diff），`npm run format:check` 通过，`public/` 与 `.trellis/` 未被格式化。

## Notes

- 不改服务端、不改 API、不改弹层业务逻辑，只调整共享 UI 组件、弹层结构与归档页筛选来源。
- 依赖变更五项：`web` 新增 `markdown-it`、`github-markdown-css`、`markdown-it-highlightjs`、`highlight.js`（后两者用于代码高亮），根目录新增 `oxfmt` devDependency；不装 tailwind typography，不装 Prettier。
- 归档页项目筛选改由 `BoardPage` 的 `filters.projectId` 驱动（`ArchiveView` 从 props 接收），不新增筛选状态。
- 首轮格式化会改动较多文件（换行/引号/分号），属一次性基线，后续 diff 保持稳定。
- 轻量偏中等任务：需要 `design.md` + `implement.md` 说明骨架契约与改动清单。
