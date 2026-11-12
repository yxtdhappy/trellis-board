export function adminPasswordError(password: string): string {
  if (Array.from(password).length < 6) {
    return '密码至少需要 6 个字符。'
  }
  if (new TextEncoder().encode(password).length > 1024) {
    return '密码不能超过 1024 字节。'
  }
  return ''
}
