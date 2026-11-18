import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import type { BoardTask } from './task-view.ts'
import { recommendedTask } from './task-view.ts'
import { cn } from '@/lib/utils'
import { Panel } from '@/components/ui/panel'

type FlowSignalsProps = {
  tasks: BoardTask[]
  wipLimit?: number
  onSaveWip: (limit: number) => Promise<void>
}

export function FlowSignals({ tasks, wipLimit, onSaveWip }: FlowSignalsProps) {
  const [value, setValue] = useState(String(wipLimit ?? 2))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setValue(String(wipLimit ?? 2))
  }, [wipLimit])

  const limit = wipLimit ?? 2
  const implementing = tasks.filter((task) => task.derivedStage === 'implement').length
  const blocked = tasks.filter((task) => task.execution?.isBlocked).length
  const unblocked = tasks.filter((task) => task.execution?.isUnblockedReady).length
  const gaps = tasks.filter(
    (task) =>
      (task.execution?.risk?.dorMissingCount || 0) > 0 ||
      (task.execution?.risk?.dodMissingCount || 0) > 0,
  ).length
  const nextUp = recommendedTask(tasks)
  const overLimit = implementing > limit

  async function save() {
    const next = Number(value)
    if (!Number.isInteger(next) || next < 1 || next > 9) {
      toast.error('WIP 软上限必须是 1 到 9 的整数')
      return
    }
    setSaving(true)
    try {
      await onSaveWip(next)
      toast.success('WIP 软上限已保存')
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel className="border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0">
          <p className="text-2xs font-semibold tracking-[0.08em] text-muted-foreground">
            FLOW / 个人承载
          </p>
          <h2 className="text-sm leading-5 font-semibold font-heading">流动信号</h2>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            WIP 软上限
            <Input
              className="h-8 w-14 text-xs"
              inputMode="numeric"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              aria-label="WIP 软上限"
            />
          </label>
          <Button variant="outline" onClick={save} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Signal
          label="实现中 WIP"
          value={implementing}
          suffix={`/${limit}`}
          caption={overLimit ? '已超出软上限' : '仍在承载范围内'}
          tone={overLimit ? 'warning' : 'primary'}
        />
        <Signal
          label="当前被阻断"
          value={blocked}
          caption="等待外部条件"
          tone={blocked ? 'destructive' : 'muted'}
        />
        <Signal
          label="阻断已解除"
          value={unblocked}
          caption="可以立即推进"
          tone={unblocked ? 'success' : 'muted'}
        />
        <Signal
          label="条件缺口"
          value={gaps}
          caption="按当前阶段检查"
          tone={gaps ? 'warning' : 'muted'}
        />
      </div>

      <p className="text-xs text-muted-foreground">
        焦点建议 ·{' '}
        {nextUp ? (
          <b className="font-medium text-foreground">{nextUp.title}</b>
        ) : (
          '当前没有需要优先处理的信号'
        )}
      </p>
    </Panel>
  )
}

const TONES = {
  primary: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  destructive: 'text-destructive',
  muted: 'text-foreground',
} as const

type SignalProps = {
  label: string
  value: number
  suffix?: string
  caption: string
  tone: keyof typeof TONES
}

function Signal({ label, value, suffix, caption, tone }: SignalProps) {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/40 px-2.5 py-2">
      <p className="text-2xs text-muted-foreground">{label}</p>
      <p className={cn('text-xl leading-6 font-semibold font-heading', TONES[tone])}>
        {value}
        {suffix ? (
          <span className="text-xs font-normal text-muted-foreground">{suffix}</span>
        ) : null}
      </p>
      <p className="text-2xs text-muted-foreground">{caption}</p>
    </div>
  )
}
