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
import { Field, FieldLabel } from '@/components/ui/field'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { FILTER_STAGES } from '@/lib/execution-filter.js'
import { toast } from 'sonner'
import { SelectField } from '../SelectField.tsx'

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const
const PILL_ITEM =
  'h-6 rounded-full px-2 text-xs aria-pressed:border-transparent aria-pressed:bg-primary aria-pressed:text-primary-foreground'
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
      <DialogContent className="sm:max-w-160">
        <DialogHeader>
          <DialogTitle>保存组合视图</DialogTitle>
          <DialogDescription>把当前勾选的筛选条件保存成一条可复用的执行视图。</DialogDescription>
        </DialogHeader>

        <DialogBody className="flex flex-col gap-3">
          <Field className="gap-1.5">
            <FieldLabel htmlFor="saved-view-name">视图名称</FieldLabel>
            <Input
              id="saved-view-name"
              className="text-xs"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>

          <Field className="gap-1.5">
            <FieldLabel>优先级</FieldLabel>
            <ToggleGroup
              multiple
              value={priorities}
              onValueChange={(value: string[]) => setPriorities(value)}
              spacing={1.5}
              aria-label="优先级"
              className="flex flex-wrap gap-1.5"
            >
              {PRIORITIES.map((priority) => (
                <ToggleGroupItem
                  key={priority}
                  value={priority}
                  variant="outline"
                  className={PILL_ITEM}
                >
                  {priority}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>

          <Field className="gap-1.5">
            <FieldLabel>阶段</FieldLabel>
            <ToggleGroup
              multiple
              value={stages}
              onValueChange={(value: string[]) => setStages(value)}
              spacing={1.5}
              aria-label="阶段"
              className="flex flex-wrap gap-1.5"
            >
              {FILTER_STAGES.map((stage) => (
                <ToggleGroupItem
                  key={stage.id}
                  value={stage.id}
                  variant="outline"
                  className={PILL_ITEM}
                >
                  {stage.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </Field>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field className="gap-1.5">
              <FieldLabel htmlFor="saved-view-tags">标签（逗号分隔）</FieldLabel>
              <Input
                id="saved-view-tags"
                className="text-xs"
                value={tags}
                onChange={(event) => setTags(event.target.value)}
              />
            </Field>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="saved-view-blocked">阻断状态</FieldLabel>
              <SelectField
                id="saved-view-blocked"
                ariaLabel="阻断状态"
                className="text-xs"
                value={blocked}
                options={BLOCKED_OPTIONS.map((option) => ({
                  value: option.id,
                  label: option.label,
                }))}
                onChange={(next) => setBlocked(next as (typeof BLOCKED_OPTIONS)[number]['id'])}
              />
            </Field>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="saved-view-due-within">截止在 N 天内</FieldLabel>
              <Input
                id="saved-view-due-within"
                className="text-xs"
                type="number"
                min={0}
                value={dueWithinDays}
                onChange={(event) => setDueWithinDays(event.target.value)}
              />
            </Field>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="saved-view-stale-days">超过 N 天未动</FieldLabel>
              <Input
                id="saved-view-stale-days"
                className="text-xs"
                type="number"
                min={0}
                value={staleDays}
                onChange={(event) => setStaleDays(event.target.value)}
              />
            </Field>
          </div>
        </DialogBody>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={saving} onClick={() => void submit()}>
            {saving ? '正在保存…' : '保存组合视图'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
