export type TaskType = 'simple' | 'complex' | 'research'

export type TaskTypeDefinition = {
  id: TaskType
  label: string
  description: string
}

export const TASK_TYPES: readonly TaskTypeDefinition[]
export const TASK_TYPE_IDS: readonly TaskType[]
export function isTaskType(value: unknown): value is TaskType
export function taskTypeLabel(value: unknown): string
