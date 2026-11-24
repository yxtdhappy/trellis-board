import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  fetchDesktopPluginLogs,
  fetchDesktopPlugins,
  reorderDesktopPlugins,
  setDesktopPluginEnabled,
  type DesktopPlugin,
  type DesktopPluginLogEntry,
  type DesktopPluginsState,
} from '@/api/desktop-plugins'
import { Button } from '@/components/ui/button'
import { StatusPill, type Tone } from '@/components/ui/status-pill'
import { Switch } from '@/components/ui/switch'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Panel } from '@/components/ui/panel'
import { cn } from '@/lib/utils'
import { PluginLogsDialog } from './PluginLogsDialog'

const POLL_INTERVAL_MS = 5000

const STATUS_LABELS: Record<string, string> = {
  running: '运行中',
  starting: '启动中',
  stopped: '已停止',
  error: '错误',
  disabled: '已禁用',
  crashing: '反复崩溃',
  incompatible: '不兼容',
  'missing-secret': '缺少配置',
}

const STATUS_TONES: Record<string, Tone> = {
  running: 'success',
  starting: 'warning',
  error: 'destructive',
  crashing: 'destructive',
  incompatible: 'destructive',
  'missing-secret': 'warning',
  stopped: 'neutral',
  disabled: 'neutral',
}

function statusTone(plugin: DesktopPlugin): Tone {
  return STATUS_TONES[plugin.status] || 'neutral'
}

function isActive(plugin: DesktopPlugin) {
  return plugin.status === 'running' || plugin.status === 'starting'
}

