type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>
type Listen = (name: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>

declare global {
  interface Window {
    __TAURI__?: {
      core?: { invoke?: Invoke }
      event?: { listen?: Listen }
    }
  }
}

/**
 * headless 本地桥（`trellis-agent serve`）的 HTTP 传输。
 *
 * 桌面 EXE 走 Tauri IPC；浏览器里的客户端页面没有 `__TAURI__`，改走 Vite 代理
 * `/local-agent` 打到本机 headless agent。只有 dev 脚本注入了
 * `VITE_LOCAL_AGENT_BASE` 时才启用，其它部署形态行为不变。
 */
const LOCAL_BASE = (import.meta.env.VITE_LOCAL_AGENT_BASE as string | undefined) || ''
const LOCAL_TOKEN = (import.meta.env.VITE_LOCAL_AGENT_TOKEN as string | undefined) || ''

const hasTauri = typeof window !== 'undefined' && Boolean(window.__TAURI__?.core?.invoke)
const bridgeEnabled = !hasTauri && LOCAL_BASE !== ''
export const localBridgeEnabled = bridgeEnabled
/** 是否运行在桌面 EXE 的 WebView 里（原生 Tauri IPC 可用）。 */
export const isNativeTauri = hasTauri

async function bridgeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${LOCAL_BASE}/invoke`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(LOCAL_TOKEN ? { authorization: `Bearer ${LOCAL_TOKEN}` } : {}),
    },
    body: JSON.stringify({ command, args: args ?? null }),
  })
  const text = await response.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { error: text }
  }
  if (!response.ok) {
    const message = (data as { error?: string } | null)?.error
    throw new Error(message || `本地 Agent 桥请求失败（${response.status}）`)
  }
  return data as T
}

/**
 * 浏览器没有原生目录选择框：桥模式下改为手工输入本机仓库路径。
 * 返回 `null` 表示用户取消，与桌面端 `pick_local_project_folder` 语义一致。
 */
async function promptLocalPath(): Promise<string | null> {
  const hint = '浏览器模式无法弹出系统目录选择框。\n请输入本机仓库根目录的绝对路径，例如 /opt/app/work/github/trellis-board：'
  const value = window.prompt(hint, '')
  if (!value) return null
  return bridgeInvoke<string | null>('pick_local_project_folder', { path: value.trim() })
}

const httpInvoke: Invoke = async <T,>(command: string, args?: Record<string, unknown>) => {
  if (command === 'pick_local_project_folder' && !args?.path) {
    return (await promptLocalPath()) as T
  }
  return bridgeInvoke<T>(command, args)
}

export const invoke: Invoke | undefined = hasTauri
  ? window.__TAURI__?.core?.invoke
  : bridgeEnabled
    ? httpInvoke
    : undefined

type BridgeHandler = (event: { payload: unknown }) => void
const bridgeHandlers = new Map<string, Set<BridgeHandler>>()
let bridgeStream: EventSource | undefined

function ensureBridgeStream(): EventSource {
  if (bridgeStream) return bridgeStream
  const query = LOCAL_TOKEN ? `?token=${encodeURIComponent(LOCAL_TOKEN)}` : ''
  const stream = new EventSource(`${LOCAL_BASE}/invoke/events${query}`)
  const names = [
    'desktop-state-changed',
    'live-control-changed',
    'handoff-control-changed',
    'task-sync-notice',
    'runtime-progress',
    'update-open-dialog',
    'update-status-changed',
    'share-link-open',
  ]
  for (const name of names) {
    stream.addEventListener(name, (event) => {
      const handlers = bridgeHandlers.get(name)
      if (!handlers) return
      let payload: unknown = null
      try {
        payload = JSON.parse((event as MessageEvent).data)
      } catch {
        payload = null
      }
      for (const handler of handlers) handler({ payload })
    })
  }
  bridgeStream = stream
  return stream
}

const httpListen: Listen = async (name, handler) => {
  const stream = ensureBridgeStream()
  const handlers = bridgeHandlers.get(name) ?? new Set<BridgeHandler>()
  handlers.add(handler)
  bridgeHandlers.set(name, handlers)
  void stream
  return () => {
    const current = bridgeHandlers.get(name)
    if (!current) return
    current.delete(handler)
  }
}

export const listen: Listen | undefined = hasTauri
  ? window.__TAURI__?.event?.listen
  : bridgeEnabled
    ? httpListen
    : undefined

export function errorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || fallback)
  return message.replace(/^Error:\s*/i, '')
}
