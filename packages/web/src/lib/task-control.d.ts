export function taskCommandState(
  taskSpace: unknown,
  teamMode?: boolean,
): { canSubmit: boolean; reason: string | null }
export type TaskControlTone = 'neutral' | 'info' | 'warning' | 'danger' | 'success'
export type TaskControlView = {
  available: boolean
  state: string
  label: string
  description: string
  tone: TaskControlTone
  contentMaterialized: boolean
}
export function taskControlView(task: unknown): TaskControlView
export function taskContentMaterialized(task: unknown): boolean
export function assignableProjectMembers(project: unknown): unknown[]
export function assignmentActionState(
  task: unknown,
  assignee: unknown,
  assignees?: unknown[],
): { readOnly: boolean; canSubmit: boolean }
export function planEditingState(task: unknown): { readOnly: boolean; canEdit: boolean }
export function isRetryableOperation(operation: unknown): boolean
export function isActiveOperation(operation: unknown): boolean
export function isCompleteOperation(operation: unknown): boolean
export function operationPollDelay(attempt: number): number
