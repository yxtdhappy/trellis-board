export function canProbeBranch(
  branch: string | null | undefined,
  remoteUrl: string | null | undefined,
): boolean

export function preflightBlockReason(input?: {
  hasTrellis?: boolean
  hasTasks?: boolean
  requiresPushCheck?: boolean
  pushState?: string | null
}): string

export function normalizePushState(value: unknown): {
  state: string
  message: string
  dirtySummary: string
}

export function onboardingErrorMessage(error: unknown, fallback: string): string
