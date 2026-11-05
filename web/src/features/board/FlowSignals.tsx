import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from 'sonner'
import type { BoardTask } from './task-view'
import { isAttention, recommendedTask } from './task-view'

type FlowSignalsProps = {
  tasks: BoardTask[]
  wipLimit?: number
  onSaveWip: (limit: number) => Promise<void>
}

export function FlowSignals({ tasks, wipLimit, onSaveWip }: FlowSignalsProps) {
  const [value, setValue] = useState(String(wipLimit ?? 6))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setValue(String(wipLimit ?? 6))
  }, [wipLimit])

  const implementing = tasks.filter((task) => task.derivedStage === 'implement').length
  const attention = tasks.filter(isAttention).length
  const nextUp = recommendedTask(tasks)

  async function save() {
    const limit = Number(value)
    if (!Number.isInteger(limit) || limit < 1 || limit > 99) {
      toast.error('WIP 软上限必须是 1 到 99 的整数')
      return
    }
    setSaving(true)
    try {
      await onSaveWip(limit)
      toast.success('WIP 软上限已保存')
    } catch (error) {
      toast.error((error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="flex flex-wrap items-center gap-3 rounded-xl border border-border/70 bg-card px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <span className="text-[11px] font-semibold">流动信号</span>
        <span className="rounded-full bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
          WIP {implementing}/{wipLimit ?? 6}
        </span>
      </div>
      <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        WIP 软上限
        <Input
          className="h-7 w-16 text-xs"
          inputMode="numeric"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-label="WIP 软上限"
        />
      </label>
      <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={save} disabled={saving}>
        {saving ? '保存中…' : '保存'}
      </Button>
      <span className="text-[11px] text-muted-foreground">{attention} 个任务需要关注</span>
      {nextUp ? (
        <span className="ml-auto truncate text-[11px] text-muted-foreground">
          建议优先：<b className="font-medium text-foreground">{nextUp.title}</b>
        </span>
      ) : null}
    </section>
  )
}
