import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ConfigStore } from '../config-store.js'
import { AgentTaskSnapshotSync, liveControlLine } from '../task-snapshot-sync.js'
import { AgentApiError, AgentError, AGENT_ERROR_CODE } from '../protocol.js'
import { snapshotSha256 } from '../../shared/task-snapshot.js'

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function serverFile(relativePath, content, overrides = {}) {
  const parts = relativePath.split('/')
  const taskDir = parts[2] === 'archive' ? parts.slice(0, 6).join('/') : parts.slice(0, 3).join('/')
  return {
    path: relativePath,
    taskDir,
    content,
    sha256: snapshotSha256(content),
    deleted: false,
    ...overrides,
  }
}

function applyServerFiles(current, files) {
  const byPath = new Map((current || []).map((file) => [file.path, file]))
  for (const file of files || []) {
    if (file.deleted) byPath.delete(file.path)
    else byPath.set(file.path, serverFile(file.path, file.content))
  }
  return [...byPath.values()]
}

async function setup(localTasks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-snapshot-sync-'))
  const repoPath = path.join(root, 'repo')
  fs.mkdirSync(path.join(repoPath, '.trellis', 'tasks'), { recursive: true })
  for (const [taskDir, files] of Object.entries(localTasks || {})) {
    for (const [name, content] of Object.entries(files)) {
      write(path.join(repoPath, ...taskDir.split('/'), name), content)
    }
  }
  const store = new ConfigStore(root, { secureDirectory: false })
  const config = {
    schemaVersion: 2,
    revision: 'a'.repeat(32),
    serverUrl: 'http://127.0.0.1:4317',
    caFile: null,
    agentId: 'agent-1',
    deviceName: '测试设备',
    username: 'alice',
    teamId: null,
    teams: [],
    protocolVersion: 3,
    agentVersion: '0.1.0',
    pairedAt: new Date().toISOString(),
    bindings: [
      {
        localId: 'local-1',
        serverBindingId: 'binding-1',
        taskSpaceId: 'space-1',
        projectId: 'project-1',
        teamId: 'team-1',
        repoPath,
        branchName: 'main',
        remoteIdentityKey: 'b'.repeat(64),
        localRepoKey: 'c'.repeat(64),
        displayName: '测试项目',
        createdAt: new Date().toISOString(),
        allowFileRemote: false,
        readOnly: false,
        syncStatus: 'approved',
        initialSyncMode: 'safe',
        initialSyncCompleted: true,
        initialReviewPending: false,
        liveSyncStatus: 'pending',
        liveSyncError: null,
        lastSyncedAt: null,
        lastHead: null,
        lastError: null,
        lastErrorCode: null,
      },
    ],
  }
  await store.saveConfig(config)
  return { root, repoPath, store, config }
}

function createSync(
  context,
  api,
  controls = [],
  assertBranch = async ({ branchName }) => ({ branchName }),
) {
  const sync = new AgentTaskSnapshotSync({
    store: context.store,
    loadContext: async () => ({ config: context.config, api }),
    logger: { warn() {} },
    emitControl: (event) => controls.push(event),
    assertBranch,
  })
  sync.updateBindings(context.config.bindings)
  return sync
}

test('liveControlLine 使用顶层 control 包装，普通 stdout JSON 不会触发控制事件', () => {
  const parseControl = (line) => JSON.parse(line).control
  const events = [
    {
      type: 'initial_sync_review',
      taskSpaceId: 'space-1',
      revision: 4,
      differences: [{ type: 'content-conflict', taskId: 'task-1' }],
    },
    {
      type: 'task_file_conflict',
      taskSpaceId: 'space-1',
      conflict: { conflictId: 'conflict-1', message: '任务文件已被修改' },
    },
    {
      type: 'task_sync_error',
      taskSpaceId: 'space-1',
      message: '同步暂时失败',
    },
  ]
  for (const event of events) {
    const envelope = JSON.parse(liveControlLine(event))
    assert.deepEqual(envelope.control, event)
    assert.equal(envelope.type, undefined)
  }
  assert.equal(
    parseControl(
      `${JSON.stringify({
        type: 'trellis-control',
        taskSpaceId: 'space-1',
      })}\n`,
    ),
    undefined,
  )
  assert.equal(parseControl(`${JSON.stringify({ ok: true, protocolVersion: 3 })}\n`), undefined)
})

