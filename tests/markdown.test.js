import test from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, renderMarkdown } from "../public/markdown.js";

test("Markdown 标题、段落和行内格式会被渲染", () => {
  const html = renderMarkdown([
    "# 发布说明",
    "",
    "支持 **粗体**、*斜体*、~~删除线~~ 和 `inline code`。",
    "",
    "1. 第一步",
    "2. 第二步"
  ].join("\n"));

  assert.match(html, /<h1>发布说明<\/h1>/);
  assert.match(html, /<strong>粗体<\/strong>/);
  assert.match(html, /<em>斜体<\/em>/);
  assert.match(html, /<del>删除线<\/del>/);
  assert.match(html, /<code>inline code<\/code>/);
  assert.match(html, /<ol><li>第一步<\/li><li>第二步<\/li><\/ol>/);
});

test("Markdown 表格、代码块、引用和任务项会被渲染", () => {
  const html = renderMarkdown([
    "| 项目 | 状态 |",
    "| --- | ---: |",
    "| 渲染 | 完成 |",
    "",
    "> 一段引用",
    "",
    "```js",
    "const status = \"ok\";",
    "```",
    "",
    "- [x] 已完成",
    "- [ ] 待处理"
  ].join("\n"));

  assert.match(html, /<div class="md-table-wrap"><table>/);
  assert.match(html, /<th style="text-align:right">状态<\/th>/);
  assert.match(html, /<blockquote><p>一段引用<\/p><\/blockquote>/);
  assert.match(html, /<pre class="md-code" data-language="js"><code>const status = &quot;ok&quot;;<\/code><\/pre>/);
  assert.match(html, /md-checkbox is-checked/);
  assert.match(html, /aria-label="未完成"/);
});

test("Markdown 会转义原始 HTML 并阻止危险链接", () => {
  const html = renderMarkdown([
    "<script>alert('xss')</script>",
    "",
    "[危险](javascript:alert(1))",
    "",
    "[安全](https://example.com/docs?q=1)"
  ].join("\n"));

  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;alert\(&#39;xss&#39;\)&lt;\/script&gt;/);
  assert.match(html, /\[危险\]\(javascript:alert\(1\)\)/);
  assert.match(html, /href="https:\/\/example.com\/docs\?q=1"/);
  assert.match(html, /rel="noopener noreferrer"/);
});

test("Markdown 支持嵌套列表", () => {
  const html = renderMarkdown([
    "- 父级",
    "  - 子级",
    "  - 另一个子级",
    "- 同级"
  ].join("\n"));

  assert.match(html, /<li>父级<ul><li>子级<\/li><li>另一个子级<\/li><\/ul><\/li>/);
  assert.match(html, /<li>同级<\/li>/);
});

test("escapeHtml 覆盖全部 HTML 特殊字符", () => {
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});
