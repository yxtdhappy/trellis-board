import assert from 'node:assert/strict'
import test from 'node:test'

import { normalizeProjectInspection } from '../src/lib/project-inspection.js'

test('项目预检优先规范化 sidecar 的 project 包装', () => {
  const inspection = normalizeProjectInspection({
    ok: true,
    project: {
      root: 'D:\\work\\board',
      repositoryName: 'board',
      remoteUrl: 'https://example.com/board.git',
      branchName: 'main',
      head: 'abc123',
      clean: true,
      hasTrellis: true,
      hasTasks: true,
      hasCommittedTrellis: true,
      requiresInitialization: false,
      existingAgentTools: ['codex', 42, 'pi'],
    },
  })

  assert.deepEqual(inspection, {
    root: 'D:\\work\\board',
    repositoryName: 'board',
    remoteUrl: 'https://example.com/board.git',
    branchName: 'main',
    head: 'abc123',
    clean: true,
    hasTrellis: true,
    hasTasks: true,
    hasCommittedTrellis: true,
    requiresInitialization: false,
    existingAgentTools: ['codex', 'pi'],
  })
})

test('项目预检兼容直接响应并提供稳定默认值', () => {
  assert.deepEqual(
    normalizeProjectInspection({
      root: '/work/board',
      remoteUrl: 'git@example.com:board.git',
      branchName: 'feature',
      existingAgentTools: [],
    }),
    {
      root: '/work/board',
      repositoryName: '本地项目',
      remoteUrl: 'git@example.com:board.git',
      branchName: 'feature',
      head: '',
      clean: false,
      hasTrellis: false,
      hasTasks: false,
      hasCommittedTrellis: false,
      requiresInitialization: false,
      existingAgentTools: [],
    },
  )
})

test('项目预检拒绝缺少仓库身份字段的响应', () => {
  assert.equal(normalizeProjectInspection(null), null)
  assert.equal(normalizeProjectInspection({ root: '/work/board' }), null)
  assert.equal(
    normalizeProjectInspection({
      root: '/work/board',
      remoteUrl: 'git@example.com:board.git',
      branchName: '',
    }),
    null,
  )
})
