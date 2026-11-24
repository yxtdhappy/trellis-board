export const TRELLIS_AGENT_TOOLS = Object.freeze([
  { id: 'cursor', flag: '--cursor', label: 'Cursor', presencePaths: ['.cursor'] },
  { id: 'claude-code', flag: '--claude', label: 'Claude Code', presencePaths: ['.claude'] },
  { id: 'opencode', flag: '--opencode', label: 'OpenCode', presencePaths: ['.opencode'] },
  { id: 'codex', flag: '--codex', label: 'Codex', presencePaths: ['.codex'] },
  { id: 'kilo', flag: '--kilo', label: 'Kilo', presencePaths: ['.kilocode'] },
  {
    id: 'kiro',
    flag: '--kiro',
    label: 'Kiro',
    presencePaths: ['.kiro/skills', '.kiro/agents', '.kiro/hooks'],
  },
  { id: 'gemini', flag: '--gemini', label: 'Gemini', presencePaths: ['.gemini'] },
  {
    id: 'antigravity',
    flag: '--antigravity',
    label: 'Antigravity',
    presencePaths: ['.agent/workflows', '.agent/skills'],
  },
  {
    id: 'devin',
    flag: '--devin',
    label: 'Devin',
    presencePaths: ['.devin/workflows', '.devin/skills'],
  },
  { id: 'qoder', flag: '--qoder', label: 'Qoder', presencePaths: ['.qoder'] },
  { id: 'codebuddy', flag: '--codebuddy', label: 'CodeBuddy', presencePaths: ['.codebuddy'] },
  {
    id: 'copilot',
    flag: '--copilot',
    label: 'GitHub Copilot',
    presencePaths: ['.github/copilot', '.github/copilot-instructions.md'],
  },
  { id: 'droid', flag: '--droid', label: 'Droid', presencePaths: ['.factory'] },
  { id: 'dsh', flag: '--dsh', label: 'DeepSeek Harness', presencePaths: ['.dsh'] },
  {
    id: 'pi',
    flag: '--pi',
    label: 'Pi',
    presencePaths: ['.pi/extensions/trellis/index.ts', '.pi/settings.json'],
    presenceMode: 'all',
  },
  { id: 'reasonix', flag: '--reasonix', label: 'Reasonix', presencePaths: ['.reasonix'] },
  { id: 'zcode', flag: '--zcode', label: 'ZCode', presencePaths: ['.zcode'] },
  { id: 'omp', flag: '--omp', label: 'Oh My Pi', presencePaths: ['.omp'] },
  { id: 'trae', flag: '--trae', label: 'Trae', presencePaths: ['.trae'] },
  { id: 'grok', flag: '--grok', label: 'Grok', presencePaths: ['.grok'] },
  { id: 'kimi', flag: '--kimi', label: 'Kimi', presencePaths: ['.kimi-code'] },
  {
    id: 'snow',
    flag: '--snow',
    label: 'Snow',
    presencePaths: ['.snow/skills', '.snow/commands', '.snow/agents', '.snow/hooks'],
  },
])

// Product-supported subset. Keep TRELLIS_AGENT_TOOLS complete for detection and
// backward compatibility; only these IDs are offered by the onboarding / agent-only UI.
export const TRELLIS_SUPPORTED_AGENT_TOOL_IDS = Object.freeze([
  'claude-code',
  'codex',
  'opencode',
  'pi',
  'omp',
  'antigravity',
  'dsh',
])

export const TRELLIS_VISIBLE_AGENT_TOOLS = Object.freeze(
  TRELLIS_SUPPORTED_AGENT_TOOL_IDS.flatMap((id) => {
    const tool = TRELLIS_AGENT_TOOLS.find((item) => item.id === id)
    return tool ? [tool] : []
  }),
)

const TOOL_BY_ID = new Map(TRELLIS_AGENT_TOOLS.map((tool) => [tool.id, tool]))

function normalizeTreePath(value) {
  const normalized = String(value || '')
    .trim()
    .replaceAll('\\', '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '')
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.split('/').includes('..') ||
    normalized === '.git' ||
    normalized.startsWith('.git/')
  ) {
    return ''
  }
  return normalized
}

export function detectTrellisAgentTools(paths) {
  if (!Array.isArray(paths)) return []
  const treePaths = [...new Set(paths.map(normalizeTreePath).filter(Boolean))]
  return TRELLIS_AGENT_TOOLS.filter((tool) => {
    const matches = tool.presencePaths.map((presencePath) =>
      treePaths.some(
        (treePath) => treePath === presencePath || treePath.startsWith(`${presencePath}/`),
      ),
    )
    return tool.presenceMode === 'all' ? matches.every(Boolean) : matches.some(Boolean)
  }).map((tool) => tool.id)
}

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
