/** 宿主 Python 不可用时的错误码（与 `packages/server/python.js` 的 `PYTHON_UNAVAILABLE` 一致）。 */
export const PYTHON_UNAVAILABLE = 1011

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasUnavailableCode(value: unknown): boolean {
  return isRecord(value) && value.code === PYTHON_UNAVAILABLE
}

/**
 * 插件响应里是否带「本地 Python 不可用」错误码。
 *
 * 批量下发时错误码在 `results[]` 的逐项结果上，单条下发时在顶层 `data.code` 上；
 * 只比较数字，避免把文案里的 `1011` 误判成错误码。
 */
export function hasPythonUnavailable(payload: unknown): boolean {
  if (hasUnavailableCode(payload)) return true
  if (!isRecord(payload)) return false
  const results = payload.results
  return Array.isArray(results) && results.some(hasUnavailableCode)
}

/** 环境门提示文案；Web 分支与桌面分支共用同一份文本。 */
export function pythonUnavailableToast(): {
  id: string
  title: string
  description: string
  actionLabel: string
} {
  return {
    id: 'python-unavailable',
    title: '本地 Python 运行环境不可用',
    description: '任务未下发。请先检查运行环境，完成后重新下发。',
    actionLabel: '检查运行环境',
  }
}
