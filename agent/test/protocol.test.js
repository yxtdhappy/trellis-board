import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_ERROR_CODE,
  AgentError,
  buildCommandResult,
  compareVersions,
  normalizeServerUrl,
  parseHeartbeatResponse,
  parseEnrollResponse,
  safeErrorMessage,
  validateBranchNameSyntax,
  validateCommand,
  validatePairingCode,
} from '../protocol.js'

function hasCode(code) {
  return (error) => error instanceof AgentError && error.code === code
}

test('分支校验拒绝特殊引用和 refspec 字符', () => {
  for (const branch of [
    'HEAD',
    'FETCH_HEAD',
    '@{-1}',
    '-main',
    'refs/heads/main',
    'feature..main',
    'feature:main',
    'feature?name',
    'feature/',
  ]) {
    assert.throws(
      () => validateBranchNameSyntax(branch),
      hasCode(AGENT_ERROR_CODE.BRANCH_INVALID),
      branch,
    )
  }
  assert.equal(validateBranchNameSyntax('feature/team-1'), 'feature/team-1')
})

test('配对码长度和字符集受限，服务地址支持 HTTP 和 HTTPS', () => {
  const code = 'a'.repeat(16)
  assert.equal(validatePairingCode(code), code)
  assert.throws(() => validatePairingCode('short'), hasCode(AGENT_ERROR_CODE.CONFIG_INVALID))
  assert.equal(normalizeServerUrl('http://127.0.0.1:4317'), 'http://127.0.0.1:4317')
  assert.equal(normalizeServerUrl('http://board.example.com'), 'http://board.example.com')
  assert.throws(
    () => normalizeServerUrl('ftp://board.example.com'),
    hasCode(AGENT_ERROR_CODE.CONFIG_INVALID),
  )
  assert.throws(
    () => normalizeServerUrl('https://board.example.com/path'),
    hasCode(AGENT_ERROR_CODE.CONFIG_INVALID),
  )
})

test('协议响应兼容 data 包装并验证命令字段', () => {
  const enroll = parseEnrollResponse({
    data: {
      agentId: 'agent-1',
      credential: 'x'.repeat(32),
      protocolVersion: 3,
      allowLocalGitRemotes: true,
      teams: [{ id: 'team-1', name: '团队一', role: 'member' }],
    },
  })
  assert.equal(enroll.agentId, 'agent-1')
  assert.equal(enroll.protocolVersion, 3)
  assert.equal(enroll.allowLocalGitRemotes, true)
  assert.deepEqual(enroll.teams, [{ id: 'team-1', name: '团队一', role: 'member' }])

  const heartbeat = parseHeartbeatResponse({
    data: {
      protocolVersion: 3,
      minimumAgentVersion: '0.1.0',
      bindings: [
        {
          bindingId: 'binding-1',
          taskSpaceId: 'space-1',
          projectId: 'project-1',
          localRepoKey: 'a'.repeat(64),
          status: 'approved',
          branchName: 'main',
        },
      ],
    },
  })
  assert.equal(heartbeat.compatible, true)
  assert.equal(heartbeat.bindings[0].id, 'binding-1')
  assert.equal(heartbeat.bindings[0].taskSpaceId, 'space-1')
  assert.equal(heartbeat.bindings[0].readOnly, false)

  const command = validateCommand({
    id: 'command-1',
    bindingId: 'binding-1',
    type: 'sync_branch',
    payload: {
      protocolVersion: 3,
      taskSpaceId: 'space-1',
      projectId: 'project-1',
      branchName: 'main',
      reason: 'binding_approved',
    },
  })
  assert.equal(command.type, 'sync_branch')
  assert.throws(
    () =>
      validateCommand({
        id: 'command-1',
        bindingId: 'binding-1',
        type: 'sync_branch',
        payload: { path: 'C:\\secret' },
      }),
    hasCode(AGENT_ERROR_CODE.COMMAND_INVALID),
  )
})

test('版本比较和命令结果保持只读、脱敏边界', () => {
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0)
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1)
  const result = buildCommandResult(
    'failed',
    null,
    new AgentError(AGENT_ERROR_CODE.GIT_FAILED, 'Bearer abc password=secret C:\\Users\\me\\repo'),
  )
  assert.equal(result.error.includes('abc'), false)
  assert.equal(result.error.includes('secret'), false)
  assert.equal(result.error.includes('C:\\'), false)
  assert.equal(safeErrorMessage(new Error('token=abc')), 'token=[REDACTED]')
})
