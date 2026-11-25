import test from 'node:test'
import assert from 'node:assert/strict'
import {
  associationSignature,
  associationOwnershipCounts,
  associationTaskStateCounts,
  countProjectPausedBranches,
  desktopStateTopics,
  detachPendingAssociationView,
  isBranchAssociationPaused,
  pendingUploadView,
  projectListenerView,
  selectProjectAssociation,
} from '../src/lib/project-rail-association.js'

function association(taskSpaceId, liveSyncStatus, overrides = {}) {
  return {
    taskSpaceId,
    status: 'approved',
    liveSyncStatus,
    ...overrides,
  }
}

test('上传中的任务不显示为等待重试，超过阈值后才切换为警告', () => {
  const uploading = pendingUploadView(
    association('space-upload', 'ready', {
      pendingUploadCount: 1,
      pendingUploadTaskDirs: ['.trellis/tasks/11-25-project-rail-upload-status'],
    }),
  )
  assert.equal(uploading.label, '已关联 · 正在上传 1 个任务')
  assert.equal(uploading.dotClassName, 'bg-primary animate-pulse')
  assert.equal(uploading.detail, '11-25-project-rail-upload-status')

  const retrying = pendingUploadView(
    association('space-upload', 'ready', {
      pendingUploadCount: 2,
      pendingUploadTaskDirs: ['.trellis/tasks/a', '.trellis/tasks/b'],
      pendingUploadRetrying: true,
    }),
  )
  assert.equal(retrying.label, '已关联 · 2 个任务等待重试上传')
  assert.equal(retrying.dotClassName, 'bg-warning')
  assert.equal(retrying.detail, 'a、b')
})

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