test('错分支时拉取和上传都失败关闭，不调用 API 也不推进 cursor', async () => {
  const taskDir = '.trellis/tasks/01-branch-guard'
  const context = await setup({
    [taskDir]: {
      'task.json': `${JSON.stringify({ id: 'branch-guard', title: '分支门禁' })}\n`,
    },
  })
  try {
    const calls = { fetch: 0, upload: 0, cursor: 0 }
    const controls = []
    const api = {
      async fetchTaskSpaceSnapshot() {
        calls.fetch += 1
        return { revision: 0, files: [] }
      },
      async uploadTaskSpaceChanges() {
        calls.upload += 1
        return { status: 200, revision: 1 }
      },
      async writeTaskSpaceCursor() {
        calls.cursor += 1
      },
    }
    const sync = createSync(context, api, controls, async () => {
      throw new AgentError(
        AGENT_ERROR_CODE.BRANCH_MISMATCH,
        '本地当前分支为 feature/x，绑定分支为 main',
      )
    })
    await sync.pullTaskSpace('space-1')
    await sync.syncTaskDirectories('space-1', [taskDir])
    assert.deepEqual(calls, { fetch: 0, upload: 0, cursor: 0 })
    assert.equal(fs.existsSync(context.store.paths.liveCursorsFile), false)
    assert.ok(controls.some((event) => event.type === 'task_sync_error'))
    const binding = (await context.store.readConfig()).bindings[0]
    assert.equal(binding.lastErrorCode, AGENT_ERROR_CODE.BRANCH_MISMATCH)
    assert.equal(binding.liveSyncStatus, 'error')
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('错分支时 pending retry 和 deferred sync 不会上传，切回后清除暂停状态', async () => {
  const taskDir = '.trellis/tasks/01-branch-retry'
  const taskContent = `${JSON.stringify({ id: 'branch-retry', title: '重试门禁' })}\n`
  const context = await setup({
    [taskDir]: {
      'task.json': taskContent,
    },
  })
  try {
    let currentBranch = 'feature/x'
    let uploads = 0
    const api = {
      async uploadTaskSpaceChanges() {
        uploads += 1
        return { status: 200, revision: 1 }
      },
      async writeTaskSpaceCursor() {},
    }
    const sync = createSync(context, api, [], async ({ branchName }) => {
      if (currentBranch !== branchName) {
        throw new AgentError(
          AGENT_ERROR_CODE.BRANCH_MISMATCH,
          `本地当前分支为 ${currentBranch}，绑定分支为 ${branchName}`,
        )
      }
      return { branchName }
    })
    await sync._writeCursor('space-1', {
      revision: 2,
      sequence: 3,
      pending: {
        batchId: 'pending-branch',
        clientSequence: 3,
        files: [
          {
            path: `${taskDir}/task.json`,
            content: taskContent,
            sha256: snapshotSha256(taskContent),
            baseSha256: null,
          },
        ],
      },
      deferred: {
        [taskDir]: { [`${taskDir}/task.json`]: snapshotSha256(taskContent) },
      },
    })
    await sync.pullTaskSpace('space-1')
    await assert.rejects(
      () => sync.syncDeferredTasks('space-1'),
      (error) => error.code === AGENT_ERROR_CODE.BRANCH_MISMATCH,
    )
    assert.equal(uploads, 0)
    const cursor = await sync._readCursor('space-1')
    assert.equal(cursor.pending.batchId, 'pending-branch')
    assert.ok(cursor.deferred[taskDir])

    currentBranch = 'main'
    await sync._assertBindingBranch(context.config.bindings[0])
    const binding = (await context.store.readConfig()).bindings[0]
    assert.equal(binding.lastErrorCode, null)
    assert.equal(binding.liveSyncStatus, 'ready')
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('历史双绑定只启用真实分支匹配的 binding，另一个保持暂停', async () => {
  const context = await setup()
  try {
    const duplicate = {
      ...context.config.bindings[0],
      localId: 'local-2',
      serverBindingId: 'binding-2',
      taskSpaceId: 'space-2',
      branchName: 'feature/x',
    }
    const legacy = {
      ...context.config,
      bindings: [context.config.bindings[0], duplicate],
    }
    fs.writeFileSync(context.store.paths.configFile, `${JSON.stringify(legacy, null, 2)}\n`)
    const loaded = await context.store.readConfig({ allowMissing: false })
    const sync = new AgentTaskSnapshotSync({
      store: context.store,
      loadContext: async () => ({ config: loaded, api: {} }),
      logger: { warn() {} },
      assertBranch: async ({ branchName }) => {
        if (branchName === 'main') return { branchName }
        throw new AgentError(
          AGENT_ERROR_CODE.BRANCH_MISMATCH,
          '本地当前分支为 main，绑定分支为 feature/x',
        )
      },
    })
    await sync.updateBindings(loaded.bindings)
    assert.deepEqual([...sync.bindings.keys()], ['space-1'])
    const bindings = (await context.store.readConfig()).bindings
    assert.equal(
      bindings.find((binding) => binding.taskSpaceId === 'space-2').lastErrorCode,
      AGENT_ERROR_CODE.BRANCH_MISMATCH,
    )
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('sidecar 启动恢复 binding 时保留已有实时状态，只由新增项目保持 syncing', async () => {
  const binding = (taskSpaceId, liveSyncStatus) => ({
    taskSpaceId,
    projectId: taskSpaceId,
    displayName: taskSpaceId,
    repoPath: path.join(os.tmpdir(), `missing-${taskSpaceId}`),
    localRepoKey: taskSpaceId,
    syncStatus: 'approved',
    initialSyncCompleted: true,
    liveSyncStatus,
  })
  const bindings = [
    binding('project-a', 'ready'),
    binding('project-b', 'ready'),
    binding('project-c', 'ready'),
    binding('project-d', 'ready'),
    binding('project-new', 'syncing'),
  ]
  const expectedStatuses = bindings.map(({ taskSpaceId, liveSyncStatus }) => ({
    taskSpaceId,
    liveSyncStatus,
  }))
  const pulled = []
  const sync = new AgentTaskSnapshotSync({
    store: {},
    loadContext: async () => ({ config: { bindings }, api: {} }),
    logger: { warn() {} },
  })
  sync.pullTaskSpace = async (taskSpaceId) => {
    pulled.push(taskSpaceId)
    return null
  }

  try {
    await sync.start()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(
      [...sync.bindings.values()].map(({ taskSpaceId, liveSyncStatus }) => ({
        taskSpaceId,
        liveSyncStatus,
      })),
      expectedStatuses,
    )
    assert.deepEqual(pulled.sort(), bindings.map(({ taskSpaceId }) => taskSpaceId).sort())
  } finally {
    sync.stop()
  }
})

test('safe 首次接入只下载服务端独有任务，不上传本地独有内容', async () => {
  const localTaskJson = `${JSON.stringify({ id: 'local-task', title: '本地任务' })}\n`
  const context = await setup({
    '.trellis/tasks/11-10-local': {
      'task.json': localTaskJson,
      'prd.md': '# 本地任务\n',
    },
  })
  try {
    context.config.bindings[0].initialSyncMode = 'safe'
    context.config.bindings[0].initialSyncCompleted = false
    context.config.bindings[0].initialReviewPending = false
    await context.store.saveConfig(context.config)
    const serverTaskJson = `${JSON.stringify({ id: 'server-task', title: '服务端任务' })}\n`
    const uploads = []
    const cursors = []
    const api = {
      async fetchTaskSpaceSnapshot(taskSpaceId, input) {
        assert.equal(taskSpaceId, 'space-1')
        assert.equal(input.afterRevision, 0)
        return {
          taskSpaceId,
          revision: 1,
          files: [
            serverFile('.trellis/tasks/11-10-server/task.json', serverTaskJson),
            serverFile('.trellis/tasks/11-10-server/prd.md', '# 服务端任务\n'),
          ],
        }
      },
      async uploadTaskSpaceChanges(taskSpaceId, input) {
        uploads.push({ taskSpaceId, input })
        return { status: 200, revision: 2, taskSpaceId }
      },
      async writeTaskSpaceCursor(taskSpaceId, input) {
        cursors.push({ taskSpaceId, input })
        return { taskSpaceId, revision: input.revision }
      },
    }
    const sync = createSync(context, api)
    const result = await sync.pullTaskSpace('space-1')
    assert.equal(result.revision, 1)
    assert.equal(
      fs.readFileSync(
        path.join(context.repoPath, '.trellis', 'tasks', '11-10-server', 'task.json'),
        'utf8',
      ),
      serverTaskJson,
    )
    assert.equal(uploads.length, 0)
    assert.equal(
      fs.readFileSync(
        path.join(context.repoPath, '.trellis', 'tasks', '11-10-local', 'task.json'),
        'utf8',
      ),
      localTaskJson,
    )
    assert.equal(cursors.at(-1).input.revision, 1)
    const state = JSON.parse(fs.readFileSync(context.store.paths.liveCursorsFile, 'utf8'))
    assert.equal(state.taskSpaces['space-1'].revision, 1)
    const binding = (await context.store.readConfig()).bindings[0]
    assert.equal(binding.initialSyncCompleted, true)
    assert.equal(binding.initialReviewPending, false)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('离线期间服务端更新后仍使用上次同步摘要作为 CAS 基线', async () => {
  const taskDir = '.trellis/tasks/01-offline'
  const syncedJson = `${JSON.stringify({ id: 'offline-task', title: '共同版本' })}\n`
  const localEdit = `${JSON.stringify({ id: 'offline-task', title: '本地新版本' })}\n`
  const serverEdit = `${JSON.stringify({ id: 'offline-task', title: '服务端新版本' })}\n`
  const context = await setup({
    [taskDir]: {
      'task.json': syncedJson,
    },
  })
  try {
    context.config.bindings[0].initialSyncMode = 'review'
    context.config.bindings[0].initialSyncCompleted = false
    context.config.bindings[0].initialReviewPending = true
    await context.store.saveConfig(context.config)

    let phase = 'initial'
    let uploadInput = null
    const api = {
      async fetchTaskSpaceSnapshot() {
        return {
          revision: 1,
          files: [serverFile(`${taskDir}/task.json`, syncedJson)],
        }
      },
      async fetchTaskDirectory() {
        return {
          files: [serverFile(`${taskDir}/task.json`, serverEdit)],
        }
      },
      async uploadTaskSpaceChanges(taskSpaceId, input) {
        assert.equal(phase, 'edit')
        uploadInput = { taskSpaceId, input }
        return {
          status: 409,
          code: 'TASK_FILE_CONFLICT',
          conflictId: 'offline-conflict',
          message: '任务已被其他成员修改',
          details: {
            taskId: 'offline-task',
            files: [
              {
                path: `${taskDir}/task.json`,
                baseSha256: input.files[0].baseSha256,
                currentSha256: snapshotSha256(serverEdit),
              },
            ],
          },
        }
      },
      async writeTaskSpaceCursor() {},
    }
    const sync = createSync(context, api)
    await sync.pullTaskSpace('space-1')
    const initialCursor = await sync._readCursor('space-1')
    assert.equal(initialCursor.baselines[`${taskDir}/task.json`], snapshotSha256(syncedJson))

    fs.writeFileSync(path.join(context.repoPath, ...taskDir.split('/'), 'task.json'), localEdit)
    phase = 'edit'
    await sync._uploadDirty('space-1', new Set([`${taskDir}/task.json`]))
    assert.equal(uploadInput.input.files.length, 1)
    assert.equal(uploadInput.input.files[0].baseSha256, snapshotSha256(syncedJson))
    assert.notEqual(uploadInput.input.files[0].baseSha256, snapshotSha256(serverEdit))
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('safe 跳过的本地独有任务只在用户再次修改后上传', async () => {
  const taskDir = '.trellis/tasks/01-deferred'
  const originalJson = `${JSON.stringify({ id: 'deferred-task', title: '原始版本' })}\n`
  const editedJson = `${JSON.stringify({ id: 'deferred-task', title: '用户修改版本' })}\n`
  const context = await setup({
    [taskDir]: {
      'task.json': originalJson,
    },
  })
  try {
    context.config.bindings[0].initialSyncMode = 'safe'
    context.config.bindings[0].initialSyncCompleted = false
    context.config.bindings[0].initialReviewPending = false
    await context.store.saveConfig(context.config)
    let revision = 0
    const uploads = []
    const api = {
      async fetchTaskSpaceSnapshot(taskSpaceId, input) {
        return {
          taskSpaceId,
          revision,
          files: input.afterRevision >= revision ? [] : [],
        }
      },
      async fetchTaskDirectory() {
        return { files: [] }
      },
      async uploadTaskSpaceChanges(taskSpaceId, input) {
        uploads.push({ taskSpaceId, input })
        revision += 1
        return { revision, taskSpaceId }
      },
      async writeTaskSpaceCursor() {},
    }
    const sync = createSync(context, api)
    await sync.pullTaskSpace('space-1')
    const deferredCursor = await sync._readCursor('space-1')
    assert.ok(deferredCursor.deferred[taskDir])
    const localState = await sync._localSyncState(sync._binding('space-1'), deferredCursor)
    assert.deepEqual(localState.dirtyTaskDirs, [])
    await sync.pullTaskSpace('space-1')
    assert.equal(uploads.length, 0)

    fs.writeFileSync(path.join(context.repoPath, ...taskDir.split('/'), 'task.json'), editedJson)
    await sync.pullTaskSpace('space-1')
    assert.equal(uploads.length, 1)
    assert.equal(uploads[0].input.files[0].baseSha256, null)
    const finalCursor = await sync._readCursor('space-1')
    assert.equal(finalCursor.deferred[taskDir], undefined)
    assert.equal(finalCursor.baselines[`${taskDir}/task.json`], snapshotSha256(editedJson))
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('显式补同步会上传全部 deferred 任务并清理游标', async () => {
  const taskDir = '.trellis/tasks/01-deferred'
  const secondTaskDir = '.trellis/tasks/02-deferred'
  const taskJson = `${JSON.stringify({ id: 'deferred-task', title: '待补传任务' })}\n`
  const secondTaskJson = `${JSON.stringify({ id: 'second-deferred-task', title: '第二个任务' })}\n`
  const context = await setup({
    [taskDir]: {
      'task.json': taskJson,
    },
    [secondTaskDir]: {
      'task.json': secondTaskJson,
    },
  })
  try {
    context.config.bindings[0].initialSyncCompleted = false
    context.config.bindings[0].initialReviewPending = false
    await context.store.saveConfig(context.config)
    let revision = 0
    const uploads = []
    const api = {
      async fetchTaskSpaceSnapshot(taskSpaceId) {
        return { taskSpaceId, revision, files: [] }
      },
      async fetchTaskDirectory() {
        return { files: [] }
      },
      async uploadTaskSpaceChanges(taskSpaceId, input) {
        uploads.push({ taskSpaceId, input })
        revision += 1
        return { revision, taskSpaceId }
      },
      async writeTaskSpaceCursor() {},
    }
    const sync = createSync(context, api)
    await sync.pullTaskSpace('space-1')
    assert.ok((await sync._readCursor('space-1')).deferred[taskDir])

    const result = await sync.syncDeferredTasks('space-1')
    assert.deepEqual(
      {
        syncedCount: result.syncedCount,
        remainingCount: result.remainingCount,
        conflict: result.conflict,
      },
      { syncedCount: 2, remainingCount: 0, conflict: false },
    )
    assert.equal(uploads.length, 2)
    assert.ok(uploads.every((upload) => upload.input.files[0].baseSha256 === null))
    const cursor = await sync._readCursor('space-1')
    assert.equal(cursor.deferred[taskDir], undefined)
    assert.equal(cursor.deferred[secondTaskDir], undefined)
    assert.equal(cursor.baselines[`${taskDir}/task.json`], snapshotSha256(taskJson))
    assert.equal(cursor.baselines[`${secondTaskDir}/task.json`], snapshotSha256(secondTaskJson))
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('显式补同步遇到冲突时停止覆盖并进入现有冲突确认链路', async () => {
  const taskDir = '.trellis/tasks/01-deferred'
  const localJson = `${JSON.stringify({ id: 'deferred-task', title: '本地版本' })}\n`
  const serverJson = `${JSON.stringify({ id: 'deferred-task', title: '服务端版本' })}\n`
  const context = await setup({
    [taskDir]: {
      'task.json': localJson,
    },
  })
  try {
    context.config.bindings[0].initialSyncCompleted = false
    context.config.bindings[0].initialReviewPending = false
    await context.store.saveConfig(context.config)
    const controls = []
    const api = {
      async fetchTaskSpaceSnapshot(taskSpaceId) {
        return { taskSpaceId, revision: 0, files: [] }
      },
      async fetchTaskDirectory() {
        return { files: [serverFile(`${taskDir}/task.json`, serverJson)] }
      },
      async uploadTaskSpaceChanges() {
        throw new AgentApiError(AGENT_ERROR_CODE.HTTP_ERROR, '任务已被其他成员修改', {
          status: 409,
          serverCode: 'TASK_FILE_CONFLICT',
          conflictId: 'deferred-conflict',
          details: { taskId: 'deferred-task', files: [] },
        })
      },
      async writeTaskSpaceCursor() {},
    }
    const sync = createSync(context, api, controls)
    await sync.pullTaskSpace('space-1')

    const result = await sync.syncDeferredTasks('space-1')
    assert.equal(result.conflict, true)
    assert.equal(result.syncedCount, 0)
    assert.equal(result.conflictId, 'deferred-conflict')
    assert.equal(
      fs.readFileSync(path.join(context.repoPath, ...taskDir.split('/'), 'task.json'), 'utf8'),
      localJson,
    )
    assert.equal(controls.at(-1).type, 'task_file_conflict')
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('显式补同步网络失败时向调用方抛出异常并保留 deferred 状态', async () => {
  const taskDir = '.trellis/tasks/01-deferred'
  const taskJson = `${JSON.stringify({ id: 'deferred-task', title: '待补传任务' })}\n`
  const context = await setup({
    [taskDir]: {
      'task.json': taskJson,
    },
  })
  try {
    context.config.bindings[0].initialSyncCompleted = false
    await context.store.saveConfig(context.config)
    let failUpload = false
    const api = {
      async fetchTaskSpaceSnapshot(taskSpaceId) {
        return { taskSpaceId, revision: 0, files: [] }
      },
      async fetchTaskDirectory() {
        return { files: [] }
      },
      async uploadTaskSpaceChanges() {
        if (failUpload) {
          throw new AgentApiError(AGENT_ERROR_CODE.NETWORK_ERROR, '无法连接 Agent 服务')
        }
        return { revision: 1 }
      },
      async writeTaskSpaceCursor() {},
    }
    const sync = createSync(context, api)
    await sync.pullTaskSpace('space-1')
    assert.ok((await sync._readCursor('space-1')).deferred[taskDir])

    failUpload = true
    await assert.rejects(() => sync.syncDeferredTasks('space-1'), /无法连接 Agent 服务/)
    assert.ok((await sync._readCursor('space-1')).deferred[taskDir])
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('只读关联拒绝显式补同步', async () => {
  const context = await setup()
  try {
    context.config.bindings[0].readOnly = true
    await context.store.saveConfig(context.config)
    const sync = createSync(context, {})
    await assert.rejects(() => sync.syncDeferredTasks('space-1'), /只读关联不能上传本地任务/)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('服务端修改延后处理的任务时重新要求确认而不是覆盖本地', async () => {
  const taskDir = '.trellis/tasks/01-deferred'
  const localJson = `${JSON.stringify({ id: 'deferred-task', title: '本地版本' })}\n`
  const serverJson = `${JSON.stringify({ id: 'deferred-task', title: '服务端版本' })}\n`
  const context = await setup({
    [taskDir]: {
      'task.json': localJson,
    },
  })
  try {
    context.config.bindings[0].initialSyncMode = 'safe'
    context.config.bindings[0].initialSyncCompleted = false
    context.config.bindings[0].initialReviewPending = false
    await context.store.saveConfig(context.config)
    let revision = 0
    let serverFiles = []
    const controls = []
    const api = {
      async fetchTaskSpaceSnapshot(taskSpaceId) {
        return { taskSpaceId, revision, files: serverFiles }
      },
      async fetchTaskDirectory() {
        return { files: serverFiles }
      },
      async uploadTaskSpaceChanges() {
        throw new Error('延后任务没有再次修改时不应上传')
      },
      async writeTaskSpaceCursor() {},
    }
    const sync = createSync(context, api, controls)
    await sync.pullTaskSpace('space-1')

    revision = 1
    serverFiles = [serverFile(`${taskDir}/task.json`, serverJson)]
    const result = await sync.pullTaskSpace('space-1')
    assert.equal(result.pendingReview, true)
    assert.equal(
      fs.readFileSync(path.join(context.repoPath, ...taskDir.split('/'), 'task.json'), 'utf8'),
      localJson,
    )
    assert.equal(controls.at(-1).type, 'initial_sync_review')
    assert.ok(controls.at(-1).differences.some((item) => item.type === 'content-conflict'))
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('bootstrap 首次接入把空服务端任务空间初始化为本地任务快照', async () => {
  const localTaskJson = `${JSON.stringify({ id: 'local-task', title: '本地任务' })}\n`
  const taskDir = '.trellis/tasks/01-local'
  const context = await setup({
    [taskDir]: {
      'task.json': localTaskJson,
    },
  })
  try {
    context.config.bindings[0].initialSyncMode = 'bootstrap'
    context.config.bindings[0].initialSyncCompleted = false
    context.config.bindings[0].initialReviewPending = false
    await context.store.saveConfig(context.config)
    const uploads = []
    const cursors = []
    const controls = []
    let revision = 0
    let serverFiles = []
    let snapshotCalls = 0
    const api = {
      async fetchTaskSpaceSnapshot() {
        snapshotCalls += 1
        return { revision, files: serverFiles }
      },
      async fetchTaskDirectory() {
        return { files: [] }
      },
      async uploadTaskSpaceChanges(taskSpaceId, input) {
        uploads.push({ taskSpaceId, input })
        revision += 1
        serverFiles = applyServerFiles(serverFiles, input.files)
        return { revision, taskSpaceId }
      },
      async writeTaskSpaceCursor(taskSpaceId, input) {
        cursors.push({ taskSpaceId, input })
      },
    }
    const sync = createSync(context, api, controls)
    const result = await sync.pullTaskSpace('space-1')
    assert.equal(result.pendingReview, false)
    assert.equal(controls.length, 0)
    assert.equal(uploads.length, 1)
    assert.equal(uploads[0].input.files.length, 1)
    assert.equal(cursors.at(-1).input.revision, 1)
    assert.equal(snapshotCalls, 2)
    const binding = (await context.store.readConfig()).bindings[0]
    assert.equal(binding.initialSyncMode, 'bootstrap')
    assert.equal(binding.initialSyncCompleted, true)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('bootstrap 遇到限流后复用批次重试，并按安全间隔继续上传', async () => {
  const taskDirs = Array.from({ length: 6 }, (_, index) => `.trellis/tasks/01-rate-${index + 1}`)
  const context = await setup(
    Object.fromEntries(
      taskDirs.map((taskDir, index) => [
        taskDir,
        {
          'task.json': `${JSON.stringify({ id: `rate-task-${index + 1}`, title: '限流测试' })}\n`,
        },
      ]),
    ),
  )
  try {
    context.config.bindings[0].initialSyncMode = 'bootstrap'
    context.config.bindings[0].initialSyncCompleted = false
    context.config.bindings[0].initialReviewPending = false
    await context.store.saveConfig(context.config)
    const attempts = []
    const successTimes = []
    let revision = 0
    let serverFiles = []
    let limited = false
    const controls = []
    const api = {
      async fetchTaskSpaceSnapshot() {
        return { revision, files: serverFiles }
      },
      async fetchTaskDirectory(taskSpaceId, taskDir) {
        return {
          files: serverFiles.filter((file) => file.taskDir === taskDir),
        }
      },
      async uploadTaskSpaceChanges(taskSpaceId, input) {
        attempts.push({ taskSpaceId, input, at: Date.now() })
        if (!limited) {
          limited = true
          throw new AgentApiError(AGENT_ERROR_CODE.HTTP_ERROR, '同步批次过于频繁，请稍后重试', {
            status: 429,
            serverCode: 'RATE_LIMITED',
            retryable: true,
          })
        }
        revision += 1
        successTimes.push(Date.now())
        serverFiles = applyServerFiles(serverFiles, input.files)
        return { revision, taskSpaceId }
      },
      async writeTaskSpaceCursor() {},
    }
    const sync = createSync(context, api, controls)
    const result = await sync.pullTaskSpace('space-1')
    assert.equal(result.pendingReview, false)
    assert.equal(controls.length, 0)
    assert.equal(successTimes.length, taskDirs.length)
    assert.deepEqual(attempts[0].input, attempts[1].input)
    assert.equal(new Set(attempts.map((attempt) => attempt.input.batchId)).size, taskDirs.length)
    for (let index = 5; index < successTimes.length; index += 1) {
      assert.ok(successTimes[index] - successTimes[index - 5] >= 1000)
    }
    const binding = (await context.store.readConfig()).bindings[0]
    assert.equal(binding.initialSyncCompleted, true)
    assert.equal((await sync._readCursor('space-1')).pending, null)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('同一 taskSpace 的上传请求完成前不会并发启动下一批', async () => {
  const taskJson = `${JSON.stringify({ id: 'serial-task', title: '串行上传' })}\n`
  const context = await setup({})
  try {
    const sync = createSync(context, {})
    let active = 0
    let maxActive = 0
    const api = {
      async uploadTaskSpaceChanges(taskSpaceId, input) {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 100))
        active -= 1
        return { revision: input.clientSequence, taskSpaceId }
      },
    }
    const binding = sync._binding('space-1')
    const filesFor = (taskDir) => [
      {
        path: `${taskDir}/task.json`,
        content: taskJson,
        sha256: snapshotSha256(taskJson),
        baseSha256: null,
      },
    ]
    await Promise.all([
      sync._uploadBatch(binding, api, {
        batchId: 'serial-batch-1',
        clientSequence: 1,
        files: filesFor('.trellis/tasks/01-serial-a'),
      }),
      sync._uploadBatch(binding, api, {
        batchId: 'serial-batch-2',
        clientSequence: 2,
        files: filesFor('.trellis/tasks/01-serial-b'),
      }),
    ])
    assert.equal(maxActive, 1)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('429 最多重试两次，失败后保留原批次供重启继续', async () => {
  const taskJson = `${JSON.stringify({ id: 'retry-limit', title: '限流重试' })}\n`
  const context = await setup({})
  try {
    const sync = createSync(context, {})
    const files = [
      {
        path: '.trellis/tasks/01-retry-limit/task.json',
        content: taskJson,
        sha256: snapshotSha256(taskJson),
        baseSha256: null,
      },
    ]
    const attempts = []
    let allowsSuccess = false
    const api = {
      async uploadTaskSpaceChanges(taskSpaceId, input) {
        attempts.push({ taskSpaceId, input })
        if (!allowsSuccess) {
          throw new AgentApiError(AGENT_ERROR_CODE.HTTP_ERROR, '同步批次过于频繁，请稍后重试', {
            status: 429,
            serverCode: 'RATE_LIMITED',
            retryable: true,
            retryAfterMs: 1,
          })
        }
        return { revision: 1, taskSpaceId }
      },
    }
    const binding = sync._binding('space-1')
    const cursor = await sync._readCursor('space-1')
    await assert.rejects(
      () => sync._uploadPersistedBatch(binding, api, cursor, files),
      /同步批次过于频繁/,
    )
    assert.equal(attempts.length, 3)
    assert.deepEqual(attempts[0].input, attempts[1].input)
    assert.deepEqual(attempts[1].input, attempts[2].input)
    const pendingCursor = await sync._readCursor('space-1')
    assert.deepEqual(pendingCursor.pending.files, files)

    allowsSuccess = true
    const retried = await sync._retryPendingBatch(binding, api, pendingCursor)
    assert.equal(retried.conflict, false)
    assert.deepEqual(attempts[3].input, {
      ...pendingCursor.pending,
      observedBranchName: 'main',
    })
    assert.equal((await sync._readCursor('space-1')).pending, null)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('bootstrap 从上次部分上传恢复时继续上传剩余本地任务', async () => {
  const uploadedDir = '.trellis/tasks/01-uploaded'
  const remainingDir = '.trellis/tasks/02-remaining'
  const uploadedJson = `${JSON.stringify({ id: 'uploaded-task', title: '已上传' })}\n`
  const remainingJson = `${JSON.stringify({ id: 'remaining-task', title: '待上传' })}\n`
  const context = await setup({
    [uploadedDir]: { 'task.json': uploadedJson },
    [remainingDir]: { 'task.json': remainingJson },
  })
  try {
    context.config.bindings[0].initialSyncMode = 'bootstrap'
    context.config.bindings[0].initialSyncCompleted = false
    context.config.bindings[0].initialReviewPending = false
    await context.store.saveConfig(context.config)
    const uploads = []
    const controls = []
    let revision = 1
    let serverFiles = [serverFile(`${uploadedDir}/task.json`, uploadedJson)]
    const api = {
      async fetchTaskSpaceSnapshot() {
        return { revision, files: serverFiles }
      },
      async fetchTaskDirectory(taskSpaceId, taskDir) {
        return {
          files: serverFiles.filter((file) => file.taskDir === taskDir),
        }
      },
      async uploadTaskSpaceChanges(taskSpaceId, input) {
        uploads.push({ taskSpaceId, input })
        revision += 1
        serverFiles = applyServerFiles(serverFiles, input.files)
        return { revision, taskSpaceId }
      },
      async writeTaskSpaceCursor() {},
    }
    const sync = createSync(context, api, controls)
    const result = await sync.pullTaskSpace('space-1')
    assert.equal(result.pendingReview, false)
    assert.equal(controls.length, 0)
    assert.equal(uploads.length, 1)
    assert.equal(uploads[0].input.files[0].path, `${remainingDir}/task.json`)
    const binding = (await context.store.readConfig()).bindings[0]
    assert.equal(binding.initialSyncCompleted, true)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('bootstrap 上传期间出现其他客户端任务时重新进入审查，不完成接入', async () => {
  const uploadedDir = '.trellis/tasks/01-uploaded'
  const remainingDir = '.trellis/tasks/02-remaining'
  const concurrentDir = '.trellis/tasks/03-concurrent'
  const uploadedJson = `${JSON.stringify({ id: 'uploaded-task', title: '已上传' })}\n`
  const remainingJson = `${JSON.stringify({ id: 'remaining-task', title: '待上传' })}\n`
  const concurrentJson = `${JSON.stringify({ id: 'concurrent-task', title: '并发任务' })}\n`
  const context = await setup({
    [uploadedDir]: { 'task.json': uploadedJson },
    [remainingDir]: { 'task.json': remainingJson },
  })
  try {
    context.config.bindings[0].initialSyncMode = 'bootstrap'
    context.config.bindings[0].initialSyncCompleted = false
    context.config.bindings[0].initialReviewPending = false
    await context.store.saveConfig(context.config)
    const controls = []
    let snapshotCalls = 0
    let cursorWrites = 0
    const api = {
      async fetchTaskSpaceSnapshot() {
        snapshotCalls += 1
        return {
          revision: snapshotCalls === 1 ? 1 : 3,
          files:
            snapshotCalls === 1
              ? [serverFile(`${uploadedDir}/task.json`, uploadedJson)]
              : [
                  serverFile(`${uploadedDir}/task.json`, uploadedJson),
                  serverFile(`${remainingDir}/task.json`, remainingJson),
                  serverFile(`${concurrentDir}/task.json`, concurrentJson),
                ],
        }
      },
      async fetchTaskDirectory() {
        return { files: [] }
      },
      async uploadTaskSpaceChanges() {
        return { revision: 2 }
      },
      async writeTaskSpaceCursor() {
        cursorWrites += 1
      },
    }
    const sync = createSync(context, api, controls)
    const result = await sync.pullTaskSpace('space-1')
    assert.equal(result.pendingReview, true)
    assert.equal(controls.at(-1).type, 'initial_sync_review')
    assert.ok(controls.at(-1).differences.some((item) => item.type === 'server-only'))
    assert.equal(snapshotCalls, 2)
    assert.equal(cursorWrites, 0)
    const binding = (await context.store.readConfig()).bindings[0]
    assert.equal(binding.initialSyncCompleted, false)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('bootstrap 发现服务端已有任务时转为差异审查，不覆盖也不完成接入', async () => {
  const localJson = `${JSON.stringify({ id: 'local-task', title: '本地任务' })}\n`
  const serverJson = `${JSON.stringify({ id: 'server-task', title: '服务端任务' })}\n`
  const context = await setup({
    '.trellis/tasks/01-local': {
      'task.json': localJson,
    },
  })
  try {
    context.config.bindings[0].initialSyncMode = 'bootstrap'
    context.config.bindings[0].initialSyncCompleted = false
    context.config.bindings[0].initialReviewPending = false
    await context.store.saveConfig(context.config)
    let uploads = 0
    let cursorWrites = 0
    const controls = []
    const api = {
      async fetchTaskSpaceSnapshot() {
        return {
          revision: 3,
          files: [serverFile('.trellis/tasks/01-server/task.json', serverJson)],
        }
      },
      async uploadTaskSpaceChanges() {
        uploads += 1
        return { revision: 4 }
      },
      async writeTaskSpaceCursor() {
        cursorWrites += 1
      },
    }
    const sync = createSync(context, api, controls)
    const result = await sync.pullTaskSpace('space-1')
    assert.equal(result.pendingReview, true)
    assert.equal(uploads, 0)
    assert.equal(cursorWrites, 0)
    assert.equal(controls[0].type, 'initial_sync_review')
    assert.equal(fs.existsSync(context.store.paths.liveCursorsFile), false)
    const binding = (await context.store.readConfig()).bindings[0]
    assert.equal(binding.initialSyncCompleted, false)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('bootstrap 上传期间发生 CAS 冲突时保持待审查且不推进游标', async () => {
  const taskDir = '.trellis/tasks/01-race'
  const taskJson = `${JSON.stringify({ id: 'race-task', title: '并发任务' })}\n`
  const context = await setup({
    [taskDir]: {
      'task.json': taskJson,
    },
  })
  try {
    context.config.bindings[0].initialSyncMode = 'bootstrap'
    context.config.bindings[0].initialSyncCompleted = false
    context.config.bindings[0].initialReviewPending = false
    await context.store.saveConfig(context.config)
    const controls = []
    let attempts = 0
    const api = {
      async fetchTaskSpaceSnapshot() {
        return { revision: 0, files: [] }
      },
      async fetchTaskDirectory() {
        return { files: [] }
      },
      async uploadTaskSpaceChanges() {
        attempts += 1
        throw new AgentApiError(AGENT_ERROR_CODE.HTTP_ERROR, '任务已被其他成员创建', {
          status: 409,
          serverCode: 'TASK_FILE_CONFLICT',
          conflictId: 'bootstrap-race',
          details: { taskId: 'race-task', files: [] },
        })
      },
      async writeTaskSpaceCursor() {
        throw new Error('冲突时不能推进服务端游标')
      },
    }
    const sync = createSync(context, api, controls)
    const result = await sync.pullTaskSpace('space-1')
    assert.equal(result.pendingReview, true)
    assert.equal(
      controls.some((event) => event.type === 'task_file_conflict'),
      true,
    )
    assert.equal(attempts, 1)
    assert.equal(fs.existsSync(context.store.paths.liveCursorsFile), true)
    const cursor = await sync._readCursor('space-1')
    assert.equal(cursor.revision, 0)
    const binding = (await context.store.readConfig()).bindings[0]
    assert.equal(binding.initialSyncCompleted, false)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('首次接入遇到内容冲突只发出审查事件，不覆盖文件也不推进游标', async () => {
  const localJson = `${JSON.stringify({ id: 'same-task', title: '本地标题' })}\n`
  const context = await setup({
    '.trellis/tasks/01-same': {
      'task.json': localJson,
    },
  })
  try {
    context.config.bindings[0].initialSyncMode = 'review'
    context.config.bindings[0].initialSyncCompleted = false
    context.config.bindings[0].initialReviewPending = true
    await context.store.saveConfig(context.config)
    const serverJson = `${JSON.stringify({ id: 'same-task', title: '服务端标题' })}\n`
    let uploads = 0
    let cursorWrites = 0
    const controls = []
    const api = {
      async fetchTaskSpaceSnapshot() {
        return {
          taskSpaceId: 'space-1',
          revision: 4,
          files: [serverFile('.trellis/tasks/01-same/task.json', serverJson)],
        }
      },
      async uploadTaskSpaceChanges() {
        uploads += 1
        return { revision: 5 }
      },
      async writeTaskSpaceCursor() {
        cursorWrites += 1
      },
    }
    const sync = createSync(context, api, controls)
    const result = await sync.pullTaskSpace('space-1')
    assert.equal(result.conflicts.length, 1)
    assert.equal(result.conflicts[0].type, 'content-conflict')
    assert.equal(controls.length, 1)
    assert.equal(controls[0].type, 'initial_sync_review')
    assert.equal(controls[0].revision, 4)
    assert.equal(
      JSON.stringify(controls[0]).includes(localJson.trim()) ||
        JSON.stringify(controls[0]).includes(serverJson.trim()),
      false,
    )
    assert.equal(controls[0].differences[0].local.taskDir, '.trellis/tasks/01-same')
    assert.equal(controls[0].differences[0].local.files, undefined)
    assert.equal(
      fs.readFileSync(
        path.join(context.repoPath, '.trellis', 'tasks', '01-same', 'task.json'),
        'utf8',
      ),
      localJson,
    )
    assert.equal(uploads, 0)
    assert.equal(cursorWrites, 0)
    assert.equal(fs.existsSync(context.store.paths.liveCursorsFile), false)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('review 模式存在差异时要求用户逐项处理', async () => {
  const localJson = `${JSON.stringify({ id: 'local-task', title: '本地任务' })}\n`
  const context = await setup({
    '.trellis/tasks/01-local': {
      'task.json': localJson,
    },
  })
  try {
    context.config.bindings[0].initialSyncMode = 'review'
    context.config.bindings[0].initialSyncCompleted = false
    context.config.bindings[0].initialReviewPending = true
    await context.store.saveConfig(context.config)
    const serverJson = `${JSON.stringify({ id: 'server-task', title: '服务端任务' })}\n`
    let uploads = 0
    const controls = []
    const api = {
      async fetchTaskSpaceSnapshot() {
        return {
          taskSpaceId: 'space-1',
          revision: 4,
          files: [serverFile('.trellis/tasks/01-server/task.json', serverJson)],
        }
      },
      async uploadTaskSpaceChanges() {
        uploads += 1
        return { revision: 5 }
      },
    }
    const sync = createSync(context, api, controls)
    const result = await sync.pullTaskSpace('space-1')
    assert.equal(result.pendingReview, true)
    assert.equal(uploads, 0)
    assert.equal(fs.existsSync(context.store.paths.liveCursorsFile), false)
    assert.equal(controls[0].type, 'initial_sync_review')
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('review 模式双方一致时直接完成，不显示空审查窗口', async () => {
  const taskDir = '.trellis/tasks/01-same'
  const taskJson = `${JSON.stringify({ id: 'same-task', title: '一致任务' })}\n`
  const context = await setup({
    [taskDir]: {
      'task.json': taskJson,
    },
  })
  try {
    context.config.bindings[0].initialSyncMode = 'review'
    context.config.bindings[0].initialSyncCompleted = false
    context.config.bindings[0].initialReviewPending = true
    await context.store.saveConfig(context.config)
    const controls = []
    const cursors = []
    const api = {
      async fetchTaskSpaceSnapshot() {
        return {
          revision: 2,
          files: [serverFile(`${taskDir}/task.json`, taskJson)],
        }
      },
      async writeTaskSpaceCursor(taskSpaceId, input) {
        cursors.push({ taskSpaceId, input })
      },
    }
    const sync = createSync(context, api, controls)
    const result = await sync.pullTaskSpace('space-1')
    assert.equal(result.pendingReview, false)
    assert.equal(controls.length, 0)
    assert.deepEqual(cursors, [{ taskSpaceId: 'space-1', input: { revision: 2 } }])
    const binding = (await context.store.readConfig()).bindings[0]
    assert.equal(binding.initialSyncCompleted, true)
    assert.equal(binding.initialReviewPending, false)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('增量快照按完整目录把活动任务原子移动到归档目录', async () => {
  const localJson = `${JSON.stringify({ id: 'move-task', title: '待归档任务' })}\n`
  const context = await setup({
    '.trellis/tasks/01-move': {
      'task.json': localJson,
      'prd.md': '# 待归档任务\n',
    },
  })
  try {
    fs.mkdirSync(path.dirname(context.store.paths.liveCursorsFile), { recursive: true })
    fs.writeFileSync(
      context.store.paths.liveCursorsFile,
      `${JSON.stringify(
        {
          version: 3,
          taskSpaces: {
            'space-1': {
              revision: 1,
              sequence: 2,
              baselines: {
                '.trellis/tasks/01-move/task.json': snapshotSha256(localJson),
                '.trellis/tasks/01-move/prd.md': snapshotSha256('# 待归档任务\n'),
              },
            },
          },
        },
        null,
        2,
      )}\n`,
    )
    const archivedJson = `${JSON.stringify({ id: 'move-task', title: '已归档任务' })}\n`
    const cursors = []
    const api = {
      async fetchTaskSpaceSnapshot(taskSpaceId, input) {
        assert.equal(input.afterRevision, 1)
        return {
          taskSpaceId,
          revision: 2,
          files: [
            serverFile('.trellis/tasks/archive/2026-11/01-move/task.json', archivedJson),
            serverFile('.trellis/tasks/archive/2026-11/01-move/prd.md', '# 待归档任务\n'),
            {
              path: '.trellis/tasks/01-move/task.json',
              taskDir: '.trellis/tasks/01-move',
              deleted: true,
            },
            {
              path: '.trellis/tasks/01-move/prd.md',
              taskDir: '.trellis/tasks/01-move',
              deleted: true,
            },
          ],
        }
      },
      async fetchTaskDirectory(taskSpaceId, taskDir) {
        if (taskDir === '.trellis/tasks/archive/2026-11/01-move') {
          return {
            files: [
              serverFile(`${taskDir}/task.json`, archivedJson, { taskDir }),
              serverFile(`${taskDir}/prd.md`, '# 待归档任务\n', { taskDir }),
            ],
          }
        }
        assert.equal(taskDir, '.trellis/tasks/01-move')
        return { files: [] }
      },
      async writeTaskSpaceCursor(taskSpaceId, input) {
        cursors.push({ taskSpaceId, input })
      },
    }
    const sync = createSync(context, api)
    await sync.pullTaskSpace('space-1')
    assert.equal(fs.existsSync(path.join(context.repoPath, '.trellis', 'tasks', '01-move')), false)
    assert.equal(
      fs.readFileSync(
        path.join(
          context.repoPath,
          '.trellis',
          'tasks',
          'archive',
          '2026-11',
          '01-move',
          'task.json',
        ),
        'utf8',
      ),
      archivedJson,
    )
    assert.deepEqual(cursors[0], {
      taskSpaceId: 'space-1',
      input: { revision: 2 },
    })
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('目录写入失败时保留原目录且不推进游标', async () => {
  const localJson = `${JSON.stringify({ id: 'local-task', title: '本地任务' })}\n`
  const context = await setup({
    '.trellis/tasks/01-same-dir': {
      'task.json': localJson,
    },
  })
  try {
    const serverJson = `${JSON.stringify({ id: 'server-task', title: '服务端任务' })}\n`
    const sync = createSync(context, {})
    await assert.rejects(() =>
      sync._applyServerGroups(
        sync._binding('space-1'),
        1,
        [
          {
            taskDir: '.trellis/tasks/01-same-dir',
            files: [
              serverFile('.trellis/tasks/01-same-dir/task.json', serverJson),
              serverFile('.trellis/tasks/01-same-dir/a.md', 'a\n'),
              serverFile('.trellis/tasks/01-same-dir/a.md/b.md', 'b\n'),
            ],
          },
        ],
        'safe',
      ),
    )
    assert.equal(
      fs.readFileSync(
        path.join(context.repoPath, '.trellis', 'tasks', '01-same-dir', 'task.json'),
        'utf8',
      ),
      localJson,
    )
    assert.equal(fs.existsSync(context.store.paths.liveCursorsFile), false)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('查看差异后可按任务选择使用服务端版本', async () => {
  const localJson = `${JSON.stringify({ id: 'same-task', title: '本地标题' })}\n`
  const context = await setup({
    '.trellis/tasks/01-same': {
      'task.json': localJson,
    },
  })
  try {
    const serverJson = `${JSON.stringify({ id: 'same-task', title: '服务端标题' })}\n`
    const cursors = []
    const api = {
      async fetchTaskSpaceSnapshot() {
        return {
          taskSpaceId: 'space-1',
          revision: 4,
          files: [serverFile('.trellis/tasks/01-same/task.json', serverJson)],
        }
      },
      async writeTaskSpaceCursor(taskSpaceId, input) {
        cursors.push({ taskSpaceId, input })
      },
    }
    const sync = createSync(context, api)
    const result = await sync.resolveInitialSync({
      taskSpaceId: 'space-1',
      mode: 'review',
      decisions: [{ taskId: 'same-task', action: 'use-server' }],
    })
    assert.equal(result.downloaded, 1)
    assert.equal(
      fs.readFileSync(
        path.join(context.repoPath, '.trellis', 'tasks', '01-same', 'task.json'),
        'utf8',
      ),
      serverJson,
    )
    assert.deepEqual(cursors, [
      {
        taskSpaceId: 'space-1',
        input: { revision: 4 },
      },
    ])
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('本地归档移动把旧目录删除和新目录写入合并为同一批次', async () => {
  const oldDir = '.trellis/tasks/01-move'
  const archiveDir = '.trellis/tasks/archive/2026-11/01-move'
  const taskJson = `${JSON.stringify({ id: 'move-task', title: '待归档' })}\n`
  const context = await setup({
    [archiveDir]: {
      'task.json': taskJson,
    },
  })
  try {
    const uploads = []
    const api = {
      async fetchTaskDirectory(taskSpaceId, taskDir) {
        assert.equal(taskSpaceId, 'space-1')
        if (taskDir === oldDir) {
          return {
            files: [serverFile(`${oldDir}/task.json`, taskJson, { taskId: 'move-task' })],
          }
        }
        assert.equal(taskDir, archiveDir)
        return { files: [] }
      },
      async uploadTaskSpaceChanges(taskSpaceId, input) {
        uploads.push({ taskSpaceId, input })
        return { revision: 2, taskSpaceId }
      },
    }
    const sync = createSync(context, api)
    await sync.syncTaskDirectories('space-1', [oldDir, archiveDir], { reconcile: false })
    assert.equal(uploads.length, 1)
    assert.ok(
      uploads[0].input.files.some((file) => file.deleted && file.path === `${oldDir}/task.json`),
    )
    assert.ok(
      uploads[0].input.files.some(
        (file) => !file.deleted && file.path === `${archiveDir}/task.json`,
      ),
    )
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('250 文件网络失败后保留原 batchId、clientSequence 和 files 重试', async () => {
  const taskDir = '.trellis/tasks/01-retry'
  const taskJson = `${JSON.stringify({ id: 'retry-task', title: '重试' })}\n`
  const evidence = Object.fromEntries(
    Array.from({ length: 249 }, (_, index) => [`evidence-${index}.md`, `# 证据 ${index}\n`]),
  )
  const context = await setup({
    [taskDir]: {
      'task.json': taskJson,
      ...evidence,
    },
  })
  try {
    const attempts = []
    let online = false
    const api = {
      async fetchTaskDirectory() {
        return { files: [] }
      },
      async uploadTaskSpaceChanges(taskSpaceId, input) {
        attempts.push({ taskSpaceId, input })
        if (!online) throw new Error('network down')
        return { revision: 1, taskSpaceId }
      },
    }
    const sync = createSync(context, api)
    await sync.syncTaskDirectories('space-1', [taskDir], { reconcile: false })
    const pending = await sync._readCursor('space-1')
    assert.ok(pending.pending)
    assert.equal(pending.pending.files.length, 250)
    assert.equal(attempts[0].input.files.length, 250)

    online = true
    const retried = await sync._retryPendingBatch(sync._binding('space-1'), api, pending)
    assert.equal(attempts.length, 2)
    assert.deepEqual(attempts[1].input, attempts[0].input)
    assert.equal(attempts[1].input.batchId, pending.pending.batchId)
    assert.equal(attempts[1].input.clientSequence, pending.pending.clientSequence)
    assert.equal(retried.conflict, false)
    assert.equal((await sync._readCursor('space-1')).pending, null)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('本地任务文件不是严格 UTF-8 时拒绝同步', async () => {
  const taskDir = '.trellis/tasks/01-utf8'
  const context = await setup({
    [taskDir]: {
      'task.json': `${JSON.stringify({ id: 'utf8-task', title: '合法' })}\n`,
    },
  })
  try {
    fs.writeFileSync(
      path.join(context.repoPath, ...taskDir.split('/'), 'task.json'),
      Buffer.from([0xc3, 0x28]),
    )
    const sync = createSync(context, {})
    await assert.rejects(() => sync._localFiles(context.config.bindings[0]), /有效的 UTF-8/)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('使用服务端版本处理归档移动时备份并移除旧活动目录', async () => {
  const oldDir = '.trellis/tasks/01-move'
  const archiveDir = '.trellis/tasks/archive/2026-11/01-move'
  const localJson = `${JSON.stringify({ id: 'move-task', title: '本地活动版本' })}\n`
  const serverJson = `${JSON.stringify({ id: 'move-task', title: '服务端归档版本' })}\n`
  const context = await setup({
    [oldDir]: {
      'task.json': localJson,
    },
  })
  try {
    let resolved = null
    const api = {
      async fetchTaskSpaceConflicts() {
        return {
          conflicts: [
            {
              id: 'conflict-1',
              taskId: 'move-task',
              taskDir: `${oldDir} -> ${archiveDir}`,
              serverRevision: 5,
              files: [
                {
                  path: `${archiveDir}/task.json`,
                  currentSha256: snapshotSha256(serverJson),
                  changedBy: { displayName: '李四', deviceName: '设备 B' },
                },
              ],
            },
          ],
        }
      },
      async fetchTaskDirectory(taskSpaceId, taskDir) {
        assert.equal(taskSpaceId, 'space-1')
        return {
          revision: 5,
          files: taskDir === archiveDir ? [serverFile(`${archiveDir}/task.json`, serverJson)] : [],
        }
      },
      async resolveTaskSpaceConflict(taskSpaceId, conflictId, input) {
        resolved = { taskSpaceId, conflictId, input }
        return { resolved: true }
      },
    }
    const sync = createSync(context, api)
    await sync.decideConflict({
      taskSpaceId: 'space-1',
      conflictId: 'conflict-1',
      action: 'use-server',
    })
    assert.equal(fs.existsSync(path.join(context.repoPath, ...oldDir.split('/'))), false)
    assert.equal(
      fs.readFileSync(path.join(context.repoPath, ...archiveDir.split('/'), 'task.json'), 'utf8'),
      serverJson,
    )
    assert.deepEqual(resolved.input, { action: 'use-server' })
    const backups = fs.readdirSync(path.join(context.store.paths.liveBackupsDir, 'space-1'))
    assert.equal(backups.length, 1)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('同目录冲突差异读取同时返回本地和服务端内容', async () => {
  const taskDir = '.trellis/tasks/01-same'
  const localJson = `${JSON.stringify({ id: 'same-task', title: '本地标题' })}\n`
  const serverJson = `${JSON.stringify({ id: 'same-task', title: '服务端标题' })}\n`
  const context = await setup({
    [taskDir]: {
      'task.json': localJson,
    },
  })
  try {
    const api = {
      async fetchTaskSpaceConflicts() {
        return {
          conflicts: [
            {
              id: 'conflict-same',
              taskId: 'same-task',
              taskDir,
              serverRevision: 3,
              files: [{ path: `${taskDir}/task.json`, changedBy: { displayName: '李四' } }],
            },
          ],
        }
      },
      async fetchTaskDirectory() {
        return {
          files: [serverFile(`${taskDir}/task.json`, serverJson, { taskId: 'same-task' })],
        }
      },
    }
    const sync = createSync(context, api)
    const details = await sync.conflictDetails({
      taskSpaceId: 'space-1',
      conflictId: 'conflict-same',
    })
    assert.equal(details.localTaskDir, taskDir)
    assert.equal(details.serverTaskDir, taskDir)
    assert.equal(details.files[0].localContent, localJson)
    assert.equal(details.files[0].serverContent, serverJson)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('仅保存本地副本不解决服务端冲突', async () => {
  const taskDir = '.trellis/tasks/01-save-local'
  const localJson = `${JSON.stringify({ id: 'save-local', title: '本地版本' })}\n`
  const serverJson = `${JSON.stringify({ id: 'save-local', title: '服务端版本' })}\n`
  const context = await setup({
    [taskDir]: {
      'task.json': localJson,
    },
  })
  try {
    let resolveCalls = 0
    const api = {
      async fetchTaskSpaceConflicts() {
        return {
          conflicts: [
            {
              id: 'conflict-save-local',
              taskId: 'save-local',
              taskDir,
              serverRevision: 3,
              files: [{ path: `${taskDir}/task.json`, changedBy: { displayName: '李四' } }],
            },
          ],
        }
      },
      async fetchTaskDirectory() {
        return {
          files: [serverFile(`${taskDir}/task.json`, serverJson, { taskId: 'save-local' })],
        }
      },
      async resolveTaskSpaceConflict() {
        resolveCalls += 1
        return { resolved: true }
      },
    }
    const sync = createSync(context, api)
    const result = await sync.decideConflict({
      taskSpaceId: 'space-1',
      conflictId: 'conflict-save-local',
      action: 'save-local-copy',
    })
    assert.equal(result.resolved, false)
    assert.ok(result.backup)
    assert.equal(resolveCalls, 0)
    assert.equal(
      fs.readFileSync(path.join(context.repoPath, ...taskDir.split('/'), 'task.json'), 'utf8'),
      localJson,
    )
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('服务端应用产生的 watcher 事件不会再次上传', async () => {
  const taskDir = '.trellis/tasks/01-remote'
  const context = await setup({})
  try {
    const serverJson = `${JSON.stringify({ id: 'remote-task', title: '远端任务' })}\n`
    let uploads = 0
    const api = {
      async uploadTaskSpaceChanges() {
        uploads += 1
        return { revision: 2 }
      },
    }
    const sync = createSync(context, api)
    await sync._applyServerGroups(context.config.bindings[0], 1, [
      { taskDir, files: [serverFile(`${taskDir}/task.json`, serverJson)] },
    ])
    await sync._uploadDirty('space-1', new Set([`${taskDir}/task.json`]))
    assert.equal(uploads, 0)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('同一任务空间的并发拉取请求按顺序执行', async () => {
  const context = await setup({})
  try {
    let active = 0
    let maxActive = 0
    const api = {
      async fetchTaskSpaceSnapshot(taskSpaceId, input) {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 25))
        active -= 1
        return {
          taskSpaceId,
          revision: Number(input.afterRevision || 0) + 1,
          files: [],
        }
      },
      async writeTaskSpaceCursor() {},
    }
    const sync = createSync(context, api)
    await Promise.all([sync.pullTaskSpace('space-1'), sync.pullTaskSpace('space-1')])
    assert.equal(maxActive, 1)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('归档任务的文件事件能定位完整任务目录并正常上传', async () => {
  const taskDir = '.trellis/tasks/archive/2026-11/01-archive'
  const taskJson = `${JSON.stringify({ id: 'archive-task', title: '已归档任务' })}\n`
  const context = await setup({
    [taskDir]: {
      'task.json': taskJson,
    },
  })
  try {
    const fetchedDirs = []
    const uploads = []
    const api = {
      async fetchTaskDirectory(taskSpaceId, directory) {
        fetchedDirs.push({ taskSpaceId, directory })
        return { files: [] }
      },
      async uploadTaskSpaceChanges(taskSpaceId, input) {
        uploads.push({ taskSpaceId, input })
        return { revision: 1, taskSpaceId }
      },
      async fetchTaskSpaceSnapshot() {
        return { revision: 1, files: [] }
      },
      async writeTaskSpaceCursor() {},
    }
    const sync = createSync(context, api)
    const selectedFiles = await sync._localFiles(sync._binding('space-1'), new Set([taskDir]))
    assert.equal(selectedFiles.length, 1)
    assert.equal(selectedFiles[0].taskDir, taskDir)

    await sync._uploadDirty('space-1', new Set([`${taskDir}/task.json`]))
    assert.deepEqual(fetchedDirs, [{ taskSpaceId: 'space-1', directory: taskDir }])
    assert.equal(uploads.length, 1)
    assert.equal(uploads[0].input.files[0].path, `${taskDir}/task.json`)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})
