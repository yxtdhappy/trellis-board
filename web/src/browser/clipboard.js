function fallbackCopyText(value) {
  const documentRef = globalThis.document
  if (!documentRef?.body) return false

  const previousFocus = documentRef.activeElement
  const textarea = documentRef.createElement('textarea')

  try {
    textarea.value = value
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.top = '0'
    textarea.style.left = '-9999px'
    textarea.style.opacity = '0'
    documentRef.body.appendChild(textarea)
    textarea.focus()
    textarea.select()
    return documentRef.execCommand('copy')
  } catch {
    return false
  } finally {
    try {
      textarea.remove()
    } catch {
      // 清理异常不能掩盖复制结果
    }
    try {
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus()
    } catch {
      // 焦点目标已失效时保持复制结果
    }
  }
}

export async function copyText(value) {
  try {
    const clipboard = globalThis.navigator?.clipboard
    if (clipboard && typeof clipboard.writeText === 'function') {
      await clipboard.writeText(value)
      return true
    }
  } catch {
    // 非安全上下文、权限或焦点限制下继续尝试兼容回退
  }

  return fallbackCopyText(value)
}
