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

export function createIdempotencyKey(
  cryptoApi?: {
    randomUUID?: () => string
    getRandomValues?: (array: Uint8Array) => Uint8Array
  } | null,
): string
export function normalizeUser(payload: unknown): RuntimeUser | null
export function normalizeRuntime(payload: unknown): Runtime
export function normalizeProjectMembers(payload: unknown): unknown[]
export function pickProjectTrellisDevId(
  projects: unknown,
  remoteIdentityKey: unknown,
  fallback: string,
): string
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
export function canManageProject(project: unknown, user?: unknown): boolean
export function assignmentVersion(assignment: unknown): string
export function taskVersion(task: unknown): string
export function adminCollection(payload: unknown): unknown[]
