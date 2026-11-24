export type TrellisAgentTool = {
  readonly id: string
  readonly label: string
  readonly flag: string
  readonly presencePaths: readonly string[]
  readonly presenceMode?: 'all'
}

export const TRELLIS_AGENT_TOOLS: readonly TrellisAgentTool[]

export const TRELLIS_SUPPORTED_AGENT_TOOL_IDS: readonly string[]

export const TRELLIS_VISIBLE_AGENT_TOOLS: readonly TrellisAgentTool[]

export function getTrellisAgentTool(id: string): TrellisAgentTool | null

export function detectTrellisAgentTools(paths: unknown): string[]

export function normalizeTrellisAgentTools(value: unknown): string[]

export function trellisAgentToolFlags(value: unknown): string[]
