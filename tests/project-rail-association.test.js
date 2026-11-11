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

test('多分支项目按 error、syncing、pending、ready 顺序聚合状态', () => {
  const project = {
    taskSpaces: [
      { id: 'space-ready' },
      { id: 'space-pending' },
      { id: 'space-syncing' },
      { id: 'space-error' },
    ],
  }
  const associations = new Map([
    ['space-ready', association('space-ready', 'ready')],
    ['space-pending', association('space-pending', 'pending')],
    ['space-syncing', association('space-syncing', 'syncing')],
    ['space-error', association('space-error', 'error')],
  ])

  assert.equal(selectProjectAssociation(project, associations)?.liveSyncStatus, 'error')
  associations.delete('space-error')
  assert.equal(selectProjectAssociation(project, associations)?.liveSyncStatus, 'syncing')
  associations.delete('space-syncing')
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
