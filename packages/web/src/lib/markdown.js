import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import plaintext from 'highlight.js/lib/languages/plaintext'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import scss from 'highlight.js/lib/languages/scss'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import MarkdownIt from 'markdown-it'

// 只注册任务文档里会出现的语言：highlight.js/lib/common 会把 190+ 语言包塞进首屏 chunk
const LANGUAGES = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  php,
  plaintext,
  powershell,
  python,
  ruby,
  rust,
  scss,
  shell,
  sql,
  typescript,
  xml,
  yaml,
}
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language)

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
  typographer: false,
  // 返回空串时由 markdown-it 自行转义，未注册的语言则退化为纯文本
  highlight: (code, lang) => {
    if (!lang || !hljs.getLanguage(lang)) return ''
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
  },
})

// highlight.js 主题依赖 .hljs 容器类，markdown-it 默认只输出 language-*。
const defaultFence = md.renderer.rules.fence
md.renderer.rules.fence = (tokens, index, options, env, self) => {
  const html = defaultFence(tokens, index, options, env, self)
  const language = String(tokens[index].info || '')
    .trim()
    .split(/\s+/)[0]
  if (!language || !hljs.getLanguage(language)) return html
  return html.replace('<pre><code class="language-', '<pre><code class="hljs language-')
}

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
