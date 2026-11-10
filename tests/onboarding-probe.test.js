import test from 'node:test'
import assert from 'node:assert/strict'
import { canProbeBranch } from '../web/src/lib/onboarding-probe.js'

test('分支探测只在分支和远端 URL 都非空时触发', () => {
  assert.equal(canProbeBranch('dev', 'https://github.com/example/repo.git'), true)
  assert.equal(canProbeBranch('dev', '  https://github.com/example/repo.git  '), true)
  assert.equal(canProbeBranch('', 'https://github.com/example/repo.git'), false)
  assert.equal(canProbeBranch('   ', 'https://github.com/example/repo.git'), false)
  assert.equal(canProbeBranch('dev', ''), false)
  assert.equal(canProbeBranch('dev', '   '), false)
  assert.equal(canProbeBranch(null, null), false)
})
