import {
  ATTENTION_REASON_LABELS,
  FILTER_STAGES,
  dueDateDistance,
  laneForStageIndex,
  taskTagNames,
} from '@/lib/execution-filter.js'

export type Stage = {
  id: string
  label: string
  index: number
  complete: boolean
  optional?: boolean
  source?: string
  evidence?: string
}

export type DependencyRecord = {
  id: string
  title?: string
  projectName?: string
  reason?: string
  createdBy?: string
  createdAt?: string
  durationMs?: number
  resolvedAt?: string
}

export type TaskExecution = {
  dueDate?: string | null
  milestone?: string | null
  attentionReasons?: string[]
  isBlocked?: boolean
  blockedByCount?: number
  blocksCount?: number
  risk?: {
    dorMissingCount?: number
    dodMissingCount?: number
    dorMissing?: string[]
    dodMissing?: string[]
    wipState?: string
  }
  lastActivityAt?: string | null
  blockedBy?: DependencyRecord[]
  blocks?: DependencyRecord[]
  resolvedBlockedBy?: DependencyRecord[]
  resolvedBlocks?: DependencyRecord[]
  isUnblockedReady?: boolean
}

export type BoardTask = {
  taskKey: string
  executionTaskKey?: string
  executionIdentityValid?: boolean
  dirName: string
  relativeDir: string
  repoPath?: string
  title: string
  description?: string
  status?: string
  assignee?: string
  priority?: string
  projectId: string
  projectName: string
  taskSpaceId?: string
  branchName?: string
  taskVersion?: string
  teamId?: string | null
  teamName?: string | null
  archived?: boolean
  derivedStage: string
  manualStage?: string | null
  parentTaskKey?: string | null
  childTaskKeys?: string[]
  groupKey?: string
  groupRole?: 'parent' | 'child'
  groupRelationsValid?: boolean
  groupWarnings?: string[]
  stage?: string
  tags?: string[]
  stages: Stage[]
  execution?: TaskExecution
  history?: { undo?: { available?: boolean; label?: string; disabledReason?: string } }
  [key: string]: unknown
}

export const STAGE_LANES = [
  { id: 'planning', label: '规划', hint: '需求、调研、设计与上下文准备' },
  { id: 'review', label: '待放行', hint: '规划产物已备，尚未开始实现' },
  { id: 'implementation', label: '实现', hint: '正在写代码' },
  { id: 'verification', label: '检查 / 收尾', hint: '验证、规范回写与工作提交' },
] as const

export const TASK_COPY_LABEL = '复制任务名'

export function initials(name?: string) {
  return (name || '?').slice(0, 2).toUpperCase()
}

export function taskProgress(task: BoardTask) {
  const stages = Array.isArray(task.stages) ? task.stages : []
  const required = stages.filter((stage) => !stage.optional)
  const done = required.filter((stage) => stage.complete || stage.source === 'manual').length
  const total = required.length || stages.length
  return { done, total, percent: total ? Math.round((done / total) * 100) : 0 }
}

export function nextStage(task: BoardTask) {
  const stages = Array.isArray(task.stages) ? task.stages : []
  return (
    stages.find((stage) => stage.id === task.derivedStage) ||
    stages.find((stage) => !stage.complete) ||
    stages[stages.length - 1]
  )
}

export function laneForTask(task: BoardTask) {
  const stages = Array.isArray(task.stages) ? task.stages : []
  return laneForStageIndex(
    task,
    stages.findIndex((stage) => stage.id === task.derivedStage),
  )
}

/**
 * 团队查询返回的是扁平行：只有 derivedStage，没有 stages / execution。
 * 视图层（泳道、进度条、下一阶段）都依赖 stages，所以在这里把 13 个阶段
 * 按 derivedStage 位置展开成完整数组。
 */
