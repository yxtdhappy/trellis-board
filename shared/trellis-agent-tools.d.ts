export type TrellisAgentTool = {
  readonly id: string
  readonly label: string
  readonly flag: string
}

export const TRELLIS_AGENT_TOOLS: readonly TrellisAgentTool[]

export function getTrellisAgentTool(id: string): TrellisAgentTool | null

export function normalizeTrellisAgentTools(value: unknown): string[]

export function trellisAgentToolFlags(value: unknown): string[]
