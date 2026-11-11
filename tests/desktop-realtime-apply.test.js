import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ConfigStore } from '../agent/config-store.js'
import { AgentTaskSnapshotSync } from '../agent/task-snapshot-sync.js'
import { snapshotSha256 } from '../shared/task-snapshot.js'

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

async function setup(localTasks = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-desktop-task-sync-'))
  const repoPath = path.join(root, 'repo')
  fs.mkdirSync(path.join(repoPath, '.trellis', 'tasks'), { recursive: true })
  for (const [taskDir, files] of Object.entries(localTasks)) {
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

function createSync(context, api, controls = []) {
  const sync = new AgentTaskSnapshotSync({
    store: context.store,
    loadContext: async () => ({ config: context.config, api }),
    logger: { warn() {} },
    emitControl: (event) => controls.push(event),
  })
  sync.updateBindings(context.config.bindings)
  return sync
}

test('首次接入只下载 tasks 快照并推进本地与服务端游标', async () => {
  const context = await setup()
  try {
    const taskJson = `${JSON.stringify({ id: 'server-task', title: '服务端任务' })}\n`
    const cursors = []
    const api = {
      async fetchTaskSpaceSnapshot(taskSpaceId, input) {
        assert.equal(taskSpaceId, 'space-1')
        assert.equal(input.afterRevision, 0)
        return {
          revision: 4,
          files: [
            serverFile('.trellis/tasks/01-server/task.json', taskJson),
            serverFile('.trellis/tasks/01-server/prd.md', '# 服务端任务\n'),
          ],
        }
      },
      async writeTaskSpaceCursor(taskSpaceId, input) {
        cursors.push({ taskSpaceId, input })
      },
    }
    const sync = createSync(context, api)
    const result = await sync.pullTaskSpace('space-1')
    assert.equal(result.revision, 4)
    assert.equal(
      fs.readFileSync(
        path.join(context.repoPath, '.trellis', 'tasks', '01-server', 'task.json'),
        'utf8',
      ),
      taskJson,
    )
    assert.equal(fs.existsSync(path.join(context.repoPath, '.trellis', 'workspace')), false)
    assert.equal(fs.existsSync(path.join(context.repoPath, '.trellis', '.developer')), false)
    assert.deepEqual(cursors, [{ taskSpaceId: 'space-1', input: { revision: 4 } }])
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('首次内容冲突只发出审查事件，不覆盖本地也不推进游标', async () => {
  const taskDir = '.trellis/tasks/01-conflict'
  const localJson = `${JSON.stringify({ id: 'same-task', title: '本地标题' })}\n`
  const serverJson = `${JSON.stringify({ id: 'same-task', title: '服务端标题' })}\n`
  const context = await setup({ [taskDir]: { 'task.json': localJson } })
  try {
    context.config.bindings[0].initialSyncMode = 'review'
    context.config.bindings[0].initialSyncCompleted = false
    context.config.bindings[0].initialReviewPending = true
    await context.store.saveConfig(context.config)
    const controls = []
    let cursorWrites = 0
    const api = {
      async fetchTaskSpaceSnapshot() {
        return {
          revision: 3,
          files: [serverFile(`${taskDir}/task.json`, serverJson)],
        }
      },
      async writeTaskSpaceCursor() {
        cursorWrites += 1
      },
    }
    const sync = createSync(context, api, controls)
    const result = await sync.pullTaskSpace('space-1')
    assert.equal(result.conflicts.length, 1)
    assert.equal(controls[0].type, 'initial_sync_review')
    assert.equal(
      fs.readFileSync(path.join(context.repoPath, ...taskDir.split('/'), 'task.json'), 'utf8'),
      localJson,
    )
    assert.equal(cursorWrites, 0)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('增量快照按完整目录把活动任务移动到归档目录', async () => {
  const oldDir = '.trellis/tasks/01-move'
  const archiveDir = '.trellis/tasks/archive/2026-11/01-move'
  const localJson = `${JSON.stringify({ id: 'move-task', title: '待归档' })}\n`
  const archivedJson = `${JSON.stringify({ id: 'move-task', title: '已归档' })}\n`
  const context = await setup({ [oldDir]: { 'task.json': localJson } })
  try {
    write(
      context.store.paths.liveCursorsFile,
      `${JSON.stringify({
        version: 3,
        taskSpaces: {
          'space-1': {
            revision: 1,
            sequence: 1,
            baselines: {
              '.trellis/tasks/01-move/task.json': snapshotSha256(localJson),
            },
          },
        },
      })}\n`,
    )
    const api = {
      async fetchTaskSpaceSnapshot(taskSpaceId, input) {
        assert.equal(input.afterRevision, 1)
        return {
          revision: 2,
          files: [
            serverFile(`${archiveDir}/task.json`, archivedJson),
            {
              path: `${oldDir}/task.json`,
              taskDir: oldDir,
              deleted: true,
            },
          ],
        }
      },
      async fetchTaskDirectory(taskSpaceId, taskDir) {
        if (taskDir === archiveDir) {
          return { files: [serverFile(`${archiveDir}/task.json`, archivedJson)] }
        }
        assert.equal(taskDir, oldDir)
        return { files: [] }
      },
      async writeTaskSpaceCursor() {},
    }
    const sync = createSync(context, api)
    await sync.pullTaskSpace('space-1')
    assert.equal(fs.existsSync(path.join(context.repoPath, ...oldDir.split('/'))), false)
    assert.equal(
      fs.readFileSync(path.join(context.repoPath, ...archiveDir.split('/'), 'task.json'), 'utf8'),
      archivedJson,
    )
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('冲突选择服务端版本时先备份本地完整任务目录', async () => {
  const taskDir = '.trellis/tasks/01-conflict'
  const localJson = `${JSON.stringify({ id: 'same-task', title: '本地标题' })}\n`
  const serverJson = `${JSON.stringify({ id: 'same-task', title: '服务端标题' })}\n`
  const context = await setup({ [taskDir]: { 'task.json': localJson } })
  try {
    const api = {
      async fetchTaskSpaceConflicts() {
        return {
          conflicts: [
            {
              id: 'conflict-1',
              taskId: 'same-task',
              taskDir,
              serverRevision: 5,
              files: [{ path: `${taskDir}/task.json`, changedBy: { displayName: '李四' } }],
            },
          ],
        }
      },
      async fetchTaskDirectory() {
        return {
          files: [serverFile(`${taskDir}/task.json`, serverJson)],
        }
      },
      async resolveTaskSpaceConflict() {
        return { resolved: true }
      },
    }
    const sync = createSync(context, api)
    await sync.decideConflict({
      taskSpaceId: 'space-1',
      conflictId: 'conflict-1',
      action: 'use-server',
    })
    assert.equal(
      fs.readFileSync(path.join(context.repoPath, ...taskDir.split('/'), 'task.json'), 'utf8'),
      serverJson,
    )
    const backups = fs.readdirSync(path.join(context.store.paths.liveBackupsDir, 'space-1'))
    assert.equal(backups.length, 1)
    assert.equal(
      fs.readFileSync(
        path.join(context.store.paths.liveBackupsDir, 'space-1', backups[0], 'task.json'),
        'utf8',
      ),
      localJson,
    )
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})

test('网络响应丢失后复用原 batchId 重试，不制造第二个批次', async () => {
  const taskDir = '.trellis/tasks/01-retry'
  const taskJson = `${JSON.stringify({ id: 'retry-task', title: '重试' })}\n`
  const context = await setup({ [taskDir]: { 'task.json': taskJson } })
  try {
    const attempted = []
    let online = false
    const api = {
      async fetchTaskDirectory() {
        return { files: [] }
      },
      async uploadTaskSpaceChanges(taskSpaceId, input) {
        attempted.push({ taskSpaceId, input })
        if (!online) throw new Error('network timeout')
        return { revision: 1, taskSpaceId }
      },
    }
    const sync = createSync(context, api)
    await sync.syncTaskDirectories('space-1', [taskDir], { reconcile: false })
    const pending = await sync._readCursor('space-1')
    online = true
    await sync._retryPendingBatch(sync._binding('space-1'), api, pending)
    assert.equal(attempted.length, 2)
    assert.equal(attempted[0].input.batchId, attempted[1].input.batchId)
    assert.equal((await sync._readCursor('space-1')).pending, null)
  } finally {
    fs.rmSync(context.root, { recursive: true, force: true })
  }
})
