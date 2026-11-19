import { Worker } from 'node:worker_threads'
import { PATHS } from './state.js'

export function rejectPendingScans(state, error) {
  for (const pending of state.pendingScanRequests.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  state.pendingScanRequests.clear()
}

function ensureScanWorker(state) {
  if (state.scanWorkerRuntime) return state.scanWorkerRuntime
  const worker = new Worker(PATHS.workerFile)
  state.scanWorkerRuntime = worker
  worker.on('message', (message) => {
    const pending = state.pendingScanRequests.get(message?.id)
    if (!pending) return
    clearTimeout(pending.timer)
    state.pendingScanRequests.delete(message.id)
    if (message.type === 'scan-error') {
      pending.reject(new Error(message.error || '扫描失败'))
      return
    }
    if (message.type !== 'scan-result') return
    pending.resolve({ board: message.board, stats: message.stats })
  })
  worker.on('error', (error) => {
    if (state.scanWorkerRuntime === worker) state.scanWorkerRuntime = null
    rejectPendingScans(state, error)
  })
  worker.on('exit', (code) => {
    if (state.scanWorkerRuntime === worker) state.scanWorkerRuntime = null
    if (state.pendingScanRequests.size) {
      rejectPendingScans(state, new Error(`扫描 worker 已退出，退出码 ${code}`))
    }
  })
  return worker
}

export function runScanWorker(
  state,
  { refreshRepositoryMetadata = false, forceFull = false, events = [] } = {},
) {
  const worker = ensureScanWorker(state)
  const id = ++state.nextScanRequestId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingScanRequests.delete(id)
      reject(new Error('扫描超过 180 秒，已中止本次请求'))
    }, 180_000)
    state.pendingScanRequests.set(id, { resolve, reject, timer })
    worker.postMessage({
      type: 'scan',
      id,
      refreshRepositoryMetadata,
      forceFull,
      events,
    })
  })
}
