import { copyText } from '@/browser/clipboard.js'
import { buildProtocolUrl, parseSharePageParams } from '@/lib/share-link.ts'

const parsed = parseSharePageParams(location.search, location.origin)
const target = parsed ? buildProtocolUrl(parsed) : ''

const actions = document.getElementById('actions')
const errorNote = document.getElementById('error')
const copyError = document.getElementById('copy-error')
const copyButton = document.getElementById('copy') as HTMLButtonElement | null

if (!target) {
  for (const id of ['opening', 'status', 'hint', 'copy-error']) {
    document.getElementById(id)?.setAttribute('hidden', '')
  }
  errorNote?.removeAttribute('hidden')
} else {
  actions?.removeAttribute('hidden')
  // 自动尝试一次；浏览器拦截或被 IM 内置浏览器屏蔽时，用户可点按钮重试。
  location.href = target
  document.getElementById('open')?.addEventListener('click', () => {
    location.href = target
  })
  copyButton?.addEventListener('click', async () => {
    if (await copyText(target)) {
      copyButton.textContent = '已复制客户端链接'
      copyError?.setAttribute('hidden', '')
      return
    }
    copyButton.textContent = '复制失败，请重试'
    if (copyError) {
      copyError.textContent = '无法自动写入剪贴板，请在系统浏览器中打开本页后重试。'
      copyError.removeAttribute('hidden')
    }
  })
}
