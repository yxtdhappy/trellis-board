import test from 'node:test'
import assert from 'node:assert/strict'
import {
  TRELLIS_AGENT_TOOLS,
  getTrellisAgentTool,
  normalizeTrellisAgentTools,
} from '../shared/trellis-agent-tools.js'

test('Trellis Agent 工具目录的 ID、flag 和显示名唯一', () => {
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
  for (const tool of TRELLIS_AGENT_TOOLS) {
    assert.match(tool.flag, /^--[a-z][a-z-]*$/)
    assert.equal(getTrellisAgentTool(tool.id), tool)
  }
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
