export type OperationVisibilityRecord = {
  id?: string | null
  status?: string | null
  raw?: unknown
}

type ReadStorage = {
  getItem(key: string): string | null
}

type WriteStorage = {
  setItem(key: string, value: string): void
}

export const OPERATION_DISMISS_STORAGE_PREFIX: string
export const ACTIVE_OPERATION_STATUSES: readonly string[]
export const DISMISSIBLE_OPERATION_STATUSES: readonly string[]
export const MAX_VISIBLE_OPERATIONS: number
export const SUCCEEDED_VISIBLE_MS: number

export function isActiveOperation(operation: OperationVisibilityRecord | null | undefined): boolean

export function isDismissibleOperation(
  operation: OperationVisibilityRecord | null | undefined,
): boolean

export function operationDismissStorageKey(
  userKey: string | null | undefined,
  taskSpaceId: string | null | undefined,
): string

export function normalizeDismissedOperationIds(ids: unknown): string[]

export function readDismissedOperationIds(
  storage: ReadStorage | null | undefined,
  key: string,
): string[]

export function writeDismissedOperationIds(
  storage: WriteStorage | null | undefined,
  key: string,
  ids: readonly string[],
): boolean

export function pruneDismissedOperationIds(
  ids: readonly string[],
  operations: readonly OperationVisibilityRecord[],
): string[]

export function visibleOperations<TOperation extends OperationVisibilityRecord>(
  operations: readonly TOperation[],
  options?: { now?: number; dismissedIds?: readonly string[] },
): TOperation[]
