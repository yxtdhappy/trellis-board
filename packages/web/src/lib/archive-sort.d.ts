import type { BoardTask } from '@/features/board/task-view'

export function formatArchiveTimestamp(task: unknown): string
export function sortArchivedTasks<T extends Partial<BoardTask>>(tasks: T[]): T[]
