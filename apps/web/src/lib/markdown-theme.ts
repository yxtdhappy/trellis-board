import markdownDark from 'github-markdown-css/github-markdown-dark.css?inline'
import markdownLight from 'github-markdown-css/github-markdown-light.css?inline'
import hljsDark from 'highlight.js/styles/github-dark.css?inline'
import hljsLight from 'highlight.js/styles/github.css?inline'

type Theme = 'light' | 'dark'

const STYLE_ID = 'markdown-theme'

// 两份 CSS 都是字面颜色、选择器相同，只能按当前主题二选一注入
export function applyMarkdownTheme(theme: Theme) {
  if (typeof document === 'undefined') return
  let style = document.getElementById(STYLE_ID)
  if (!style) {
    style = document.createElement('style')
    style.id = STYLE_ID
    document.head.append(style)
  }
  style.textContent = theme === 'dark' ? markdownDark + hljsDark : markdownLight + hljsLight
}
