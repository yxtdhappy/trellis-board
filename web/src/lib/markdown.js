import hljs from 'highlight.js/lib/common'
import MarkdownIt from 'markdown-it'
import highlightjs from 'markdown-it-highlightjs'

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
})

// 代码块语法高亮；lib/common 只带 37 种常用语言，避免全量语言包进 bundle
md.use(highlightjs, { hljs })

// 外链统一新窗口打开，并切断 opener
md.renderer.rules.link_open = (tokens, index, options, _env, self) => {
  tokens[index].attrSet('target', '_blank')
  tokens[index].attrSet('rel', 'noopener noreferrer')
  return self.renderToken(tokens, index, options)
}

// 任务清单：markdown-it 核心不含该扩展，这里把 "[x] " 前缀换成既有 .md-checkbox 标记
md.core.ruler.after('inline', 'task-lists', (state) => {
  const tokens = state.tokens
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.type !== 'inline') continue
    if (tokens[index - 1]?.type !== 'paragraph_open') continue
    if (tokens[index - 2]?.type !== 'list_item_open') continue
    const match = /^\[([ xX])\]\s+/.exec(token.content)
    const first = token.children?.[0]
    if (!match || first?.type !== 'text') continue
    const checked = match[1].toLowerCase() === 'x'
    first.content = first.content.slice(match[0].length)
    const box = new state.Token('html_inline', '', 0)
    box.content = `<span class="md-checkbox ${checked ? 'is-checked' : ''}" aria-label="${checked ? '已完成' : '未完成'}">${checked ? '✓' : ''}</span>`
    token.children.unshift(box)
  }
})

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char])
}

export function renderMarkdown(markdown) {
  return md.render(String(markdown ?? ''))
}
