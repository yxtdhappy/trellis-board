import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  fetchPluginLogs,
  fetchPlugins,
  reloadPlugins,
  setPluginSort,
  startPlugin,
  stopPlugin,
  type PluginInfo,
  type PluginLogEntry,
} from '@/api/plugins'
import { PluginLogsDialog } from './PluginLogsDialog.tsx'

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

const STATUS_TONES: Record<string, string> = {
  running: 'bg-success-soft text-success',
  starting: 'bg-warning-soft text-warning',
  error: 'bg-destructive-soft text-destructive',
  crashing: 'bg-destructive-soft text-destructive',
  incompatible: 'bg-destructive-soft text-destructive',
  'missing-secret': 'bg-warning-soft text-warning',
  stopped: 'bg-muted text-muted-foreground',
  disabled: 'bg-muted text-muted-foreground',
}

function statusTone(plugin: PluginInfo) {
  if (plugin.status === 'error' && plugin.lastError) return STATUS_TONES.error
  return STATUS_TONES[plugin.status] || 'bg-secondary text-secondary-foreground'
}

/**
 * 插件级面板排序：数字小的面板靠前，留空回退到插件清单里的 panels[].order。
 * 失焦或回车提交，Esc 还原；保存成功后通知看板重排导航。
 */
function SortInput({ plugin, onSaved }: { plugin: PluginInfo; onSaved: () => Promise<void> }) {
  const current = plugin.sort == null ? '' : String(plugin.sort)
  const [draft, setDraft] = useState(current)
  const [saving, setSaving] = useState(false)
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) setDraft(current)
  }, [current])

  async function commit() {
    const text = draft.trim()
    const next = text === '' ? null : Number(text)
    if (next !== null && !Number.isFinite(next)) {
      toast.error('排序必须是数字，留空表示默认顺序')
      setDraft(current)
      return
    }
    if (next === (plugin.sort ?? null)) return
    setSaving(true)
    try {
      await setPluginSort(plugin.id, next)
      toast.success(next === null ? `${plugin.id} 恢复默认顺序` : `${plugin.id} 排序设为 ${next}`)
      await onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存排序失败')
      setDraft(current)
    } finally {
      setSaving(false)
    }
  }

  return (
    <label className="ml-auto flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
      排序
      <input
        type="number"
        step="1"
        inputMode="numeric"
        value={draft}
        placeholder="默认"
        disabled={saving}
        title="面板顺序：数字小的靠前；留空按插件清单里的顺序。保存后立即生效，不重启插件。"
        className="h-7 w-14 rounded-md border border-border bg-background px-1.5 text-center font-mono text-xs disabled:opacity-50"
        onFocus={() => {
          focused.current = true
        }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          focused.current = false
          void commit()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') {
            setDraft(current)
            event.currentTarget.blur()
          }
        }}
      />
    </label>
  )
}

