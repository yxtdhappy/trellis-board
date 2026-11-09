# 设计：统一弹层骨架与下拉宽度

## 1. Dialog 骨架契约

`components/ui/dialog.tsx` 新增并调整：

```tsx
// DialogContent
"fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-hidden rounded-xl border border-border bg-card p-4 text-xs/relaxed shadow-lg ..."

// DialogHeader / DialogFooter
+ "shrink-0"

// DialogBody
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-body" className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", className)} {...props} />
}
```

约定：

- `DialogContent` 只负责外框、最大高度与圆角裁剪，自身不滚动。
- 业务弹层顺序固定为 `DialogHeader` → `DialogBody` → `DialogFooter`（无 footer 的弹层允许 header → body）。
- 需要固定行为的内容（提示条、列表说明）放在 `DialogBody` 内随内容滚动；操作按钮放 `DialogFooter`。
- 表单弹层：`<form className="flex min-h-0 flex-1 flex-col gap-*">`，字段区用 `DialogBody` 包裹，`DialogFooter` 留在 form 内，保证 submit 语义不变。

`max-h-[calc(100dvh-2rem)]` 与既有 `max-w-[calc(100%-2rem)]` 对称，四周各留 16px，桌面端不再单独写 `88dvh`。

## 2. Markdown 渲染（markdown-it）

- 依赖：`npm --prefix web install markdown-it`（写入 `web/package.json` 的 `dependencies`）。不装 `@types/markdown-it`（`web/tsconfig.app.json` 为 `allowJs: true, checkJs: false`，类型只经 `markdown.d.ts` 单向暴露）。
- `web/src/lib/markdown.js` 收敛为：模块级单例
  `new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false })`
  + `link_open` 渲染规则补 `target="_blank"` / `rel="noopener noreferrer"`
  + 任务清单 core 规则
  + 保留 `escapeHtml`。
- 导出保持 `escapeHtml`、`renderMarkdown(markdown)`；`markdown.d.ts` 不变（仍是单参数 `renderMarkdown(source: unknown): string`），唯一调用点 `TaskDetailDialog.tsx:605` 无需修改。
- 安全边界：`html: false` 把原始 HTML 转义为文本；markdown-it 的 `validateLink` 默认拒绝 `javascript:` / `vbscript:` / `data:` 等危险协议，危险链接退化为纯文本 `[危险](javascript:alert(1))`。
- 任务清单：`md.core.ruler.after("inline", "task-lists", …)` 扫描 `list_item_open → paragraph_open → inline` 序列，inline 内容以 `[x] ` / `[ ] ` 开头时截掉前缀，并把 `<span class="md-checkbox is-checked" aria-label="已完成">✓</span>` 以 `html_inline` 插到 children 首位。已知边界：仅识别列表项首段内的任务标记（与旧解析器行为一致）。
- 输出结构变化，CSS 必须按新结构写：
  - 代码块 `<pre><code class="language-js">`（不再有 `.md-code` / `data-language`）
  - 表格 `<table><thead>…`（不再有 `.md-table-wrap`），列对齐走 `style="text-align:right"`
  - 删除线 `<s>`（旧实现为 `<del>`）
- `tests/markdown.test.js` 同步更新：结构断言改为新输出；「原始 HTML 不执行」「`javascript:` 不生成链接」「外链带 `rel="noopener noreferrer"`」三类安全断言必须保留并通过；`escapeHtml` 断言不变。

```tsx
<DialogBody
  className="markdown-body max-w-none break-words [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_img]:max-w-full"
  dangerouslySetInnerHTML={{ __html: renderMarkdown(artifact?.entry?.content || '（无可预览内容）') }}
/>
```

- 排版由 `github-markdown-css` 的 `.markdown-body` 承担，不再自建 `.md-*` 版式规则；也不叠加 tailwind typography，避免两套版式互相覆盖。
- 换行只靠 CSS：`break-words` + 代码块 `whitespace-pre-wrap`，表格随容器宽度换行。
- 深浅色由 `lib/markdown-theme.ts` 注入：markdown light/dark 两份与 hljs 两份 CSS 合并写入 `<style id="markdown-theme">`。

## 3. Select 下拉

```tsx
// SelectContent
- "w-(--anchor-width) min-w-32 ..."
+ "min-w-(--anchor-width) max-w-(--available-width) ..."

// SelectItemText
- "flex flex-1 shrink-0 gap-2 whitespace-nowrap"
+ "flex min-w-0 flex-1 gap-2 whitespace-normal break-words"
```

理由：Base UI Select 官方示例用 `min-w-[var(--anchor-width)]`，Popup 宽度按内容收缩；`--available-width` 是 Positioner 暴露的剩余视口宽度，用它封顶即可避免超出屏幕。`SelectField` 与 `ExecutionHeader` 都经由 `SelectContent`，因此一处修改覆盖全部业务下拉。

风险：下拉变宽后可能盖住触发器右侧内容——这是预期行为（与浏览器原生 select 一致）；触发器自身宽度不变。

## 4. 影响面清单（16 处 DialogContent）

| 文件 | 内容主体处理 |
| --- | --- |
| `features/board/dialogs/TaskDetailDialog.tsx` | 主弹层 + 工件弹层各包一层 body |
| `features/board/dialogs/ProjectManagerDialog.tsx` | 列表/路径输入包 body |
| `features/board/dialogs/CreateTaskDialog.tsx` | form → body + footer |
| `features/board/dialogs/PasswordDialog.tsx` | form → body + footer |
| `features/board/dialogs/SavedViewsDialog.tsx` | 筛选表单包 body，去掉 `max-h/overflow` |
| `features/board/dialogs/AssignmentsDialog.tsx` | 列表 + 说明包 body（无 footer） |
| `features/board/dialogs/AssigneeWarningDialog.tsx` | 提示块 + 错误包 body |
| `features/board/dialogs/PublishOperationDialog.tsx` | 状态详情包 body |
| `features/plugins/PluginLogsDialog.tsx` | 日志 `<pre>` 包 body，去掉 `max-h-[52vh]` |
| `features/admin/AccountDialog.tsx` | `AccountForm` 的字段区包 body |
| `features/admin/ApproveProjectDialog.tsx` | 摘要 + `ApprovalForm` 字段区包 body |
| `features/admin/ProjectCredentialDialog.tsx` | 凭据选择包 body |
| `features/admin/ResetPasswordDialog.tsx` | form → body + footer |
| `features/admin/SshTrustDialog.tsx` | 指纹列表包 body |
| `features/admin/OneTimeCredentialDialog.tsx` | 凭据展示包 body |

数据流、接口、状态管理均不变。

非弹层改动两处：

| 文件 | 变化 |
| --- | --- |
| `web/src/lib/markdown.js` | 自研解析器整体替换为 `markdown-it` 实例 + 任务清单规则；`escapeHtml`、`renderMarkdown` 导出不变；`markdown.d.ts` 不动 |
| `tests/markdown.test.js` | 结构断言改按 markdown-it 输出；安全断言保留 |

## 5. 验证策略

- `npm test`（`node --test tests/*.test.js`，覆盖 markdown 渲染与安全断言）。
- `npx tsc -b web`（类型）与 `npm --prefix web run lint`（oxlint）。
- 不跑 build、不启动 dev server（AGENTS.md 全局规则）。
- 手工逻辑检查：逐文件确认 `DialogContent` 不再含 `overflow-y-auto`/`max-h-[8..dvh]`，`DialogBody` 数量为 16。
