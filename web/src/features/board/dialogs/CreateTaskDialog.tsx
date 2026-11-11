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
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { fetchTaskSpaceAssignees, type TaskSpaceAssignee } from '@/api/board'
import { normalizeTaskSlug, slugifyTaskTitle, TASK_SLUG_PATTERN } from '@shared/slug.js'
import { createIdempotencyKey } from '@/lib/team-client.js'
import { SelectField } from '../SelectField'

type CreateTaskDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: {
    id: string
    name: string
    taskSpaces?: { id: string; branchName: string }[]
  }[]
  defaultProjectId: string
  onCreate: (payload: Record<string, unknown>) => Promise<void>
}

export function CreateTaskDialog({
  open,
  onOpenChange,
  projects,
  defaultProjectId,
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
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setMessage('')
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
  const taskSpaces = selectedProject?.taskSpaces || []

  useEffect(() => {
    if (!open) return
    if (taskSpaces.some((taskSpace) => taskSpace.id === taskSpaceId)) return
    setTaskSpaceId(taskSpaces[0]?.id || '')
    setAssigneeUserId('')
  }, [open, taskSpaceId, taskSpaces])

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
          setMessage(error instanceof Error ? error.message : '无法读取项目负责人')
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
    setMessage('')
    if (!projectId) {
      setMessage('请选择项目')
      return
    }
    if (!taskSpaceId) {
      setMessage('请选择项目分支任务空间')
      return
    }
    if (!title.trim()) {
      setMessage('请填写任务标题')
      return
    }
    if (!assigneeUserId) {
      setMessage('请选择项目成员作为负责人')
      return
    }
    if (!description.trim()) {
      setMessage('请填写任务描述')
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
      setMessage('创建命令已发送，目标客户端执行并同步成功后会出现在任务列表。')
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
        <form className="flex min-h-0 flex-1 flex-col gap-3" onSubmit={submit}>
          <DialogBody className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-project">项目 / 仓库</Label>
              <SelectField
                id="create-project"
                value={projectId}
                options={projects.map((project) => ({
                  value: project.id,
                  label: project.name,
                }))}
                onChange={setProjectId}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-task-space">共享分支任务空间</Label>
              <SelectField
                id="create-task-space"
                value={taskSpaceId}
                placeholder={taskSpaces.length ? '请选择分支' : '该项目还没有任务空间'}
                options={taskSpaces.map((taskSpace) => ({
                  value: taskSpace.id,
                  label: taskSpace.branchName,
                }))}
                onChange={setTaskSpaceId}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-title">任务标题</Label>
              <Input
                id="create-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={120}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="create-assignee">负责人</Label>
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
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="create-priority">优先级</Label>
                <SelectField
                  id="create-priority"
                  value={priority}
                  options={['P0', 'P1', 'P2', 'P3'].map((value) => ({
                    value,
                    label: value,
                  }))}
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
            {message ? (
              <p className="text-xs text-muted-foreground" role="status">
                {message}
              </p>
            ) : null}
          </DialogBody>
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
