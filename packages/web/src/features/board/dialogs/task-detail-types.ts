import type { TaskSpace } from '@/api/board'
import type { BoardTask } from '../task-view.ts'

type TaskDetailActions = {
  addDependency: (payload: {
    blocked: { taskSpaceId: string; executionTaskKey?: string; taskPath?: string }
    blocker: { taskSpaceId: string; executionTaskKey?: string; taskPath?: string }
    reason: string
    assigneeDecision?: {
      warningId: string
      action: 'continue' | 'takeover'
    }
  }) => Promise<void>
  removeDependency: (
    id: string,
    assigneeDecision?: { warningId: string; action: 'continue' | 'takeover' },
  ) => Promise<void>
}

export type TaskDetailDialogProps = {
  task: BoardTask | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onAssign: (task: BoardTask, assignee: string) => Promise<void>
  assignees: string[]
  taskSpace?: TaskSpace | null
  onPlanSaved: () => void
  tasks: BoardTask[]
  actions: TaskDetailActions
}
