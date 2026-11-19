import { useEffect } from 'react'
import { toast } from 'sonner'
import { listen } from '@/desktop/tauri'
import { syncNoticeView } from '@/lib/sync-notice.js'

/** 桌面端非模态同步消息：只提示，不弹模态框、不抢焦点。 */
export function SyncNotice() {
  useEffect(() => {
    if (!listen) return
    let disposed = false
    let unlisten: (() => void) | undefined
    const onNotice = (event: { payload: unknown }) => {
      const view = syncNoticeView(event?.payload)
      if (!view) return
      toast.warning(view.title, {
        id: view.id,
        description: view.description,
        duration: 10_000,
      })
    }
    void listen('task-sync-notice', onNotice)
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch(() => {})
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])
  return null
}