export function teamRowToBoardTask(row: Record<string, unknown>): BoardTask {
  const derivedStage = String(row.derivedStage ?? '')
  const current = FILTER_STAGES.findIndex((stage) => stage.id === derivedStage)
  const stages: Stage[] = FILTER_STAGES.map((stage, position) => ({
    id: stage.id,
    label: stage.label,
    index: position,
    complete: current === -1 ? false : position < current,
    source: position === current ? 'board' : undefined,
  }))
  return {
    ...row,
    derivedStage,
    archived: Boolean(row.archived),
    taskSpaceId: String(row.taskSpaceId ?? ''),
    branchName: String(row.branchName ?? ''),
    assignee: (row.assignee as string | undefined) ?? (row.assigneeDevId as string | undefined),
    execution: {
      ...(row.execution as TaskExecution | undefined),
      dueDate: (row.dueDate as string | null) ?? null,
      lastActivityAt: (row.lastActivityAt as string | null) ?? null,
      isBlocked: Boolean(row.isBlocked),
      isUnblockedReady: Boolean(row.isUnblockedReady),
    },
    stages,
  } as BoardTask
}

export function isAttention(task: BoardTask) {
  if (task.archived) return false
  return (task.execution?.attentionReasons || []).length > 0 || task.groupRelationsValid === false
}

export function dueLabel(dueDate?: string | null, now = new Date()) {
  if (!dueDate) return '未设截止'
  const distance = dueDateDistance(dueDate, now)
  if (distance == null) return dueDate
  if (distance < 0) return `逾期 ${Math.abs(distance)} 天`
  if (distance === 0) return '今天截止'
  if (distance === 1) return '明天截止'
  if (distance <= 7) return `${distance} 天后截止`
  return dueDate
}

export function formatShortDate(value?: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

export function formatDuration(milliseconds: number) {
  const value = Math.max(0, Number(milliseconds) || 0)
  const days = Math.floor(value / 86_400_000)
  if (days > 0) return `${days} 天`
  const hours = Math.floor(value / 3_600_000)
  if (hours > 0) return `${hours} 小时`
  return `${Math.max(1, Math.floor(value / 60_000))} 分钟`
}

export function attentionReasons(task: BoardTask) {
  return (task.execution?.attentionReasons || []).map((reason) => ({
    id: reason,
    label: (ATTENTION_REASON_LABELS as Record<string, string>)[reason] || reason,
  }))
}

export function taskTags(task: BoardTask) {
  return taskTagNames(task) || []
}

export function groupActiveTasks(tasks: BoardTask[]) {
  const groups = new Map<string, BoardTask[]>()
  tasks.forEach((task) => {
    const key = task.groupKey || task.taskKey
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(task)
  })
  return [...groups.entries()].map(([key, members]) => ({
    key,
    parent: members.find((task) => task.groupRole === 'parent') || members[0],
    members: [...members].sort((a, b) => {
      if (a.groupRole !== b.groupRole) return a.groupRole === 'parent' ? -1 : 1
      return String(a.projectName).localeCompare(String(b.projectName), 'zh-CN')
    }),
  }))
}

export function recommendedTask(tasks: BoardTask[]) {
  const weights: Record<string, number> = {
    identity_conflict: 100,
    overdue: 90,
    blocked: 85,
    due_soon: 75,
    unblocked_ready: 65,
    priority: 60,
    checking: 50,
    implementing: 40,
    stale: 25,
  }
  const priorityWeight: Record<string, number> = { P0: 18, P1: 10, P2: 4, P3: 0 }
  return (
    [...tasks].sort((left, right) => {
      const score = (task: BoardTask) =>
        (task.execution?.attentionReasons || []).reduce(
          (total, reason) => total + (weights[reason] || 0),
          0,
        ) + (priorityWeight[task.priority || 'P2'] || 0)
      return (
        score(right) - score(left) ||
        String(left.execution?.dueDate || '9999-99-99').localeCompare(
          String(right.execution?.dueDate || '9999-99-99'),
        ) ||
        String(left.title).localeCompare(String(right.title), 'zh-CN')
      )
    })[0] || null
  )
}

export function stageSourceLabel(stage: Stage) {
  if (!stage.complete) return stage.optional ? '可选未记录' : '待确认'
  const labels: Record<string, string> = {
    'e2e-report': 'E2E 报告',
    'check-report': '检查报告',
    'implementation-report': '实施报告',
    'prd-acceptance': 'PRD 验收',
    'implement-plan': '实施计划',
    'task-json': 'task.json',
    status: '任务状态',
    file: '任务文件',
    workspace: '工作区',
    archive: '归档目录',
    'archive-gap': '历史推断',
    'group-child': '子任务汇总',
    manual: '人工记录',
    report: '任务报告',
    missing: '无证据',
  }
  return labels[stage.source || ''] || stage.source || '有证据'
}
