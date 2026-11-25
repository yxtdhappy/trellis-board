import assert from 'node:assert/strict'
import test from 'node:test'
import {
  branchRebindErrorMessage,
  branchRebindView,
  normalizeBranchInspection,
} from '../src/lib/branch-rebind.js'

test('分支检查结果去重并保留当前检出分支', () => {
  assert.deepEqual(
    normalizeBranchInspection({
      repoPath: 'D:\\work\\repo',
      currentBranch: ' main ',
      branches: ['main', 'feature', 'main', '', 42],
    }),
    {
      repoPath: 'D:\\work\\repo',
      currentBranch: 'main',
      branches: ['main', 'feature'],
    },
  )
  assert.deepEqual(normalizeBranchInspection(null), {
    repoPath: '',
    currentBranch: null,
    branches: [],
  })
})

test('只有当前检出分支可选，绑定同一分支时给出原因', () => {
  const view = branchRebindView(
    { repoPath: '/work/repo', currentBranch: 'main', branches: ['feature', 'main'] },
    'main',
  )
  assert.equal(view.canRebind, false)
  assert.equal(view.targetBranch, null)
  assert.equal(view.reason.includes('已是绑定分支'), true)
  assert.deepEqual(
    view.rows.map((row) => [row.name, row.current, row.bound, row.selectable]),
    [
      ['feature', false, false, false],
      ['main', true, true, true],
    ],
  )

  const switched = branchRebindView(
    { repoPath: '/work/repo', currentBranch: 'feature', branches: ['feature', 'main'] },
    'main',
  )
  assert.equal(switched.canRebind, true)
  assert.equal(switched.targetBranch, 'feature')
  assert.equal(switched.reason, '')
})

test('detached HEAD 与空分支列表给出明确提示', () => {
  const detached = branchRebindView(
    { repoPath: '/work/repo', currentBranch: null, branches: ['main'] },
    'main',
  )
  assert.equal(detached.canRebind, false)
  assert.equal(detached.reason.includes('detached HEAD'), true)

  const empty = branchRebindView(
    { repoPath: '/work/repo', currentBranch: 'main', branches: [] },
    'feature',
  )
  assert.equal(empty.canRebind, false)
  assert.equal(empty.reason.includes('没有可用的本地分支'), true)
})

test('旧客户端缺失命令时给出升级提示，其余错误原样展示', () => {
  assert.equal(
    branchRebindErrorMessage('Command inspect_associated_project_branches not found'),
    '当前客户端版本不支持重新绑定分支，请升级客户端',
  )
  assert.equal(
    branchRebindErrorMessage('not allowed. Permissions associated with this command'),
    '当前客户端版本不支持重新绑定分支，请升级客户端',
  )
  assert.equal(
    branchRebindErrorMessage('无法读取本地分支列表：fatal: not a git repository'),
    '无法读取本地分支列表：fatal: not a git repository',
  )
  assert.equal(branchRebindErrorMessage(''), '读取本地分支失败，请稍后重试')
})
