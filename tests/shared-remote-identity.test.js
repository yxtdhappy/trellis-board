import assert from 'node:assert/strict'
import test from 'node:test'
import {
  gitRemoteIdentityKey,
  normalizeGitRemote,
  validateGitBranchName,
} from '../shared/remote-identity.js'

test('HTTPS、SSH 和 scp 指向同一默认远端时得到同一身份键', () => {
  const values = [
    'https://example.com/acme/repo.git',
    'ssh://example.com/acme/repo.git',
    'git@example.com:acme/repo.git',
  ]
  assert.equal(new Set(values.map((value) => gitRemoteIdentityKey(value))).size, 1)
})

test('非默认端口保留在远端身份中', () => {
  const standard = normalizeGitRemote('https://example.com/acme/repo.git')
  const custom = normalizeGitRemote('ssh://example.com:1022/acme/repo.git')
  assert.equal(standard.port, 0)
  assert.equal(custom.port, 1022)
  assert.notEqual(
    gitRemoteIdentityKey('https://example.com/acme/repo.git'),
    gitRemoteIdentityKey('ssh://example.com:1022/acme/repo.git'),
  )
})

test('拒绝带查询参数和非受控协议的远端', () => {
  assert.throws(() => normalizeGitRemote('https://example.com/repo.git?token=x'), /查询或片段/)
  assert.throws(() => normalizeGitRemote('ftp://example.com/repo.git'), /只允许/)
})

test('分支校验拒绝危险形式', () => {
  assert.equal(validateGitBranchName('feature/task-sync'), 'feature/task-sync')
  for (const value of ['', '-main', 'refs/heads/main', 'main..x', 'main@{1}', 'main.lock']) {
    assert.throws(() => validateGitBranchName(value), /分支名称无效/)
  }
})