export function DesktopPluginsView() {
  const [state, setState] = useState<DesktopPluginsState>({
    disabled: false,
    running: false,
    hostVersion: '',
    plugins: [],
  })
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')
  const [savingOrder, setSavingOrder] = useState(false)
  const [draggingId, setDraggingId] = useState('')
  const [dragOverId, setDragOverId] = useState('')
  const [logs, setLogs] = useState<{ id: string; title: string } | null>(null)
  const [logEntries, setLogEntries] = useState<DesktopPluginLogEntry[]>([])
  const [logError, setLogError] = useState('')
  const [logLoading, setLogLoading] = useState(false)
  const mounted = useRef(true)

  const load = useCallback(async (quiet = false) => {
    try {
      if (!quiet) setError('')
      const next = await fetchDesktopPlugins()
      if (!mounted.current) return
      setState(next)
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : '读取插件失败')
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void load()
    const timer = window.setInterval(() => void load(true), POLL_INTERVAL_MS)
    return () => {
      mounted.current = false
      window.clearInterval(timer)
    }
  }, [load])

  async function toggle(plugin: DesktopPlugin) {
    setBusyId(plugin.id)
    try {
      await setDesktopPluginEnabled(plugin.id, !plugin.enabled)
      toast.success(
        plugin.enabled
          ? `已停用 ${plugin.name || plugin.id}`
          : `已启用 ${plugin.name || plugin.id}`,
      )
      await load(true)
      window.dispatchEvent(new CustomEvent('trellis:panels-changed'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusyId('')
    }
  }

  async function move(plugin: DesktopPlugin, targetIndex: number) {
    const index = state.plugins.findIndex((entry) => entry.id === plugin.id)
    if (index < 0 || targetIndex < 0 || targetIndex >= state.plugins.length) return
    const next = [...state.plugins]
    const [item] = next.splice(index, 1)
    next.splice(targetIndex, 0, item)
    setState((current) => ({ ...current, plugins: next }))
    setSavingOrder(true)
    try {
      await reorderDesktopPlugins(next.map((entry) => entry.id))
      await load(true)
      window.dispatchEvent(new CustomEvent('trellis:panels-changed'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存顺序失败')
      await load(true)
    } finally {
      setSavingOrder(false)
    }
  }

  async function openLogs(plugin: DesktopPlugin) {
    setLogs({ id: plugin.id, title: `${plugin.name || plugin.id} 日志` })
    setLogEntries([])
    setLogError('')
    setLogLoading(true)
    try {
      setLogEntries(await fetchDesktopPluginLogs(plugin.id))
    } catch (err) {
      setLogError(err instanceof Error ? err.message : '读取失败')
    } finally {
      setLogLoading(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-2xs font-semibold tracking-[0.08em] text-muted-foreground">
            DESKTOP PLUGINS / LOCAL HOST
          </p>
          <h1 className="text-lg leading-6 font-semibold font-heading">插件</h1>
          <p className="text-xs text-muted-foreground">
            插件运行在桌面客户端内，只绑定 127.0.0.1；没有启用任何插件时不会拉起 Node 进程。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {state.hostVersion ? <span>宿主 {state.hostVersion}</span> : null}
          <span>{state.running ? '插件宿主运行中' : '插件宿主未启动'}</span>
          <span>{state.plugins.length} 个插件</span>
        </div>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {state.plugins.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyTitle>还没有插件</EmptyTitle>
            <EmptyDescription>
              安装包内置的插件会列在这里；用户目录下 %LOCALAPPDATA%\TrellisBoard\plugins\&lt;id&gt;\
              可覆盖内置实现。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {state.plugins.map((plugin, index) => {
            const dragging = draggingId === plugin.id
            const dropTarget = dragOverId === plugin.id && !dragging
            return (
              <Panel
                as="article"
                key={plugin.id}
                draggable={!state.disabled && !savingOrder}
                onDragStart={(event) => {
                  setDraggingId(plugin.id)
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', plugin.id)
                }}
                onDragEnd={() => {
                  setDraggingId('')
                  setDragOverId('')
                }}
                onDragOver={(event) => {
                  if (!draggingId) return
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  if (dragOverId !== plugin.id) setDragOverId(plugin.id)
                }}
                onDragLeave={() => {
                  setDragOverId((current) => (current === plugin.id ? '' : current))
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  const id = draggingId || event.dataTransfer.getData('text/plain')
                  const source = state.plugins.findIndex((entry) => entry.id === id)
                  if (source >= 0) void move(state.plugins[source], index)
                  setDraggingId('')
                  setDragOverId('')
                }}
                className={cn(
                  'h-full border p-3.5 transition',
                  dragging ? 'border-dashed border-border opacity-40' : 'border-border',
                  dropTarget && 'border-primary ring-2 ring-primary/25',
                )}
              >
                <header className="flex items-start gap-2">
                  <button
                    type="button"
                    aria-label={`拖动调整 ${plugin.name || plugin.id} 的顺序`}
                    title="按住拖动调整顺序；聚焦后可用 ↑ ↓"
                    className="inline-flex size-6 shrink-0 cursor-grab items-center justify-center rounded text-sm leading-none text-muted-foreground/60 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                      event.preventDefault()
                      void move(plugin, event.key === 'ArrowUp' ? index - 1 : index + 1)
                    }}
                  >
                    ⠿
                  </button>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-sm font-semibold font-heading">
                      {plugin.name || plugin.id}
                    </h2>
                    <p className="truncate font-mono text-xs text-muted-foreground">{plugin.id}</p>
                  </div>
                  <StatusPill tone={statusTone(plugin)} className="shrink-0">
                    {plugin.status === 'error' && plugin.lastError
                      ? '错误'
                      : STATUS_LABELS[plugin.status] || plugin.status}
                  </StatusPill>
                </header>

                <div className="flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
                  <span className="inline-flex h-5 items-center rounded-full border border-border px-2">
                    v{plugin.version ?? '?'}
                  </span>
                  <span className="inline-flex h-5 items-center rounded-full border border-border px-2">
                    api {plugin.apiVersion ?? '?'}
                  </span>
                  {plugin.pid ? (
                    <span className="inline-flex h-5 items-center rounded-full bg-muted px-2">
                      pid {plugin.pid}
                    </span>
                  ) : null}
                  {plugin.restarts ? (
                    <StatusPill tone="warning">重启 {plugin.restarts}</StatusPill>
                  ) : null}
                </div>

                {plugin.lastError ? (
                  <p className="break-words text-xs text-destructive">{plugin.lastError}</p>
                ) : null}

                <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={plugin.enabled}
                      disabled={Boolean(busyId) || !plugin.compatible}
                      onCheckedChange={() => void toggle(plugin)}
                      aria-label={`${plugin.enabled ? '停用' : '启用'} ${plugin.name || plugin.id}`}
                    />
                    <span className="text-xs text-muted-foreground">
                      {busyId === plugin.id ? '处理中…' : plugin.enabled ? '已启用' : '已停用'}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={savingOrder || index === 0}
                      onClick={() => void move(plugin, index - 1)}
                      aria-label={`上移 ${plugin.name || plugin.id}`}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      disabled={savingOrder || index === state.plugins.length - 1}
                      onClick={() => void move(plugin, index + 1)}
                      aria-label={`下移 ${plugin.name || plugin.id}`}
                    >
                      ↓
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!isActive(plugin)}
                      onClick={() => void openLogs(plugin)}
                    >
                      日志
                    </Button>
                  </div>
                </div>
              </Panel>
            )
          })}
        </div>
      )}

      <PluginLogsDialog
        open={Boolean(logs)}
        onOpenChange={(open) => !open && setLogs(null)}
        title={logs?.title || ''}
        loading={logLoading}
        error={logError}
        entries={logEntries}
      />
    </div>
  )
}
