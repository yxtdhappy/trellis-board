import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke, listen } from '@/desktop/tauri'

export type LocalTaskState = {
  localDirs: Set<string>
  readonlyDirs: Set<string>
  archivedResidue: Set<string>
}

type LocalTaskStateResult = LocalTaskState & { refresh: () => Promise<void> }

const EMPTY: LocalTaskState = {
  localDirs: new Set(),
  readonlyDirs: new Set(),
  archivedResidue: new Set(),
}

function dirKeys(taskSpaceId: string, value: unknown): Set<string> {
  const keys = new Set<string>()
  if (!Array.isArray(value)) return keys
  for (const dir of value) {
    if (typeof dir === 'string' && dir) keys.add(`${taskSpaceId}\u0000${dir}`)
  }
  return keys
}

function sameKeys(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false
  for (const key of left) {
    if (!right.has(key)) return false
  }
  return true
}

function sameState(left: LocalTaskState, right: LocalTaskState): boolean {
  return (
    sameKeys(left.localDirs, right.localDirs) &&
    sameKeys(left.readonlyDirs, right.readonlyDirs) &&
    sameKeys(left.archivedResidue, right.archivedResidue)
  )
}

export function useLocalTaskState(taskSpaceIds: string[]): LocalTaskStateResult {
  const idsKey = [...new Set(taskSpaceIds.filter(Boolean))].sort().join('\u0000')
  const [state, setState] = useState<LocalTaskState>(EMPTY)
  const inFlight = useRef(false)
  const pending = useRef(false)
  const generation = useRef(0)

  const refresh = useCallback(
    async function refreshLocalTaskState(): Promise<void> {
      const ids = idsKey ? idsKey.split('\u0000') : []
      if (!invoke || ids.length === 0) {
        generation.current += 1
        setState(EMPTY)
        return
      }
      if (inFlight.current) {
        pending.current = true
        return
      }
      inFlight.current = true
      const ticket = ++generation.current
      const call = invoke
      try {
        const results = await Promise.all(
          ids.map((taskSpaceId) => call<unknown>('live_local_task_state', { taskSpaceId })),
        )
        if (ticket !== generation.current) return
        const next: LocalTaskState = {
          localDirs: new Set(),
          readonlyDirs: new Set(),
          archivedResidue: new Set(),
        }
        results.forEach((raw, index) => {
          const record: Record<string, unknown> =
            raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
          const taskSpaceId = ids[index]
          for (const key of dirKeys(taskSpaceId, record.localDirs)) next.localDirs.add(key)
          for (const key of dirKeys(taskSpaceId, record.readonlyDirs)) next.readonlyDirs.add(key)
          for (const key of dirKeys(taskSpaceId, record.archivedResidue)) {
            next.archivedResidue.add(key)
          }
        })
        setState((current) => (sameState(current, next) ? current : next))
      } catch {
        // 旧客户端没有该命令时保持上次状态，避免徽标闪回“未下载”。
      } finally {
        inFlight.current = false
        if (pending.current) {
          pending.current = false
          void refreshLocalTaskState()
        }
      }
    },
    [idsKey],
  )

  useEffect(() => {
    if (!invoke) return
    void refresh()
    let disposed = false
    let unlisten: (() => void) | undefined
    if (listen) {
      void listen('live-control-changed', () => void refresh())
        .then((stop) => {
          if (disposed) stop()
          else unlisten = stop
        })
        .catch(() => {})
    }
    const onFocus = () => {
      if (document.visibilityState !== 'hidden') void refresh()
    }
    window.addEventListener('focus', onFocus)
    // 后台同步会在无控制事件的情况下落地新任务，靠定时刷新让徽标跟上。
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void refresh()
    }, 15000)
    return () => {
      disposed = true
      window.clearInterval(timer)
      unlisten?.()
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  return { ...state, refresh }
}
