export interface BranchInspection {
  repoPath: string
  currentBranch: string | null
  branches: string[]
}

export interface BranchRebindRow {
  name: string
  current: boolean
  bound: boolean
  selectable: boolean
}

export interface BranchRebindView {
  repoPath: string
  currentBranch: string | null
  boundBranch: string
  rows: BranchRebindRow[]
  canRebind: boolean
  targetBranch: string | null
  reason: string
}

export function normalizeBranchInspection(value: unknown): BranchInspection
export function branchRebindView(value: unknown, boundBranchValue: unknown): BranchRebindView
export function branchRebindErrorMessage(error: unknown): string
