import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { normalizeTaskSlug, slugifyTaskTitle, TASK_SLUG_PATTERN } from '@shared/slug.js'
import { SelectField } from '../SelectField'

type CreateTaskDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: { id: string; name: string }[]
  defaultProjectId: string
  assignees: string[]
  onCreate: (payload: Record<string, unknown>) => Promise<void>
}

export function CreateTaskDialog({
  open,
  onOpenChange,
  projects,
  defaultProjectId,
  assignees,
  onCreate,
}: CreateTaskDialogProps) {
  const [projectId, setProjectId] = useState(defaultProjectId === 'all' ? projects[0]?.id || '' : defaultProjectId)
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [manualSlug, setManualSlug] = useState(false)
  const [description, setDescription] = useState('')
  const [assignee, setAssignee] = useState('')
  const [priority, setPriority] = useState('P1')
  const [branch, setBranch] = useState('')
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setMessage('')
  }, [open])

  useEffect(() => {
    if (!open || projects.length === 0) return
    const pick = defaultProjectId !== 'all' && projects.some((project) => project.id === defaultProjectId)
      ? defaultProjectId
      : projects[0].id
    setProjectId((current) => (projects.some((project) => project.id === current) ? current : pick))
  }, [open, projects, defaultProjectId])

  const suggestedSlug = useMemo(() => normalizeTaskSlug(slug) || slugifyTaskTitle(title), [slug, title])

  async function submit(event: FormEvent) {
    event.preventDefault()
    setMessage('')
    if (!projectId) {
      setMessage('请选择项目')
      return
    }
    if (!title.trim()) {
      setMessage('请填写任务标题')
      return
    }
    if (!assignee.trim()) {
      setMessage('请选择项目成员作为负责人')
      return
    }
    const finalSlug = manualSlug ? normalizeTaskSlug(slug) : slugifyTaskTitle(title)
    if (!finalSlug || !TASK_SLUG_PATTERN.test(finalSlug)) {
      setMessage('任务标识只能包含小写英文字母、数字和单个中划线，例如 board-task-export。')
      return
    }
    setSubmitting(true)
    try {
      await onCreate({
        repositoryId: projectId,
        title: title.trim(),
        description,
        assignee: assignee.trim(),
        priority,
        slug: finalSlug,
        baseBranch: branch.trim() || undefined,
      })
      onOpenChange(false)
      setTitle('')
      setSlug('')
      setDescription('')
      setMessage('任务已创建，状态保持 planning；请继续补齐 PRD 并完成规划评审。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '创建失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>创建任务并派发</DialogTitle>
          <DialogDescription>任务会进入规划阶段，并派发给所选负责人。</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-project">项目 / 仓库</Label>
            <SelectField
              id="create-project"
              value={projectId}
              options={projects.map((project) => ({ value: project.id, label: project.name }))}
              onChange={setProjectId}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-title">任务标题</Label>
            <Input id="create-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-assignee">负责人</Label>
              <Input
                id="create-assignee"
                list="create-assignee-options"
                value={assignee}
                onChange={(event) => setAssignee(event.target.value)}
                placeholder="请选择负责人"
              />
              <datalist id="create-assignee-options">
                {assignees.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-priority">优先级</Label>
              <SelectField
                id="create-priority"
                value={priority}
                options={['P0', 'P1', 'P2', 'P3'].map((value) => ({ value, label: value }))}
                onChange={setPriority}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-slug">任务标识</Label>
            <Input
              id="create-slug"
              value={slug}
              placeholder={suggestedSlug || 'board-task-export'}
              onChange={(event) => {
                setSlug(event.target.value)
                setManualSlug(true)
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-description">描述</Label>
            <Textarea
              id="create-description"
              rows={3}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-branch">分支</Label>
            <Input
              id="create-branch"
              value={branch}
              placeholder="使用 Trellis 默认分支"
              onChange={(event) => setBranch(event.target.value)}
            />
          </div>
          {message ? (
            <p className="text-xs text-muted-foreground" role="status">
              {message}
            </p>
          ) : null}
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? '创建中…' : '创建并派发'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
