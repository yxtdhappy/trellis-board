import test from 'node:test'
import assert from 'node:assert/strict'
import { escapeHtml, renderMarkdown } from '../web/src/lib/markdown.js'

test('Markdown 标题、段落和行内格式会被渲染', () => {
  const html = renderMarkdown(
    [
      '# 发布说明',
      '',
      '支持 **粗体**、*斜体*、~~删除线~~ 和 `inline code`。',
      '',
      '1. 第一步',
      '2. 第二步',
    ].join('\n'),
  )

  assert.match(html, /<h1>发布说明<\/h1>/)
  assert.match(html, /<strong>粗体<\/strong>/)
  assert.match(html, /<em>斜体<\/em>/)
  assert.match(html, /<s>删除线<\/s>/)
  assert.match(html, /<code>inline code<\/code>/)
  assert.match(html, /<ol>\s*<li>第一步<\/li>\s*<li>第二步<\/li>\s*<\/ol>/)
})

test('Markdown 表格、代码块、引用和任务项会被渲染', () => {
  const html = renderMarkdown(
    [
      '| 项目 | 状态 |',
      '| --- | ---: |',
      '| 渲染 | 完成 |',
      '',
      '> 一段引用',
      '',
      '```js',
      'const status = "ok";',
      '```',
      '',
      '- [x] 已完成',
      '- [ ] 待处理',
    ].join('\n'),
  )

  assert.match(html, /<th>项目<\/th>/)
  assert.match(html, /<th style="text-align:right">状态<\/th>/)
  assert.match(html, /<blockquote>\s*<p>一段引用<\/p>\s*<\/blockquote>/)
  assert.match(
    html,
    /<pre><code class="hljs language-js"><span class="hljs-keyword">const<\/span> status = <span class="hljs-string">&quot;ok&quot;<\/span>;/,
  )
  assert.match(html, /md-checkbox is-checked/)
  assert.match(html, /aria-label="未完成"/)
})

test('Markdown 会转义原始 HTML 并阻止危险链接', () => {
  const html = renderMarkdown(
    [
      "<script>alert('xss')</script>",
      '',
      '[危险](javascript:alert(1))',
      '',
      '[安全](https://example.com/docs?q=1)',
    ].join('\n'),
  )

  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;alert\('xss'\)&lt;\/script&gt;/)
  assert.match(html, /\[危险\]\(javascript:alert\(1\)\)/)
  assert.doesNotMatch(html, /href="javascript:/)
  assert.match(html, /href="https:\/\/example.com\/docs\?q=1"/)
  assert.match(html, /rel="noopener noreferrer"/)
})

test('Markdown 支持嵌套列表', () => {
  const html = renderMarkdown(['- 父级', '  - 子级', '  - 另一个子级', '- 同级'].join('\n'))

  assert.match(html, /<li>父级\s*<ul>\s*<li>子级<\/li>\s*<li>另一个子级<\/li>\s*<\/ul>/)
  assert.match(html, /<li>同级<\/li>/)
})

test('escapeHtml 覆盖全部 HTML 特殊字符', () => {
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;')
})
