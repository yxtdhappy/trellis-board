import { Info, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { invoke, listen } from '@/desktop/tauri'

type HandoffNotice = {
  executionTaskKey: string
  taskId: string
  relativeDir: string
  handoffState: string
  ackState: string
  outcome: string
  reason?: string | null
  backupId?: string | null
}

const NOTICE_STORAGE_KEY = 'trellis.handoff-notice-notified.v1'
let notificationPermissionRequest: Promise<NotificationPermission> | null = null

function normalizeNotices(value: unknown): HandoffNotice[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    if (
      typeof record.executionTaskKey !== 'string' ||
      typeof record.taskId !== 'string' ||
      typeof record.relativeDir !== 'string' ||
      typeof record.handoffState !== 'string' ||
      typeof record.ackState !== 'string' ||
      typeof record.outcome !== 'string'
    ) {
      return []
    }
    return [
      {
        executionTaskKey: record.executionTaskKey,
        taskId: record.taskId,
        relativeDir: record.relativeDir,
        handoffState: record.handoffState,
        ackState: record.ackState,
        outcome: record.outcome,
        reason: typeof record.reason === 'string' ? record.reason : null,
        backupId: typeof record.backupId === 'string' ? record.backupId : null,
      },
    ]
  })
}

function noticeKey(notice: HandoffNotice): string {
  return `${notice.executionTaskKey}:${notice.handoffState}:${notice.outcome || 'checking'}`
}

function readNotified(): Set<string> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(NOTICE_STORAGE_KEY) || '[]')
    return new Set(Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [])
  } catch {
    return new Set()
  }
}

function saveNotified(values: Set<string>) {
  try {
    window.localStorage.setItem(NOTICE_STORAGE_KEY, JSON.stringify([...values].slice(-200)))
  } catch {
    /* 本地存储不可用时，Sonner 的固定 id 仍阻止同一页面内重复提示 */
  }
}

function notificationApi(): typeof Notification | null {
  if (typeof window === 'undefined' || !('Notification' in window)) return null
  return window.Notification
}

async function ensureNotificationPermission(): Promise<NotificationPermission> {
  const api = notificationApi()
  if (!api) return 'denied'
  if (api.permission === 'granted' || api.permission === 'denied') return api.permission
  if (!notificationPermissionRequest) {
    try {
      notificationPermissionRequest = api.requestPermission()
    } catch {
      notificationPermissionRequest = Promise.resolve('denied')
    }
  }
  try {
    return await notificationPermissionRequest
  } catch {
    return 'denied'
  }
}

function forgetNotified(key: string) {
  const notified = readNotified()
  if (!notified.delete(key)) return
  saveNotified(notified)
}

async function showSystemNotification(notice: HandoffNotice): Promise<boolean> {
  const api = notificationApi()
  if (!api || (await ensureNotificationPermission()) !== 'granted') return false
  const key = noticeKey(notice)
  try {
    const notification = new api(noticeTitle(notice), {
      body: `${notice.taskId} · ${reasonLabel(notice)}`,
      tag: `trellis-board-handoff:${key}`,
    })
    notification.onerror = () => {
      forgetNotified(key)
      notification.close()
    }
    return true
  } catch {
    return false
  }
}

function reasonLabel(notice: HandoffNotice): string {
  switch (notice.reason) {
    case 'missing':
      return '本地活动副本已不存在'
    case 'git_tracked':
      return '任务目录已进入 Git 跟踪，保留本地副本'
    case 'git_modified':
      return '任务目录包含修改，保留本地副本'
    case 'not_untracked':
      return '任务目录不是纯未跟踪副本，保留本地文件'
    case 'no_files':
      return '任务目录没有可清理文件'
    case 'baseline_mismatch':
      return '本地内容与已同步基线不一致，保留本地副本'
    case 'branch_mismatch':
      return '当前 Git 分支与任务空间不一致'
    case 'backup_failed':
      return '本地备份失败，未删除任何任务文件'
    case 'backup_too_large':
      return '本地任务副本超过安全备份上限，已保留'
    case 'cleanup_failed':
      return '本地备份已完成，但目录清理失败'
    case 'lease_active':
      return '任务仍有其他客户端持有写租约，暂未清理'
    case 'unknown':
      return '本地副本状态需要人工确认'
    default:
      return notice.outcome === 'cleaned' ? '本地未跟踪副本已备份并清理' : '正在检查本地未跟踪副本'
  }
}

