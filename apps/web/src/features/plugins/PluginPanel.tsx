import { useEffect, useRef } from 'react'
import type { PluginPanel as PluginPanelInfo } from '@/api/panels'
import { useAppearance } from '@/app/theme'

type BridgeMessage = {
  type?: string
  id?: string
  method?: string
  path?: string
  body?: unknown
}

type BridgeRequest = BridgeMessage & { type: 'trellis:request'; id: string; path: string }

function isBridgeRequest(message: BridgeMessage): message is BridgeRequest {
  return (
    message.type === 'trellis:request' &&
    typeof message.id === 'string' &&
    typeof message.path === 'string'
  )
}

export function PluginPanel({
  panel,
  projectId = '',
  projectName = '',
}: {
  panel: PluginPanelInfo
  projectId?: string
  projectName?: string
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const { resolvedTheme: theme } = useAppearance()

  useEffect(() => {
    const frame = frameRef.current
    const view = frame?.contentWindow
    if (!frame || !view) return undefined

    const base = `/api/plugins/${encodeURIComponent(panel.pluginId)}`
    const post = (message: unknown) => view.postMessage(message, '*')
    let events: EventSource | null = null

    const subscribe = () => {
      if (events) return
      events = new EventSource(`/api/events?topics=${encodeURIComponent(panel.pluginId)}`)
      events.onmessage = (event) => {
        try {
          post({ type: 'trellis:event', event: JSON.parse(event.data) })
        } catch {
          /* 忽略非 JSON 事件 */
        }
      }
    }

    const init = () => {
      post({
        type: 'trellis:init',
        theme,
        panel: { id: panel.id, pluginId: panel.pluginId, title: panel.title },
        context: { repositoryId: projectId, projectName },
      })
      subscribe()
    }

    async function handleRequest(message: BridgeRequest) {
      const id = message.id
      const path = message.path
      if (!path.startsWith('/')) {
        post({
          type: 'trellis:response',
          id,
          ok: false,
          status: 400,
          data: { error: 'path 必须以 / 开头' },
        })
        return
      }
      try {
        const hasBody = message.body !== undefined && message.body !== null
        const response = await fetch(base + path, {
          method: (message.method || 'GET').toUpperCase(),
          credentials: 'same-origin',
          headers: hasBody ? { 'content-type': 'application/json' } : undefined,
          body: hasBody ? JSON.stringify(message.body) : undefined,
        })
        const contentType = response.headers.get('content-type') || ''
        const data = contentType.includes('json')
          ? await response.json().catch(() => null)
          : await response.text()
        post({ type: 'trellis:response', id, ok: response.ok, status: response.status, data })
      } catch (error) {
        post({
          type: 'trellis:response',
          id,
          ok: false,
          status: 0,
          data: { error: error instanceof Error ? error.message : String(error) },
        })
      }
    }

    function onMessage(event: MessageEvent) {
      if (event.source !== view) return
      if (!event.data || typeof event.data !== 'object') return
      const message = event.data as BridgeMessage
      if (message.type === 'trellis:ready') init()
      else if (isBridgeRequest(message)) void handleRequest(message)
    }

    window.addEventListener('message', onMessage)
    frame.addEventListener('load', init)
    return () => {
      window.removeEventListener('message', onMessage)
      frame.removeEventListener('load', init)
      events?.close()
    }
  }, [panel, theme, projectId, projectName])

  return (
    <iframe
      ref={frameRef}
      title={panel.title}
      src={
        projectId
          ? `${panel.src}${panel.src.includes('?') ? '&' : '?'}repositoryId=${encodeURIComponent(projectId)}`
          : panel.src
      }
      sandbox="allow-scripts allow-forms"
      className="min-h-0 w-full flex-1 rounded-xl border border-border bg-card"
    />
  )
}
