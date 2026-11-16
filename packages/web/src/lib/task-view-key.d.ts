export function taskInstanceKey(task?: {
  taskSpaceId?: string | null
  taskKey?: string | null
}): string

export function taskGroupInstanceKey(task?: {
  taskSpaceId?: string | null
  taskKey?: string | null
  groupKey?: string | null
}): string
