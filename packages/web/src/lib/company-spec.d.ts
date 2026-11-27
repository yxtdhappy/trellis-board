import type {
  CompanySpecAvailability,
  CompanySpecDetected,
  CompanySpecTemplateOption,
} from './project-inspection.js'

export type CompanySpecState =
  | 'not_applied'
  | 'applied'
  | 'template_mismatch'
  | 'update_source_missing'
  | 'incomplete'

export type CompanySpecOperationRecord = {
  action: string
  template: string
  version: string | null
  appliedAt: string | null
  backupPath: string | null
}

export type CompanySpecStatus = {
  available: boolean
  name: string
  state: CompanySpecState | string
  template: string | null
  version: string | null
  generatedAt: string | null
  registrySource: string | null
  registryTemplate: string | null
  entrypoints: string[]
  warning: string
  templates: CompanySpecTemplateOption[]
  detected: CompanySpecDetected | null
  lastOperation: CompanySpecOperationRecord | null
}

export type CompanySpecPlanFiles = {
  add: number
  update: number
  keep: number
  conflict: number
  delete: number
  keepDeleted: number
}

export type CompanySpecPlan = {
  action: 'apply' | 'update' | 'replace' | string
  template: string
  currentTemplate: string | null
  version: string | null
  generatedAt: string | null
  registrySource: string | null
  markerInvalid: boolean
  requiresBackup: boolean
  entrypoints: string[]
  files: CompanySpecPlanFiles
}

export type CompanySpecApplyResult = {
  applied: boolean
  action: string
  template: string
  version: string | null
  backupPath: string | null
  written: number
  kept: number
  deleted: number
  warning: string
}

export function normalizeCompanySpecStatus(value: unknown): CompanySpecStatus | null
export function normalizeCompanySpecPlan(value: unknown): CompanySpecPlan | null
export function normalizeCompanySpecApplyResult(value: unknown): CompanySpecApplyResult | null
export function companySpecSelectionLabel(
  value: string,
  templates?: ReadonlyArray<Pick<CompanySpecTemplateOption, 'id' | 'label'>>,
): string
export function companySpecStrategyLabel(value: string): string
export function companySpecErrorMessage(error: unknown, fallback: string): string

export type { CompanySpecAvailability }