function noticeTitle(notice: HandoffNotice): string {
  if (notice.outcome === 'conflict' || notice.handoffState === 'source_cleanup_conflict') {
    return '任务已被认领，本地副本需保留'
  }
  if (notice.outcome === 'cleaned') {
    return '任务已被认领，本地副本已清理'
  }
  return '任务已被认领，正在处理本地副本'
}

export function HandoffNotice() {
  const [notices, setNotices] = useState<HandoffNotice[]>([])
  const inFlight = useRef(new Set<string>())
  const persistentNotices = notices.filter((notice) => notice.outcome !== 'cleaned')

  const load = useCallback(async (): Promise<HandoffNotice[]> => {
    if (!invoke) return []
    try {
      const value = await invoke<unknown>('handoff_notice_pending')
      const next = normalizeNotices(value)
      setNotices(next)
      return next
    } catch {
      /* 旧客户端没有 handoff 命令时静默降级 */
      return []
    }
  }, [])

  const notifyVisible = useCallback(async () => {
    const next = await load()
    const notified = readNotified()
    if (document.visibilityState !== 'visible') {
      for (const notice of next) {
        const key = noticeKey(notice)
        if (notified.has(key) || inFlight.current.has(key)) continue
        inFlight.current.add(key)
        try {
          if (await showSystemNotification(notice)) {
            notified.add(key)
            saveNotified(notified)
          }
        } finally {
          inFlight.current.delete(key)
        }
      }
      return
    }
    for (const notice of next) {
      const key = noticeKey(notice)
      if (notified.has(key)) continue
      const options = {
        id: key,
        description: `${notice.taskId} · ${reasonLabel(notice)}`,
        duration: notice.outcome === 'conflict' ? 12_000 : 8_000,
      }
      if (notice.outcome === 'conflict') toast.warning(noticeTitle(notice), options)
      else toast.info(noticeTitle(notice), options)
      notified.add(key)
    }
    saveNotified(notified)
  }, [load])

  useEffect(() => {
    if (!invoke) return
    let cancelled = false
    let unlisten: (() => void) | undefined

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void notifyVisible()
      else void notifyVisible()
    }

    async function setup() {
      if (listen) {
        try {
          unlisten = await listen('handoff-control-changed', () => {
            void notifyVisible()
          })
        } catch {
          unlisten = undefined
        }
      }
      if (cancelled) {
        unlisten?.()
        return
      }
      document.addEventListener('visibilitychange', onVisibilityChange)
      await notifyVisible()
    }
    void setup()

    return () => {
      cancelled = true
      unlisten?.()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [load, notifyVisible])

  if (!invoke || persistentNotices.length === 0) return null

  return (
    <aside
      aria-live="polite"
      aria-label="任务认领与本地清理状态"
      className="pointer-events-none fixed right-4 top-20 z-40 w-[22rem] max-w-[calc(100vw-2rem)]"
    >
      <div className="pointer-events-auto rounded-lg border bg-popover/95 p-3 text-popover-foreground shadow-lg backdrop-blur">
        <p className="text-2xs font-semibold tracking-[0.18em] text-muted-foreground">
          任务认领状态
        </p>
        <div className="mt-2 flex flex-col gap-2">
          {persistentNotices.slice(0, 3).map((notice) => {
            const conflict =
              notice.outcome === 'conflict' || notice.handoffState === 'source_cleanup_conflict'
            const Icon = conflict ? TriangleAlert : Info
            return (
              <div key={noticeKey(notice)} className="flex items-start gap-2">
                <Icon
                  className={
                    conflict
                      ? 'mt-0.5 size-4 shrink-0 text-amber-500'
                      : 'mt-0.5 size-4 shrink-0 text-sky-500'
                  }
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium">{noticeTitle(notice)}</p>
                  <p className="mt-0.5 break-words text-xs text-muted-foreground">
                    {notice.taskId} · {reasonLabel(notice)}
                  </p>
                </div>
              </div>
            )
          })}
        </div>
        {persistentNotices.length > 3 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            另有 {persistentNotices.length - 3} 个任务
          </p>
        ) : null}
      </div>
    </aside>
  )
}
