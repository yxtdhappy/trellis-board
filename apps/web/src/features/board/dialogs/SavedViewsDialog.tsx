import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FILTER_STAGES } from '@/lib/execution-filter.js'
import { toast } from 'sonner'
import { SelectField } from '../SelectField.tsx'

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const
const BLOCKED_OPTIONS = [
  { id: 'any', label: '不限阻断状态' },
  { id: 'blocked', label: '只看被阻断' },
  { id: 'unblocked', label: '只看未阻断' },
] as const

type SavedViewsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (name: string, filter: Record<string, unknown>) => Promise<string>
}

export function SavedViewsDialog({ open, onOpenChange, onSave }: SavedViewsDialogProps) {
  const [name, setName] = useState('')
  const [priorities, setPriorities] = useState<string[]>([])
  const [stages, setStages] = useState<string[]>([])
  const [tags, setTags] = useState('')
  const [dueWithinDays, setDueWithinDays] = useState('')
  const [staleDays, setStaleDays] = useState('')
  const [blocked, setBlocked] = useState<(typeof BLOCKED_OPTIONS)[number]['id']>('any')
  const [saving, setSaving] = useState(false)

  function reset() {
    setName('')
    setPriorities([])
    setStages([])
    setTags('')
    setDueWithinDays('')
    setStaleDays('')
    setBlocked('any')
  }

  function toggle(list: string[], value: string) {
    return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
  }

  async function submit() {
    const filter: Record<string, unknown> = {}
    if (priorities.length) filter.priorities = priorities
    if (stages.length) filter.stages = stages
    const tagList = tags
      .split(/[,，\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean)
    if (tagList.length) filter.tags = tagList
    if (dueWithinDays) filter.dueWithinDays = Number(dueWithinDays)
    if (staleDays) filter.staleDays = Number(staleDays)
    if (blocked !== 'any') filter.blocked = blocked

    if (!name.trim()) {
      toast.error('视图名称不能为空')
      return
    }
    if (!Object.keys(filter).length) {
      toast.error('至少勾选或填写一个筛选条件')
      return
    }
    setSaving(true)
    try {
      await onSave(name.trim(), filter)
      toast.success('组合视图已保存')
      reset()
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[960px]">
        <DialogHeader>
          <DialogTitle className="text-base">保存组合视图</DialogTitle>
          <DialogDescription>把当前勾选的筛选条件保存成一条可复用的执行视图。</DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label className="text-[10px]">视图名称</Label>
            <Input
              className="text-xs"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label className="text-[10px]">优先级</Label>
            <div className="flex flex-wrap gap-1.5">
              {PRIORITIES.map((priority) => (
                <Button
                  key={priority}
                  type="button"
                  size="xs"
                  variant={priorities.includes(priority) ? 'default' : 'outline'}
                  className="rounded-full"
                  onClick={() => setPriorities((current) => toggle(current, priority))}
                >
                  {priority}
                </Button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <Label className="text-[10px]">阶段</Label>
            <div className="flex flex-wrap gap-1.5">
              {FILTER_STAGES.map((stage) => (
                <Button
                  key={stage.id}
                  type="button"
                  size="xs"
                  variant={stages.includes(stage.id) ? 'default' : 'outline'}
                  className="rounded-full"
                  onClick={() => setStages((current) => toggle(current, stage.id))}
                >
                  {stage.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label className="text-[10px]">标签（逗号分隔）</Label>
              <Input
                className="text-xs"
                value={tags}
                onChange={(event) => setTags(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[10px]">阻断状态</Label>
              <SelectField
                ariaLabel="阻断状态"
                className="text-xs"
                value={blocked}
                options={BLOCKED_OPTIONS.map((option) => ({
                  value: option.id,
                  label: option.label,
                }))}
                onChange={(next) => setBlocked(next as (typeof BLOCKED_OPTIONS)[number]['id'])}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[10px]">截止在 N 天内</Label>
              <Input
                className="text-xs"
                type="number"
                min={0}
                value={dueWithinDays}
                onChange={(event) => setDueWithinDays(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label className="text-[10px]">超过 N 天未动</Label>
              <Input
                className="text-xs"
                type="number"
                min={0}
                value={staleDays}
                onChange={(event) => setStaleDays(event.target.value)}
              />
            </div>
          </div>
        </DialogBody>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button size="sm" disabled={saving} onClick={() => void submit()}>
            {saving ? '正在保存…' : '保存组合视图'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
