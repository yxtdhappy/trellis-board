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

export const invoke: Invoke | undefined =
  typeof window === 'undefined' ? undefined : window.__TAURI__?.core?.invoke

export const listen: Listen | undefined =
  typeof window === 'undefined' ? undefined : window.__TAURI__?.event?.listen

export function errorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || fallback)
  return message.replace(/^Error:\s*/i, '')
}
