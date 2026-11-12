export type FilterStage = { id: string; label: string }

export type BuiltinView = {
  id: string
  name: string
  filter?: {
    priorities?: string[]
    stages?: string[]
    tags?: string[]
    dueWithinDays?: number
    staleDays?: number
    blocked?: 'blocked' | 'unblocked' | 'any'
  }
  matches?: (task: unknown, now?: Date) => boolean
}

export const FILTER_STAGES: FilterStage[]
export const BUILTIN_VIEWS: BuiltinView[]
export const ATTENTION_REASON_LABELS: Record<string, string>
export function laneForStageIndex(task: unknown, current: number): string | null
export function normalizeTagsInput(value: unknown, options?: { rejectEmpty?: boolean }): string[]
export function taskTagNames(task: unknown): string[]
export function branchMatches(branchName: unknown, filter: unknown): boolean
export function localDaySerial(value: unknown): number | null
export function dueDateDistance(due: string, now?: Date): number | null
export function taskMatchesFilter(
  task: unknown,
  filters?: Record<string, unknown>,
  now?: Date,
): boolean
export function taskMatchesView(task: unknown, view: unknown, now?: Date): boolean
export function findView(views: unknown[], id: string): { id: string; name: string } | null