test('解绑待确认展示服务端不可重试原因', () => {
  const view = detachPendingAssociationView({
    status: 'approved',
    liveSyncStatus: 'error',
    detachPending: true,
    lastErrorCode: 'TASK_SPACE_BINDING_MISMATCH',
    lastError: '本地仓库与当前任务空间关联不一致',
  })
  assert.match(view.label, /服务端解绑待确认/)
  assert.match(view.detail, /本地仓库与当前任务空间关联不一致/)
  assert.doesNotMatch(view.detail, /自动重试/)
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

test('多分支项目只统计已批准且分支不一致的关联', () => {
  const project = {
    taskSpaces: [{ id: 'space-paused' }, { id: 'space-ready' }],
  }
  const associations = new Map([
    [
      'space-paused',
      association('space-paused', 'error', {
        lastErrorCode: 'BRANCH_MISMATCH',
      }),
    ],
    ['space-ready', association('space-ready', 'ready')],
  ])

  assert.equal(isBranchAssociationPaused(associations.get('space-paused')), true)
  assert.equal(isBranchAssociationPaused(associations.get('space-ready')), false)
  assert.equal(countProjectPausedBranches(project, associations), 1)
})

test('两种绑定分支错误码都识别为暂停', () => {
  const project = {
    taskSpaces: [{ id: 'space-local-mismatch' }, { id: 'space-binding-mismatch' }],
  }
  const associations = new Map([
    [
      'space-local-mismatch',
      association('space-local-mismatch', 'error', {
        lastErrorCode: 'BRANCH_MISMATCH',
      }),
    ],
    [
      'space-binding-mismatch',
      association('space-binding-mismatch', 'error', {
        lastErrorCode: 'BINDING_BRANCH_MISMATCH',
      }),
    ],
  ])

  assert.equal(countProjectPausedBranches(project, associations), 2)
})

test('其他项目和未批准关联不计入暂停分支', () => {
  const project = {
    taskSpaces: [{ id: 'space-own' }, { id: 'space-revoked' }],
  }
  const associations = new Map([
    ['space-own', association('space-own', 'ready')],
    [
      'space-revoked',
      association('space-revoked', 'error', {
        status: 'revoked',
        lastErrorCode: 'BRANCH_MISMATCH',
      }),
    ],
    [
      'space-other',
      association('space-other', 'error', {
        lastErrorCode: 'BRANCH_MISMATCH',
      }),
    ],
  ])

  assert.equal(countProjectPausedBranches(project, associations), 0)
})

test('任务级归属暂停和待确认会计入关联优先级', () => {
  const project = {
    taskSpaces: [{ id: 'space-ready' }, { id: 'space-ownership' }],
  }
  const associations = new Map([
    ['space-ready', association('space-ready', 'ready')],
    [
      'space-ownership',
      association('space-ownership', 'ready', {
        ownershipPausedCount: 2,
        ownershipPendingCount: 1,
      }),
    ],
  ])

  assert.deepEqual(associationOwnershipCounts(associations.get('space-ownership')), {
    pausedCount: 2,
    pendingCount: 1,
    totalCount: 3,
  })
  assert.equal(selectProjectAssociation(project, associations)?.taskSpaceId, 'space-ownership')
})

test('上传重试、服务端拒绝和冲突待处理计入关联优先级', () => {
  const project = {
    taskSpaces: [
      { id: 'space-ready' },
      { id: 'space-upload' },
      { id: 'space-rejected' },
      { id: 'space-conflict' },
    ],
  }
  const associations = new Map([
    ['space-ready', association('space-ready', 'ready')],
    [
      'space-upload',
      association('space-upload', 'ready', {
        pendingUploadCount: 1,
        pendingUploadTaskDirs: ['.trellis/tasks/upload'],
      }),
    ],
    [
      'space-rejected',
      association('space-rejected', 'ready', {
        pendingRejectedCount: 1,
        pendingRejectedTaskDirs: ['.trellis/tasks/rejected'],
      }),
    ],
    [
      'space-conflict',
      association('space-conflict', 'ready', {
        conflictPendingCount: 1,
        conflictPendingTaskDirs: ['.trellis/tasks/conflict'],
      }),
    ],
  ])

  assert.deepEqual(associationTaskStateCounts(associations.get('space-upload')), {
    conflictCount: 0,
    rejectedCount: 0,
    pendingUploadCount: 1,
  })
  assert.equal(selectProjectAssociation(project, associations)?.taskSpaceId, 'space-conflict')
  associations.delete('space-conflict')
  assert.equal(selectProjectAssociation(project, associations)?.taskSpaceId, 'space-rejected')
  associations.delete('space-rejected')
  assert.equal(selectProjectAssociation(project, associations)?.taskSpaceId, 'space-upload')
})

test('项目栏按 taskSpace 展示在线、未激活、无关联、旧客户端和停用状态', () => {
  const online = projectListenerView({
    listenerState: 'online',
    onlineListenerCount: 2,
    approvedBindingCount: 3,
  })
  assert.equal(online.counts, '在线监听 2 / 已关联 3')
  assert.equal(online.label, '在线监听')
  assert.equal(online.textClassName, 'text-muted-foreground')

  const inactive = projectListenerView({
    listenerState: 'inactive',
    onlineListenerCount: 0,
    approvedBindingCount: 3,
  })
  assert.equal(inactive.label, '当前未激活，关联保留')
  assert.equal(inactive.textClassName, 'text-warning')

  const unassociated = projectListenerView({
    listenerState: 'unassociated',
    onlineListenerCount: 0,
    approvedBindingCount: 0,
  })
  assert.equal(unassociated.label, '无客户端关联')
  assert.equal(unassociated.textClassName, 'text-destructive')

  const legacy = projectListenerView({
    listenerState: 'unknown_legacy',
    onlineListenerCount: 0,
    approvedBindingCount: 1,
  })
  assert.equal(legacy.label, '旧客户端，监听状态未知')
  assert.equal(legacy.textClassName, 'text-warning')

  const disabled = projectListenerView({
    listenerState: 'disabled',
    onlineListenerCount: 0,
    approvedBindingCount: 0,
  })
  assert.equal(disabled.label, '已停用')
  assert.equal(disabled.textClassName, 'text-muted-foreground')
})

test('没有监听聚合字段时不伪造服务端分支状态', () => {
  assert.equal(projectListenerView({ id: 'standalone-space' }), null)
})

test('桌面状态事件只接受关联和后台主题', () => {
  assert.deepEqual(
    [...desktopStateTopics({ topics: ['sidecar', 'unknown', 'associations'] })],
    ['sidecar', 'associations'],
  )
  assert.equal(desktopStateTopics({ topics: 'associations' }).size, 0)
})

test('关联签名忽略返回顺序但识别内容变化', () => {
  const first = association('space-a', 'ready')
  const second = association('space-b', 'syncing')
  assert.equal(associationSignature([first, second]), associationSignature([second, first]))
  assert.notEqual(
    associationSignature([first, second]),
    associationSignature([first, { ...second, liveSyncStatus: 'ready' }]),
  )
})

test('等待确认任务差异的分支优先于同步中，但仍低于 error', () => {
  const project = { taskSpaces: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }
  const associations = new Map([
    ['a', association('a', 'ready')],
    ['b', association('b', 'syncing')],
    ['c', association('c', 'syncing', { initialReviewPending: true })],
  ])

  assert.equal(selectProjectAssociation(project, associations)?.taskSpaceId, 'c')
  associations.set('a', association('a', 'error'))
  assert.equal(selectProjectAssociation(project, associations)?.taskSpaceId, 'a')
})