export function PluginsView() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([])
  const [disabled, setDisabled] = useState(false)
  const [hostVersion, setHostVersion] = useState('')
  const [error, setError] = useState('')
  const [busyId, setBusyId] = useState('')
  const [reloading, setReloading] = useState(false)
  const [logs, setLogs] = useState<{ id: string; title: string } | null>(null)
  const [logEntries, setLogEntries] = useState<PluginLogEntry[]>([])
  const [logError, setLogError] = useState('')
  const [logLoading, setLogLoading] = useState(false)
  const mounted = useRef(true)

  const load = useCallback(async (quiet = false) => {
    try {
      if (!quiet) setError('')
      const data = await fetchPlugins()
      if (!mounted.current) return
      setPlugins(data.plugins)
      setDisabled(data.disabled)
      setHostVersion(data.hostVersion || '')
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

  async function toggle(plugin: PluginInfo) {
    const running = plugin.status === 'running' || plugin.status === 'starting'
    setBusyId(plugin.id)
    try {
      if (running) await stopPlugin(plugin.id)
      else await startPlugin(plugin.id)
      toast.success(running ? `已停止 ${plugin.id}` : `已启动 ${plugin.id}`)
      await load(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusyId('')
    }
  }

  const savedSort = useCallback(async () => {
    await load(true)
    // 面板顺序在 /api/panels 里，让看板重排左侧导航。
    window.dispatchEvent(new CustomEvent('trellis:panels-changed'))
  }, [load])

  async function reload() {
    setReloading(true)
    try {
      const result = await reloadPlugins()
      if (!result.ok) {
        toast.error(result.error || '重载插件配置失败')
        return
      }
      const parts: string[] = []
      if (result.added.length) parts.push(`新增 ${result.added.length}`)
      if (result.removed.length) parts.push(`移除 ${result.removed.length}`)
      if (result.restarted.length) parts.push(`重启 ${result.restarted.length}`)
      if (result.started.length) parts.push(`启动 ${result.started.length}`)
      if (result.stopped.length) parts.push(`停止 ${result.stopped.length}`)
      toast.success(parts.length ? `配置已重载：${parts.join('，')}` : '配置已重载，没有变化')
      if (result.failed.length) {
        toast.error(
          `${result.failed.length} 个插件重载失败：${result.failed.map((item) => item.id).join('，')}`,
        )
      }
      await load(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重载插件配置失败')
    } finally {
      setReloading(false)
    }
  }

  async function openLogs(plugin: PluginInfo) {
    setLogs({ id: plugin.id, title: `${plugin.name || plugin.id} 日志` })
    setLogEntries([])
    setLogError('')
    setLogLoading(true)
    try {
      setLogEntries(await fetchPluginLogs(plugin.id))
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
          <p className="text-[0.625rem] font-semibold tracking-[0.08em] text-muted-foreground">
            PLUGINS / RUNTIME
          </p>
          <h1 className="text-[1.1875rem] leading-6 font-semibold font-heading">
            插件在做什么，一眼看清
          </h1>
          <p className="text-[0.71875rem] text-muted-foreground">
            版本、兼容性、运行状态与最近日志；启停会立即作用于插件进程。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[0.6875rem] text-muted-foreground">
            {hostVersion ? `宿主 ${hostVersion}` : ''}
            {hostVersion ? ' · ' : ''}
            {plugins.length} 个插件
          </span>
          <button
            type="button"
            disabled={disabled || reloading}
            onClick={() => void reload()}
            title="重读插件配置目录（TrellisBoard/plugins）的 plugins.json 与 plugins.secrets.json，重启受影响的插件"
            className="h-7 rounded-md border border-border px-2.5 text-[0.6875rem] hover:bg-muted disabled:opacity-50"
          >
            {reloading ? '重载中…' : '刷新配置'}
          </button>
        </div>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-lg bg-destructive-soft px-3 py-2 text-xs text-destructive"
        >
          {error}
        </p>
      ) : null}

      {disabled ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
          插件机制已被 TRELLIS_PLUGINS_DISABLED=1 关闭。
        </p>
      ) : plugins.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
          还没有加载任何插件。把插件目录放到 &lt;TrellisBoard&gt;/plugins/&lt;id&gt;/ 或安装目录的
          plugins/&lt;id&gt;/， 并在 &lt;TrellisBoard&gt;/plugins/plugins.json 登记后刷新。
        </p>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {plugins.map((plugin) => {
            const running = plugin.status === 'running' || plugin.status === 'starting'
            return (
              <article
                key={plugin.id}
                className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3.5"
              >
                <header className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="truncate text-[0.9375rem] font-semibold font-heading">
                      {plugin.name || plugin.id}
                    </h2>
                    <p className="truncate font-mono text-[0.6875rem] text-muted-foreground">
                      {plugin.id}
                    </p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] font-semibold ${statusTone(plugin)}`}
                  >
                    {plugin.status === 'error' && plugin.lastError
                      ? '错误'
                      : STATUS_LABELS[plugin.status] || plugin.status}
                  </span>
                </header>

                <div className="flex flex-wrap gap-1.5 text-[0.625rem] text-muted-foreground">
                  <span className="rounded-full border border-border px-2 py-0.5">
                    v{plugin.version ?? '?'}
                  </span>
                  <span className="rounded-full border border-border px-2 py-0.5">
                    api {plugin.apiVersion ?? '?'}
                  </span>
                  {!plugin.compatible ? (
                    <span className="rounded-full bg-destructive-soft px-2 py-0.5 font-medium text-destructive">
                      {plugin.reason || '不兼容'}
                    </span>
                  ) : null}
                  {plugin.pid ? (
                    <span className="rounded-full bg-muted px-2 py-0.5">pid {plugin.pid}</span>
                  ) : null}
                  {plugin.restarts ? (
                    <span className="rounded-full bg-warning-soft px-2 py-0.5 text-warning">
                      重启 {plugin.restarts}
                    </span>
                  ) : null}
                </div>

                {plugin.rootPaths?.length ? (
                  <p className="text-[0.6875rem] text-muted-foreground">
                    启动后占用：{plugin.rootPaths.join('，')}
                  </p>
                ) : null}
                {plugin.lastError ? (
                  <p className="text-[0.6875rem] text-destructive">{plugin.lastError}</p>
                ) : null}

                <div className="mt-auto flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={Boolean(busyId) || !plugin.compatible}
                    onClick={() => void toggle(plugin)}
                  >
                    {busyId === plugin.id ? '处理中…' : running ? '停止' : '启动'}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void openLogs(plugin)}
                  >
                    日志
                  </Button>
                  <SortInput plugin={plugin} onSaved={savedSort} />
                </div>
              </article>
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
