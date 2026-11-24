export type WorkType = 'backend' | 'frontend' | 'fullstack' | 'research' | 'docs'

export type WorkTypeOption = {
  id: WorkType
  label: string
  description: string
}

export const WORK_TYPES: readonly WorkTypeOption[]
export const WORK_TYPE_IDS: readonly WorkType[]

export function isWorkType(value: unknown): value is WorkType
export function workTypeLabel(value: unknown): string
