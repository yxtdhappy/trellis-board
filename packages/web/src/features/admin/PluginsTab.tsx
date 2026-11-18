import { useCallback, useEffect, useState } from 'react'
import { Puzzle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SelectField } from '@/features/board/SelectField'
import type { AdminConsole } from '@/hooks/useAdminConsole'
import { fetchAdminProjects, type TeamProject } from '@/api/admin'
import {
  addBinding,
  listBindings,
  listTeamPlugins,
  removeBinding,
  setPluginEnabled,
  setTeamPluginEnabled,
  startPlugin,
  stopPlugin,
  type PluginBindingView,
  type TeamPluginView,
} from '@/api/team-plugins'
import { StatusPill } from '@/components/ui/status-pill'
import { statusTone } from '@/lib/admin-shared'
import { EmptyRow } from '@/components/ui/empty-row'
import { Row } from './shared.tsx'
import { Panel } from '@/components/ui/panel'

const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

/**
 * 插件管理：全局启停（系统管理员）+ 团队启用（团队管理员）+ 项目绑定（项目 lead）。
 *
 * 这里刻意不提供"替用户填账号密码"的入口：第三方账号只能本人登录，
 * 服务端也不保存（design.md §11 D2/D5）。
 */
export function PluginsTab({ console: consoleApi }: { console: AdminConsole }) {
  const { adminTeamId, systemAdmin, isAdmin } = consoleApi
  const [plugins, setPlugins] = useState<TeamPluginView[]>([])
  const [selected, setSelected] = useState<string>('')
  const [bindings, setBindings] = useState<PluginBindingView[]>([])
  const [projects, setProjects] = useState<TeamProject[]>([])
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({
    projectId: '',
    externalProjectId: '',
    externalProjectName: '',
  })

  const teamId = adminTeamId || ''

  const reload = useCallback(async () => {
    const rows = await listTeamPlugins(teamId || null)
    setPlugins(rows)
    // 默认落在「当前团队已启用」的插件上，否则第一个；不然一进来看到的是无关插件的空绑定。
    const preferred =
      rows.find((row) => row.teamEnabled) ?? rows.find((row) => row.enabled) ?? rows[0]
    setSelected((current) =>
      rows.some((row) => row.id === current) ? current : (preferred?.id ?? ''),
    )
  }, [teamId])

  useEffect(() => {
    void reload().catch((error) => toast.error(error.message || '加载插件失败'))
  }, [reload])

  useEffect(() => {
    if (!teamId) {
      setBindings([])
      setProjects([])
      return
    }
    void fetchAdminProjects(teamId)
      .then((rows) => setProjects([...rows].sort((a, b) => collator.compare(a.name, b.name))))
      .catch(() => setProjects([]))
  }, [teamId])

  const reloadBindings = useCallback(async () => {
    if (!selected || !teamId) {
      setBindings([])
      return
    }
    const rows = await listBindings(selected, teamId)
    setBindings(rows)
  }, [selected, teamId])

  useEffect(() => {
    void reloadBindings().catch(() => setBindings([]))
  }, [reloadBindings])

  async function run(action: () => Promise<void>, message: string) {
    if (busy) return
    setBusy(true)
    try {
      await action()
      toast.success(message)
      await reload()
      await reloadBindings()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const plugin = plugins.find((row) => row.id === selected) ?? null
  const needTeam = !teamId

  return (
    <div className="grid gap-3.5 lg:grid-cols-[minmax(0,1fr)_380px]">
      <Panel
        kicker="PLUGINS / REGISTRY"
        title="已装载的插件"
        description={
          needTeam
            ? '先在右上角选择一个团队：插件启用与项目绑定都是按团队配置的。'
            : '插件随服务启动；代码更新需要重启服务。团队启用只决定成员能不能看到入口，账号仍由本人登录。'
        }
        action={
          <Button variant="outline" size="sm" type="button" onClick={() => void reload()}>
            刷新
          </Button>
        }
      >
        <div className="flex flex-col">
          {plugins.length === 0 ? (
            <EmptyRow>还没有发现插件。把插件目录放到 {`<data>/plugins`} 后重启服务。</EmptyRow>
          ) : (
            plugins.map((row) => (
              <Row
                key={row.id}
                actions={
                  <>
                    <StatusPill tone={statusTone(row.status)}>{row.status || 'unknown'}</StatusPill>
                    {isAdmin ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        disabled={busy || needTeam}
                        onClick={() =>
                          void run(
                            () => setTeamPluginEnabled(row.id, teamId, !row.teamEnabled),
                            row.teamEnabled ? '已关闭团队入口' : '已为当前团队启用',
                          )
                        }
                      >
                        {row.teamEnabled ? '关闭团队入口' : '为团队启用'}
                      </Button>
                    ) : null}
                    {systemAdmin ? (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void run(
                              () => setPluginEnabled(row.id, !row.enabled),
                              row.enabled ? '已停用插件' : '已启用插件',
                            )
                          }
                        >
                          {row.enabled ? '全局停用' : '全局启用'}
                        </Button>
                        {row.running ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            type="button"
                            disabled={busy}
                            onClick={() => void run(() => stopPlugin(row.id), '插件已停止')}
                          >
                            停止进程
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            type="button"
                            disabled={busy || !row.enabled}
                            onClick={() => void run(() => startPlugin(row.id), '插件已启动')}
                          >
                            启动进程
                          </Button>
                        )}
                      </>
                    ) : null}
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      onClick={() => setSelected(row.id)}
                    >
                      详情
                    </Button>
                  </>
                }
              >
                <button
                  type="button"
                  className="flex w-full items-center gap-2 text-left"
                  onClick={() => setSelected(row.id)}
                >
                  <Puzzle className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  <span className="text-xs font-semibold text-foreground">{row.name}</span>
                  <span className="text-xs text-muted-foreground">v{row.version}</span>
                  {row.sessions > 0 ? (
                    <span className="text-2xs text-muted-foreground">{row.sessions} 人已登录</span>
                  ) : null}
                </button>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {row.lastError || row.description || row.id}
                </p>
              </Row>
            ))
          )}
        </div>
      </Panel>

      <Panel
        kicker="PROJECT BINDINGS"
        title="项目绑定"
        description={
          teamId
            ? '把 Board 项目对上插件里的项目，成员在面板里选项目时就不用猜。'
            : '先在上方选择一个团队。'
        }
      >
        <div className="flex flex-col gap-2">
          {bindings.length === 0 ? (
            <EmptyRow>当前团队还没有绑定项目。</EmptyRow>
          ) : (
            bindings.map((row) => (
              <Row
                key={row.id}
                actions={
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    className="text-destructive"
                    disabled={busy}
                    onClick={() =>
                      void run(() => removeBinding(row.pluginId, row.teamId, row.id), '已解除绑定')
                    }
                  >
                    解除
                  </Button>
                }
              >
                <p className="text-xs font-semibold text-foreground">
                  {row.projectName || row.projectId}
                </p>
                <p className="text-xs text-muted-foreground">
                  插件项目：{row.externalProjectName || row.externalProjectId}
                </p>
              </Row>
            ))
          )}
        </div>

        <div className="mt-2 flex flex-col gap-1.5 rounded-lg bg-muted/40 p-2.5">
          <SelectField
            ariaLabel="选择 Board 项目"
            placeholder="选择 Board 项目"
            value={form.projectId}
            options={projects.map((project) => ({ value: project.id, label: project.name }))}
            onChange={(next) => setForm((prev) => ({ ...prev, projectId: next }))}
          />
          <Input
            className="text-xs"
            placeholder="插件侧项目 ID"
            value={form.externalProjectId}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, externalProjectId: event.target.value }))
            }
          />
          <Input
            className="text-xs"
            placeholder="插件侧项目名称（可选）"
            value={form.externalProjectName}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, externalProjectName: event.target.value }))
            }
          />
          <Button
            type="button"
            disabled={busy || needTeam || !selected || !form.projectId || !form.externalProjectId}
            onClick={() =>
              void run(async () => {
                await addBinding(selected, teamId, form)
                setForm({ projectId: '', externalProjectId: '', externalProjectName: '' })
              }, '已绑定项目')
            }
          >
            添加绑定
          </Button>
        </div>

        {plugin ? (
          <p className="text-2xs text-muted-foreground">
            当前插件：{plugin.name} · {plugin.running ? '进程运行中' : '进程未运行'}
          </p>
        ) : null}
      </Panel>
    </div>
  )
}
