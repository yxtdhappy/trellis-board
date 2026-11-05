export type FilterStage = { id: string; label: string }

export const FILTER_STAGES: FilterStage[]
export const BUILTIN_VIEWS: { id: string; label: string; hint?: string }[]
export const ATTENTION_REASON_LABELS: Record<string, string>
export function laneForStageIndex(index: number): string
export function normalizeTagsInput(value: unknown): string[]
export function taskTagNames(task: unknown): string[]
export function localDaySerial(value: unknown): number
export function dueDateDistance(due: string, now?: Date): number | null
export function taskMatchesFilter(task: unknown, filters: Record<string, unknown>, now?: Date): boolean
export function taskMatchesView(task: unknown, view: unknown, now?: Date): boolean
export function findView(
  views: unknown[],
  id: string,
): { id: string; label: string; hint?: string; filters?: Record<string, unknown> } | null
