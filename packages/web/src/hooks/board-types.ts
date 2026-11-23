import type { BoardPayload, BoardStatus, TeamQueryPage, TeamRuntime } from '@/api/board'
import type { BoardTask } from '@/features/board/task-view'
import type { OwnershipInboxItem, OwnershipInboxProjectGroup } from '@/lib/ownership-inbox.js'

export type BoardFilters = {
  teamId: string
  projectId: string
  taskSpaceId: string
  scope: 'all' | 'mine'
  search: string
  branch: string
  assignee: string
  priority: string
  stage: string
  blocked: 'any' | 'blocked' | 'unblocked'
  executionView: string
}

export type PublishOperation = {
  id: string | null
  status?: string
  code?: string | null
  error?: string | null
  commandType?: string | null
  taskSpaceId?: string | null
  taskKey?: string | null
  projectId?: string | null
  result?: Record<string, unknown>
  raw?: unknown
}

export type BoardActions = {
  refresh: () => Promise<void>
  saveWip: (limit: number) => Promise<void>
  createTask: (payload: Record<string, unknown>) => Promise<void>
  assign: (payload: Record<string, unknown>) => Promise<void>
  addDependency: (payload: {
    blocked: { taskSpaceId: string; executionTaskKey?: string; taskPath?: string }
    blocker: { taskSpaceId: string; executionTaskKey?: string; taskPath?: string }
    reason: string
    assigneeDecision?: { warningId: string; action: 'continue' | 'takeover' }
  }) => Promise<void>
  removeDependency: (
    id: string,
    assigneeDecision?: { warningId: string; action: 'continue' | 'takeover' },
  ) => Promise<void>
  saveView: (name: string, filter: Record<string, unknown>) => Promise<string>
  deleteView: (id: string) => Promise<void>
  retryOperation: (id?: string) => Promise<void>
  cancelOperation: (id: string) => Promise<void>
  dismissOperation: () => void
  accept: (payload: unknown) => Promise<void>
  reloadAssignments: () => Promise<void>
  repositories: {
    list: () => Promise<{ id?: string; name?: string; path?: string }[]>
    pick: () => Promise<string[]>
    add: (paths: string[]) => Promise<void>
    remove: (id: string) => Promise<void>
  }
}

export type BoardController = {
  board: BoardPayload | null
  tasks: BoardTask[]
  projects: BoardPayload['projects']
  status: BoardStatus | null
  runtime: TeamRuntime | null
  teamPage: TeamQueryPage | null
  teamStatus: Record<string, unknown> | null
  ownershipInbox: OwnershipInboxController
  assignments: unknown[]
  filters: BoardFilters
  setFilters: (patch: Partial<BoardFilters>) => void
  error: string
  loading: boolean
  operation: PublishOperation | null
  operations: PublishOperation[]
  actions: BoardActions
  builtinViews: readonly string[]
}

export type OwnershipInboxController = {
  count: number
  projectGroups: OwnershipInboxProjectGroup[]
  open: boolean
  items: OwnershipInboxItem[]
  total: number
  nextCursor: string | null
  loading: boolean
  loadingMore: boolean
  error: string
  toggle: (projectId: string) => void
  reload: () => Promise<void>
  loadMore: () => Promise<void>
}
