import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeLocalRepoPath,
  sameLocalRepositoryPath,
} from '../src/lib/onboarding-associations.js'

test('同一 Windows 仓库路径忽略大小写、分隔符和末尾斜杠', () => {
  assert.equal(normalizeLocalRepoPath(' D:\\Work\\TrellisBoard\\ '), 'd:/work/trellisboard')
  assert.equal(sameLocalRepositoryPath('D:\\Work\\TrellisBoard', 'd:/work/trellisboard/'), true)
})

test('非 Windows 路径保持大小写语义', () => {
  assert.equal(sameLocalRepositoryPath('/work/repo', '/work/repo/'), true)
  assert.equal(sameLocalRepositoryPath('/work/repo', '/work/Repo'), false)
  assert.equal(sameLocalRepositoryPath('', ''), false)
})
