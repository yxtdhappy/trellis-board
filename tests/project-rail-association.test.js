import test from 'node:test'
import assert from 'node:assert/strict'
import { selectProjectAssociation } from '../web/src/lib/project-rail-association.js'

function association(taskSpaceId, liveSyncStatus, overrides = {}) {
  return {
    taskSpaceId,
    status: 'approved',
    liveSyncStatus,
    ...overrides,
  }
}

test('切换项目后，每个项目只读取自身 taskSpace 的同步状态', () => {
  const backend = {
    id: 'mdp-backend-service',
    taskSpaces: [{ id: 'space-backend' }],
  }
  const board = {
    id: 'trellis-board',
    taskSpaces: [{ id: 'space-board' }],
  }
  const associations = new Map([
    ['space-backend', association('space-backend', 'syncing')],
    ['space-board', association('space-board', 'ready')],
  ])

  assert.equal(selectProjectAssociation(board, associations)?.liveSyncStatus, 'ready')
  assert.equal(selectProjectAssociation(backend, associations)?.liveSyncStatus, 'syncing')
  assert.equal(selectProjectAssociation(board, associations)?.liveSyncStatus, 'ready')
})

test('多分支项目按 error、syncing、deferred、pending、ready 顺序聚合状态', () => {
  const project = {
    taskSpaces: [
      { id: 'space-ready' },
      { id: 'space-pending' },
      { id: 'space-deferred' },
      { id: 'space-syncing' },
      { id: 'space-error' },
    ],
  }
  const associations = new Map([
    ['space-ready', association('space-ready', 'ready')],
    ['space-pending', association('space-pending', 'pending')],
    ['space-deferred', association('space-deferred', 'ready', { deferredCount: 2 })],
    ['space-syncing', association('space-syncing', 'syncing', { deferredCount: 1 })],
    ['space-error', association('space-error', 'error', { deferredCount: 1 })],
  ])

  assert.equal(selectProjectAssociation(project, associations)?.liveSyncStatus, 'error')
  associations.delete('space-error')
  assert.equal(selectProjectAssociation(project, associations)?.liveSyncStatus, 'syncing')
  associations.delete('space-syncing')
  assert.equal(selectProjectAssociation(project, associations)?.taskSpaceId, 'space-deferred')
  associations.delete('space-deferred')
  assert.equal(selectProjectAssociation(project, associations)?.liveSyncStatus, 'pending')
  associations.delete('space-pending')
  assert.equal(selectProjectAssociation(project, associations)?.liveSyncStatus, 'ready')
})

test('关联失效优先于正常同步，无本地关联时返回未关联', () => {
  const project = {
    taskSpaces: [{ id: 'space-ready' }, { id: 'space-invalid' }],
  }
  const associations = new Map([
    ['space-ready', association('space-ready', 'ready')],
    ['space-invalid', association('space-invalid', 'pending', { status: 'revoked' })],
  ])

  assert.equal(selectProjectAssociation(project, associations)?.taskSpaceId, 'space-invalid')
  assert.equal(
    selectProjectAssociation({ taskSpaces: [{ id: 'space-missing' }] }, associations),
    undefined,
  )
})

test('当前分支正常时不被他分支的暂停状态覆盖', () => {
  const project = {
    taskSpaces: [{ id: 'space-paused' }, { id: 'space-main' }],
  }
  const associations = new Map([
    [
      'space-paused',
      association('space-paused', 'error', {
        lastErrorCode: 'BRANCH_MISMATCH',
      }),
    ],
    ['space-main', association('space-main', 'ready')],
  ])

  assert.equal(selectProjectAssociation(project, associations)?.taskSpaceId, 'space-paused')
  assert.equal(
    selectProjectAssociation(project, associations, 'space-main')?.liveSyncStatus,
    'ready',
  )
  assert.equal(
    selectProjectAssociation(project, associations, 'space-missing')?.taskSpaceId,
    'space-paused',
  )
})

test('当前分支未关联时不借用其他分支的暂停状态', () => {
  const project = {
    taskSpaces: [{ id: 'space-paused' }, { id: 'space-unassociated' }],
  }
  const associations = new Map([
    [
      'space-paused',
      association('space-paused', 'error', {
        lastErrorCode: 'BRANCH_MISMATCH',
      }),
    ],
  ])

  assert.equal(selectProjectAssociation(project, associations, 'space-unassociated'), undefined)
})
