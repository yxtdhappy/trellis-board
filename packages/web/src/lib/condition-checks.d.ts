import type { BoardTask, Stage } from '@/features/board/task-view'

export type ConditionKind = 'start' | 'completion'
export type ConditionMode = 'planning' | 'closeout' | 'archived'

export type ConditionRow = {
  label: string
  stageId: string | null
  stageLabel: string
  evidence: string
  nextAction: string
}

export type ConditionBadge = {
  kind: ConditionKind
  label: string
}

export function conditionMode(task: BoardTask): ConditionMode
export function conditionBadges(task: BoardTask): ConditionBadge[]
export function conditionRows(
  labels: unknown,
  stages: Stage[] | undefined,
  kind: ConditionKind,
): ConditionRow[]
