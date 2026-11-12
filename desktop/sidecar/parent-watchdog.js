const PARENT_CHECK_INTERVAL_MS = 1000

export function isParentAlive(parentPid, kill = process.kill) {
  try {
    kill(parentPid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

export function startParentWatchdog({
  parentPid = process.ppid,
  intervalMs = PARENT_CHECK_INTERVAL_MS,
  isAlive = isParentAlive,
  onParentExit,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (typeof onParentExit !== 'function') {
    throw new TypeError('缺少父进程退出处理函数')
  }

  let active = true
  let timer
  const stop = () => {
    if (!active) return
    active = false
    clearIntervalFn(timer)
  }
  timer = setIntervalFn(() => {
    if (!active) return
    let alive = true
    try {
      alive = isAlive(parentPid)
    } catch {
      // 无法确认父进程不存在时保持运行，避免误杀 sidecar。
    }
    if (alive) return
    stop()
    onParentExit()
  }, intervalMs)
  return stop
}
