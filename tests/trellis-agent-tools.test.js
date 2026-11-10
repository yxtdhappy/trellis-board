import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TRELLIS_AGENT_TOOLS,
  detectTrellisAgentTools,
  getTrellisAgentTool,
  normalizeTrellisAgentTools,
} from '../shared/trellis-agent-tools.js'

test('Trellis Agent 工具目录的 ID、flag、显示名和探测目录唯一', () => {
  assert.equal(TRELLIS_AGENT_TOOLS.length, 22)
  assert.equal(new Set(TRELLIS_AGENT_TOOLS.map((tool) => tool.id)).size, TRELLIS_AGENT_TOOLS.length)
  assert.equal(
    new Set(TRELLIS_AGENT_TOOLS.map((tool) => tool.flag)).size,
    TRELLIS_AGENT_TOOLS.length,
  )
  assert.equal(
    new Set(TRELLIS_AGENT_TOOLS.map((tool) => tool.label)).size,
    TRELLIS_AGENT_TOOLS.length,
  )
  const presencePaths = TRELLIS_AGENT_TOOLS.flatMap((tool) => tool.presencePaths)
  assert.equal(new Set(presencePaths).size, presencePaths.length)
  for (const tool of TRELLIS_AGENT_TOOLS) {
    assert.match(tool.flag, /^--[a-z][a-z-]*$/)
    assert.ok(tool.presencePaths.length > 0)
    assert.equal(new Set(tool.presencePaths).size, tool.presencePaths.length)
    for (const presencePath of tool.presencePaths) {
      assert.doesNotMatch(presencePath, /^(?:\/|\.{1,2}(?:\/|$)|\.git(?:\/|$))/)
    }
    assert.equal(getTrellisAgentTool(tool.id), tool)
  }
})

test('按当前分支 tree 路径识别已有 Agent，排除共享目录和非法路径', () => {
  assert.deepEqual(
    detectTrellisAgentTools([
      '.codex/hooks/session-start.py',
      '.claude/settings.json',
      '.github/copilot-instructions.md',
      '.snow/agents/trellis.md',
      '.agents/skills/trellis-start/SKILL.md',
    ]),
    ['claude-code', 'codex', 'copilot', 'snow'],
  )
  assert.deepEqual(detectTrellisAgentTools(['.codex']), ['codex'])
  assert.deepEqual(detectTrellisAgentTools(['.codexish/hooks']), [])
  assert.deepEqual(detectTrellisAgentTools(['.codex\\hooks\\session-start.py']), ['codex'])
  assert.deepEqual(detectTrellisAgentTools(['../.codex/config.toml', '/.codex/config.toml']), [])
  assert.deepEqual(detectTrellisAgentTools(null), [])
  assert.deepEqual(detectTrellisAgentTools([42, '']), [])
})

test('Agent 工具输入保序并拒绝空值、未知值和重复值', () => {
  assert.deepEqual(normalizeTrellisAgentTools(['codex', 'opencode']), ['codex', 'opencode'])
  assert.deepEqual(normalizeTrellisAgentTools([' claude-code ']), ['claude-code'])
  assert.throws(() => normalizeTrellisAgentTools([]), /至少选择一项/)
  assert.throws(() => normalizeTrellisAgentTools(null), /必须是数组/)
  assert.throws(() => normalizeTrellisAgentTools([42]), /必须是字符串/)
  assert.throws(() => normalizeTrellisAgentTools(['unknown']), /不支持的 Agent 工具/)
  assert.throws(() => normalizeTrellisAgentTools(['codex', 'codex']), /不能重复选择/)
})
