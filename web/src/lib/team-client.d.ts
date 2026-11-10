import type { BoardTask } from '@/features/board/task-view'

export type RuntimeUser = {
  id?: string
  username?: string
  displayName?: string
  role?: string
  developerId?: string
  mustChangePassword?: boolean
}

export type Runtime = {
  team: boolean
  authenticated: boolean
  user: RuntimeUser | null
  teams?: Array<{ id: string; name: string; role?: string | null; status?: string }>
}

export type TaskPage = {
  tasks: BoardTask[]
  total: number
  nextCursor?: string | null
  queryRevision?: string
  queryDay?: string
}

export const TEAM_PAGE_LIMIT: number
export function normalizeUser(payload: unknown): RuntimeUser | null
export function normalizeRuntime(payload: unknown): Runtime
export function normalizeProjectMembers(payload: unknown): unknown[]
export function normalizeTeamProject(payload: unknown): Record<string, unknown>
export function normalizeTeamProjects(payload: unknown): Record<string, unknown>[]
export function normalizeTaskPage(payload: unknown): TaskPage
export function normalizeTeamTaskRow(payload: unknown): Record<string, unknown>
export function normalizeBoardPage(payload: unknown): Record<string, unknown>
export function normalizeAssignments(payload: unknown): unknown[]
export function normalizeOperation(payload: unknown): Record<string, unknown>
export function normalizeTeamStatus(payload: unknown): Record<string, unknown>
export function normalizeAdminUser(payload: unknown): Record<string, unknown>
export function normalizeAgentDevice(payload: unknown): Record<string, unknown>
export function normalizeAgentBinding(payload: unknown): Record<string, unknown>
export function normalizeAuditEvent(payload: unknown): Record<string, unknown>
export function canWriteProject(project: unknown, user: unknown): boolean
export function canManageProject(project: unknown, user: unknown): boolean
export function assignableProjectMembers(project: unknown): unknown[]
export function assignmentActionState(
  task: unknown,
  assignee: unknown,
  assignees?: unknown[],
): { readOnly: boolean; canSubmit: boolean }
export function planEditingState(task: unknown): { readOnly: boolean; canEdit: boolean }
export function buildTaskQuery(
  filters: Record<string, unknown>,
  options?: { limit?: number; cursor?: string | null },
): string
export function archiveAssigneeOptions(
  assignees?: unknown[],
  selected?: unknown,
): Array<{ value: string; label: string }>
export function shouldReloadTasks(status: unknown, previous: unknown): boolean
export function assignmentVersion(assignment: unknown): string
export function taskVersion(task: unknown): string
export function isRetryableOperation(operation: unknown): boolean
export function isCompleteOperation(operation: unknown): boolean
export function operationPollDelay(attempt: number): number
export function safeReturnTo(value: unknown): string
export function redactSensitiveDetail(detail: unknown): string
export function adminCollection(payload: unknown): unknown[]
