import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
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
import { Textarea } from '@/components/ui/textarea'
import { fetchTaskSpaceAssignees, type TaskSpace, type TaskSpaceAssignee } from '@/api/board'
import {
  normalizeTaskSlug,
  slugifyTaskTitle,
  TASK_SLUG_PATTERN,
} from '@trellis-board/shared/slug.js'
import { createIdempotencyKey, taskCommandState } from '@/lib/team-client.js'
import { SelectField } from '../SelectField.tsx'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'

type CreateTaskDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: {
    id: string
    name: string
    taskSpaces?: TaskSpace[]
  }[]
  defaultProjectId: string
  defaultTaskSpaceId?: string
  localTaskSpaceId?: string
  onCreate: (payload: Record<string, unknown>) => Promise<void>
}

export function CreateTaskDialog({
  open,
  onOpenChange,
  projects,
  defaultProjectId,
  defaultTaskSpaceId = '',
  localTaskSpaceId = '',
  onCreate,
}: CreateTaskDialogProps) {
  const [projectId, setProjectId] = useState(
    defaultProjectId === 'all' ? projects[0]?.id || '' : defaultProjectId,
  )
  const [taskSpaceId, setTaskSpaceId] = useState('')
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [manualSlug, setManualSlug] = useState(false)
  const [description, setDescription] = useState('')
  const [assigneeUserId, setAssigneeUserId] = useState('')
  const [taskAssignees, setTaskAssignees] = useState<TaskSpaceAssignee[]>([])
  const [priority, setPriority] = useState('P1')
  const [feedback, setFeedback] = useState<{ tone: 'status' | 'error'; text: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setFeedback(null)
  }, [open])

  useEffect(() => {
    if (!open || projects.length === 0) return
    const pick =
      defaultProjectId !== 'all' && projects.some((project) => project.id === defaultProjectId)
        ? defaultProjectId
        : projects[0].id
    setProjectId((current) => (projects.some((project) => project.id === current) ? current : pick))
  }, [open, projects, defaultProjectId])

  const selectedProject = projects.find((project) => project.id === projectId)
  const taskSpaces = useMemo(() => selectedProject?.taskSpaces || [], [selectedProject])
  const selectedTaskSpace = taskSpaces.find((taskSpace) => taskSpace.id === taskSpaceId)
  const commandState = taskCommandState(selectedTaskSpace)

  useEffect(() => {
    if (!open) return
    if (taskSpaces.some((taskSpace) => taskSpace.id === taskSpaceId)) {
      if (taskSpaces.length > 1) return
      setTaskSpaceId(taskSpaces[0].id)
      return
    }
    const preferred =
      taskSpaces.find((taskSpace) => taskSpace.id === defaultTaskSpaceId) ||
      taskSpaces.find((taskSpace) => taskSpace.id === localTaskSpaceId) ||
      taskSpaces[0]
    setTaskSpaceId(preferred?.id || '')
    setAssigneeUserId('')
  }, [defaultTaskSpaceId, localTaskSpaceId, open, taskSpaceId, taskSpaces])

  useEffect(() => {
    if (!open || !taskSpaceId) {
      setTaskAssignees([])
      setAssigneeUserId('')
      return
    }
    let active = true
    fetchTaskSpaceAssignees(taskSpaceId)
      .then((values) => {
        if (!active) return
        setTaskAssignees(values)
        setAssigneeUserId((current) =>
          values.some((value) => value.userId === current) ? current : '',
        )
      })
      .catch((error) => {
        if (active) {
          setTaskAssignees([])
          setFeedback({
            tone: 'error',
            text: error instanceof Error ? error.message : '无法读取项目负责人',
          })
        }
      })
    return () => {
      active = false
    }
  }, [open, taskSpaceId])

  const suggestedSlug = useMemo(
    () => normalizeTaskSlug(slug) || slugifyTaskTitle(title),
    [slug, title],
  )

  async function submit(event: FormEvent) {
    event.preventDefault()
    setFeedback(null)
    if (!projectId) {
      setFeedback({ tone: 'error', text: '请选择项目' })
      return
    }
    if (!taskSpaceId) {
      setFeedback({ tone: 'error', text: '请选择项目分支任务空间' })
      return
    }
    if (!commandState.canSubmit) {
      setFeedback({ tone: 'error', text: commandState.reason || '当前分支任务空间不可写' })
      return
    }
    if (!title.trim()) {
      setFeedback({ tone: 'error', text: '请填写任务标题' })
      return
    }
    if (!assigneeUserId) {
      setFeedback({ tone: 'error', text: '请选择项目成员作为负责人' })
      return
    }
    if (!description.trim()) {
      setFeedback({ tone: 'error', text: '请填写任务描述' })
      return
    }
    const finalSlug = manualSlug ? normalizeTaskSlug(slug) : slugifyTaskTitle(title)
    if (!finalSlug || !TASK_SLUG_PATTERN.test(finalSlug)) {
      setFeedback({
        tone: 'error',
        text: '任务标识只能包含小写英文字母、数字和单个中划线，例如 board-task-export。',
      })
      return
    }
    setSubmitting(true)
    try {
      await onCreate({
        taskSpaceId,
        title: title.trim(),
        description,
        assigneeUserId,
        priority,
        slug: finalSlug,
        idempotencyKey: createIdempotencyKey(),
      })
      onOpenChange(false)
      setTitle('')
      setSlug('')
      setDescription('')
      setFeedback({
        tone: 'status',
        text: '任务已创建并等待目标客户端接管；可先在看板查看待交付状态。',
      })
    } catch (error) {
      setFeedback({ tone: 'error', text: error instanceof Error ? error.message : '创建失败' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-150">
        <DialogHeader>
          <DialogTitle>创建任务并派发</DialogTitle>
          <DialogDescription>
            提交后任务立即进入看板；目标客户端离线时会保持待交付，稍后上线再接管。
          </DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-1 flex-col gap-4" onSubmit={submit}>
          <DialogBody className="flex flex-col gap-3">
            <Field className="gap-1.5">
              <FieldLabel htmlFor="create-project">项目 / 仓库</FieldLabel>
              <SelectField
                id="create-project"
                value={projectId}
                options={projects.map((project) => ({
                  value: project.id,
                  label: project.name,
                }))}
                onChange={setProjectId}
              />
            </Field>
            {taskSpaces.length > 1 ? (
              <Field className="gap-1.5">
                <FieldLabel htmlFor="create-task-space">共享分支任务空间</FieldLabel>
                <SelectField
                  id="create-task-space"
                  value={taskSpaceId}
                  placeholder="请选择分支"
                  options={taskSpaces.map((taskSpace) => ({
                    value: taskSpace.id,
                    label: taskSpace.branchName,
                  }))}
                  onChange={setTaskSpaceId}
                />
              </Field>
            ) : taskSpaces.length === 1 ? (
              <p className="text-xs text-muted-foreground">
                同步任务空间：{taskSpaces[0].branchName}
              </p>
            ) : (
              <p className="text-xs text-destructive">该项目还没有可用的分支任务空间。</p>
            )}
            {taskSpaceId && !commandState.canSubmit ? (
              <p className="text-xs text-warning" role="status">
                {commandState.reason}
              </p>
            ) : null}
            <Field className="gap-1.5">
              <FieldLabel htmlFor="create-title">任务标题</FieldLabel>
              <Input
                id="create-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={120}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field className="gap-1.5">
                <FieldLabel htmlFor="create-assignee">负责人</FieldLabel>
                <SelectField
                  id="create-assignee"
                  value={assigneeUserId}
                  placeholder="请选择负责人"
                  options={taskAssignees.map((member) => ({
                    value: member.userId,
                    label: `${member.displayName || member.username}${member.online ? ' · 在线' : ' · 离线'}`,
                  }))}
                  onChange={setAssigneeUserId}
                />
              </Field>
              <Field className="gap-1.5">
                <FieldLabel htmlFor="create-priority">优先级</FieldLabel>
                <SelectField
                  id="create-priority"
                  value={priority}
                  options={['P0', 'P1', 'P2', 'P3'].map((value) => ({
                    value,
                    label: value,
                  }))}
                  onChange={setPriority}
                />
              </Field>
            </div>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="create-slug">任务标识</FieldLabel>
              <Input
                id="create-slug"
                value={slug}
                placeholder={suggestedSlug || 'board-task-export'}
                onChange={(event) => {
                  setSlug(event.target.value)
                  setManualSlug(true)
                }}
              />
            </Field>
            <Field className="gap-1.5">
              <FieldLabel htmlFor="create-description">描述</FieldLabel>
              <Textarea
                id="create-description"
                rows={3}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            {feedback ? (
              feedback.tone === 'error' ? (
                <FieldError className="text-xs">{feedback.text}</FieldError>
              ) : (
                <p className="text-xs text-muted-foreground" role="status">
                  {feedback.text}
                </p>
              )
            ) : null}
          </DialogBody>
          <DialogFooter className="gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button type="submit" disabled={submitting || !commandState.canSubmit}>
              {submitting ? '创建中…' : '创建并派发'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
