export const TRELLIS_AGENT_TOOLS = Object.freeze([
  { id: 'cursor', flag: '--cursor', label: 'Cursor' },
  { id: 'claude-code', flag: '--claude', label: 'Claude Code' },
  { id: 'opencode', flag: '--opencode', label: 'OpenCode' },
  { id: 'codex', flag: '--codex', label: 'Codex' },
  { id: 'kilo', flag: '--kilo', label: 'Kilo' },
  { id: 'kiro', flag: '--kiro', label: 'Kiro' },
  { id: 'gemini', flag: '--gemini', label: 'Gemini' },
  { id: 'antigravity', flag: '--antigravity', label: 'Antigravity' },
  { id: 'devin', flag: '--devin', label: 'Devin' },
  { id: 'qoder', flag: '--qoder', label: 'Qoder' },
  { id: 'codebuddy', flag: '--codebuddy', label: 'CodeBuddy' },
  { id: 'copilot', flag: '--copilot', label: 'GitHub Copilot' },
  { id: 'droid', flag: '--droid', label: 'Droid' },
  { id: 'dsh', flag: '--dsh', label: 'DeepSeek Harness' },
  { id: 'pi', flag: '--pi', label: 'Pi' },
  { id: 'reasonix', flag: '--reasonix', label: 'Reasonix' },
  { id: 'zcode', flag: '--zcode', label: 'ZCode' },
  { id: 'omp', flag: '--omp', label: 'Oh My Pi' },
  { id: 'trae', flag: '--trae', label: 'Trae' },
  { id: 'grok', flag: '--grok', label: 'Grok' },
  { id: 'kimi', flag: '--kimi', label: 'Kimi' },
  { id: 'snow', flag: '--snow', label: 'Snow' },
])

const TOOL_BY_ID = new Map(TRELLIS_AGENT_TOOLS.map((tool) => [tool.id, tool]))

export function getTrellisAgentTool(id) {
  return TOOL_BY_ID.get(String(id || '').trim()) || null
}

export function normalizeTrellisAgentTools(value) {
  if (!Array.isArray(value)) {
    throw new Error('Agent 工具必须是数组')
  }
  if (value.length === 0) {
    throw new Error('Agent 工具必须至少选择一项')
  }
  const seen = new Set()
  return value.map((item) => {
    if (typeof item !== 'string') {
      throw new Error('Agent 工具 ID 必须是字符串')
    }
    const id = item.trim()
    if (seen.has(id)) {
      throw new Error(`Agent 工具不能重复选择: ${id}`)
    }
    if (!TOOL_BY_ID.has(id)) {
      throw new Error(`不支持的 Agent 工具: ${id || '空值'}`)
    }
    seen.add(id)
    return id
  })
}

export function trellisAgentToolFlags(value) {
  return normalizeTrellisAgentTools(value).map((id) => TOOL_BY_ID.get(id).flag)
}
