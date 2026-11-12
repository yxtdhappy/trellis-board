export function canProbeBranch(branch, remoteUrl) {
  return Boolean(String(branch || '').trim() && String(remoteUrl || '').trim())
}

export function preflightBlockReason({
  hasTrellis = false,
  hasTasks = false,
  requiresPushCheck = false,
  pushState = '',
} = {}) {
  if (!hasTrellis || !hasTasks) return '请先初始化 Trellis 任务目录。'
  if (requiresPushCheck && pushState !== 'ready') {
    return '请先提交（commit）并推送（push）Trellis 初始化文件。'
  }
  return ''
}

export function onboardingErrorMessage(error, fallback) {
  let message = ''
  if (error instanceof Error) {
    message = error.message
  } else if (typeof error === 'string') {
    message = error
  } else if (error && typeof error === 'object' && typeof error.message === 'string') {
    message = error.message
  }
  return message.trim().slice(0, 1000) || fallback
}
