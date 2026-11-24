import { useEffect, useRef } from 'react'
import type { PluginPanel as PluginPanelInfo } from '@/api/panels'
import { requestDesktopPlugin } from '@/api/desktop-plugins'
import { useAppearance } from '@/app/theme'
import { withBasePath } from '@/lib/base-path.js'

type BridgeMessage = {
  type?: string
  id?: string
  method?: string
  path?: string
  body?: unknown
}

type BridgeRequest = BridgeMessage & { type: 'trellis:request'; id: string; path: string }

// 下发给面板的设计令牌（/plugin-ui/v1/tokens.css 的 --tb-* 来源）。
// 只发白名单里的值，避免把宿主所有 CSS 变量都泄漏给插件面板。
const PANEL_TOKEN_NAMES = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'border',
  'primary',
  'primary-foreground',
  'muted',
  'muted-foreground',
  'destructive',
  'destructive-foreground',
  'success',
  'warning',
  'radius',
] as const

function readPanelTokens(): Record<string, string> {
  const style = getComputedStyle(document.documentElement)
  const tokens: Record<string, string> = {}
  for (const name of PANEL_TOKEN_NAMES) {
    const value = style.getPropertyValue(`--${name}`).trim()
    if (value) tokens[name] = value
  }
  return tokens
}

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
  const readyRef = useRef(false)
  const { resolvedTheme: theme } = useAppearance()
  const themeRef = useRef(theme)
  const projectNameRef = useRef(projectName)
  const desktop = panel.host === 'desktop'

  useEffect(() => {
    themeRef.current = theme
    projectNameRef.current = projectName
    if (!readyRef.current) return
    const view = frameRef.current?.contentWindow
    if (!view) return
    view.postMessage(
      {
        type: 'trellis:init',
        theme,
        tokens: readPanelTokens(),
        panel: { id: panel.id, pluginId: panel.pluginId, title: panel.title },
        context: { repositoryId: projectId, projectName },
      },
      '*',
    )
  }, [theme, projectName, panel.id, panel.pluginId, panel.title, projectId])

  useEffect(() => {
    const frame = frameRef.current
    const view = frame?.contentWindow
    if (!frame || !view) return undefined

    readyRef.current = false
    const base = withBasePath(`/api/plugins/${encodeURIComponent(panel.pluginId)}`)
    const post = (message: unknown) => view.postMessage(message, '*')
    let events: EventSource | null = null

    const subscribe = () => {
      if (events) return
      const source = desktop
        ? panel.eventsSrc
        : withBasePath(`/api/events?topics=${encodeURIComponent(panel.pluginId)}`)
      if (!source) return
      events = new EventSource(source)
      events.onmessage = (event) => {
        try {
          post({ type: 'trellis:event', event: JSON.parse(event.data) })
        } catch {
          /* 忽略非 JSON 事件 */
        }
      }
    }

    const init = () => {
      readyRef.current = true
      post({
        type: 'trellis:init',
        theme: themeRef.current,
        tokens: readPanelTokens(),
        panel: { id: panel.id, pluginId: panel.pluginId, title: panel.title },
        context: { repositoryId: projectId, projectName: projectNameRef.current },
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
        if (desktop) {
          const response = await requestDesktopPlugin(
            panel.pluginId,
            (message.method || 'GET').toUpperCase(),
            path,
            message.body,
          )
          post({
            type: 'trellis:response',
            id,
            ok: response.ok,
            status: response.status,
            data: response.data,
          })
          return
        }
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
      readyRef.current = false
      window.removeEventListener('message', onMessage)
      frame.removeEventListener('load', init)
      events?.close()
    }
  }, [desktop, panel, projectId])

  const panelSrc = desktop ? panel.src : withBasePath(panel.src)

  return (
    <iframe
      ref={frameRef}
      title={panel.title}
      src={
        projectId
          ? `${panelSrc}${panelSrc.includes('?') ? '&' : '?'}repositoryId=${encodeURIComponent(projectId)}`
          : panelSrc
      }
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
      className="min-h-0 w-full flex-1 rounded-xl border border-border bg-card"
    />
  )
}
