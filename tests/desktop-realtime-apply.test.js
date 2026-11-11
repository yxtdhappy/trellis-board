import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { AgentApiClient } from '../agent/api.js'
import { ConfigStore } from '../agent/config-store.js'
import { AgentLiveSync, decidePendingLiveChange, restoreLiveBackup } from '../agent/live-sync.js'

const silentLogger = { info() {}, warn() {}, error() {} }

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function fakeWatcher() {
  return {
    on() {},
    close() {},
  }
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

function setupRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-live-agent-'))
  const repoPath = path.join(root, 'repo')
  const taskDir = path.join(repoPath, '.trellis', 'tasks', 'task-live')
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(taskDir, 'task.json'), '{"title":"local"}\n')
  git(repoPath, ['init', '-b', 'main'])
  git(repoPath, ['config', 'user.email', 'live-test@example.invalid'])
  git(repoPath, ['config', 'user.name', 'Live Test'])
  git(repoPath, ['add', '.trellis/tasks/task-live/task.json'])
  git(repoPath, ['commit', '-m', 'baseline'])
  return { root, repoPath, taskDir }
}

function binding(repoPath) {
  return {
    localId: 'local-1',
    serverBindingId: 'binding-1',
    projectId: 'p-live',
    repoPath,
    branchName: 'main',
    teamId: 't-live',
    readOnly: false,
    syncStatus: 'approved',
    displayName: 'repo',
    createdAt: new Date().toISOString(),
    allowFileRemote: false,
    localRepoKey: 'b'.repeat(64),
    remoteIdentityKey: 'c'.repeat(64),
    lastSyncedAt: null,
    lastHead: null,
    lastError: null,
    lastErrorCode: null,
  }
}

function fakeApi(overrides = {}) {
  const calls = { uploads: [], preflights: [], cursors: [] }
  return {
    calls,
    api: {
      preflightLiveChanges: async (input) => {
        calls.preflights.push(input)
        return { requiresConfirmation: false }
      },
      uploadLiveChanges: async (input) => {
        calls.uploads.push(input)
        return { revision: calls.uploads.length }
      },
      fetchLiveFiles: async () => ({ revision: 0, files: [] }),
      writeLiveCursor: async (input) => {
        calls.cursors.push(input)
        return { ok: true }
      },
      ...overrides,
    },
  }
}

async function persistConfig(store, local) {
  await store.saveConfig({
    schemaVersion: 1,
    revision: 'a'.repeat(32),
    serverUrl: 'http://127.0.0.1:4317',
    agentId: 'agent-live',
    deviceName: 'live-device',
    username: 'writer',
    teamId: null,
    teams: [{ id: 't-live', name: '实时团队', role: 'member' }],
    protocolVersion: 2,
    agentVersion: '0.1.0',
    pairedAt: new Date().toISOString(),
    bindings: [local],
  })
}

test('Git 已收敛的文件写回不上报，真实未提交修改继续上报', async (t) => {
  const { root, repoPath, taskDir } = setupRepo()
  const store = new ConfigStore(path.join(root, 'agent'))
  await store.ensureDirectories()
  const local = binding(repoPath)
  await persistConfig(store, local)
  const controls = []
  const fake = fakeApi()
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    emitControl: (event) => controls.push(event),
    watch: fakeWatcher,
    loadContext: async () => ({
      config: await store.readConfig({ allowMissing: false }),
      api: fake.api,
    }),
  })
  await sync.start()
  t.after(() => {
    sync.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const taskFile = path.join(taskDir, 'task.json')
  fs.writeFileSync(taskFile, '{"title":"local"}\n')
  await sync._handleWatcherEvents([
    {
      repositoryId: 'p-live',
      trellisPath: '.trellis/tasks/task-live/task.json',
    },
  ])
  assert.equal(fake.calls.preflights.length, 0)
  assert.equal(fake.calls.uploads.length, 0)
  assert.equal(controls.length, 0)

  fs.writeFileSync(taskFile, '{"title":"edited"}\n')
  await sync._handleWatcherEvents([
    {
      repositoryId: 'p-live',
      trellisPath: '.trellis/tasks/task-live/task.json',
    },
  ])
  assert.equal(fake.calls.preflights.length, 1)
  assert.equal(fake.calls.uploads.length, 1)
})

test('已收敛的责任人 pending 在展示和重试前自动清理', async (t) => {
  const { root, repoPath, taskDir } = setupRepo()
  const store = new ConfigStore(path.join(root, 'agent'))
  await store.ensureDirectories()
  const local = binding(repoPath)
  await persistConfig(store, local)
  const controls = []
  const fake = fakeApi()
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    emitControl: (event) => controls.push(event),
    watch: fakeWatcher,
    loadContext: async () => ({
      config: await store.readConfig({ allowMissing: false }),
      api: fake.api,
    }),
  })
  await sync.start()
  t.after(() => {
    sync.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const content = fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8')
  const pendingId = 'converged-warning-1'
  const pendingFile = path.join(store.paths.pendingLiveDir, `${pendingId}.json`)
  const pendingPayload = {
    kind: 'decision',
    projectId: 'p-live',
    batchId: pendingId,
    files: [
      {
        path: '.trellis/tasks/task-live/task.json',
        operation: 'upsert',
        sha256: sha256(content),
        content,
      },
    ],
    warning: {
      warningId: 'warning-converged',
      assignee: { username: 'owner' },
      task: {
        taskKey: 'p-live::.trellis/tasks/task-live',
        title: '已收敛任务',
      },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      expiresAtEpochMs: Date.now() + 60_000,
      batchId: pendingId,
    },
  }
  fs.writeFileSync(pendingFile, `${JSON.stringify(pendingPayload, null, 2)}\n`)

  await sync._emitPendingDecisions()
  await sync.retryPendingUploads()
  assert.equal(fs.existsSync(pendingFile), false)
  assert.equal(controls.length, 0)
  assert.equal(fake.calls.uploads.length, 0)

  sync.bindings.get('p-live').repoPath = path.join(root, 'missing-repository')
  fs.writeFileSync(pendingFile, `${JSON.stringify(pendingPayload, null, 2)}\n`)
  await sync._emitPendingDecisions()
  assert.equal(fs.existsSync(pendingFile), true)
  assert.equal(controls.length, 1)
})

test('Agent API 区分请求超时和显式取消', async (t) => {
  const server = http.createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections?.()
    server.close()
  })
  const address = server.address()
  const client = new AgentApiClient({
    serverUrl: `http://127.0.0.1:${address.port}`,
    timeoutMs: 30,
  })

  await assert.rejects(
    () => client.health({ timeoutMs: 30 }),
    (error) => error.code === 'NETWORK_ERROR' && error.message === 'Agent 服务请求超时',
  )

  const controller = new AbortController()
  const request = client.health({ timeoutMs: 1_000, signal: controller.signal })
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(
    () => request,
    (error) => error.code === 'NETWORK_ERROR' && error.message === 'Agent 请求已取消',
  )
})

test('远端覆盖先备份，自触发事件被摘要抑制而真实修改继续上报', async (t) => {
  const { root, repoPath, taskDir } = setupRepo()
  const store = new ConfigStore(path.join(root, 'agent'))
  await store.ensureDirectories()
  const local = binding(repoPath)
  await persistConfig(store, local)
  const remoteContent = '{"title":"remote"}\n'
  const controls = []
  const fake = fakeApi({
    fetchLiveFiles: async () => ({
      revision: 3,
      files: [
        {
          path: '.trellis/tasks/task-live/task.json',
          operation: 'upsert',
          revision: 3,
          sha256: sha256(remoteContent),
          content: remoteContent,
        },
      ],
    }),
  })
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    emitControl: (event) => controls.push(event),
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api,
    }),
  })
  await sync.start()
  t.after(() => {
    sync.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  await sync.pullProject('t-live', 'p-live')
  assert.equal(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8'), remoteContent)
  assert.equal(controls[0].type, 'remote_overwrite')
  assert.deepEqual(controls[0].files, ['.trellis/tasks/task-live/task.json'])
  assert.deepEqual(controls[0].taskKeys, ['p-live::.trellis/tasks/task-live'])
  assert.deepEqual(controls[0].conflicts, [
    {
      path: '.trellis/tasks/task-live/task.json',
      taskKey: 'p-live::.trellis/tasks/task-live',
      revision: 3,
      changeType: 'content',
    },
  ])
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(store.paths.liveBackupsDir, 'p-live', controls[0].backupId, 'manifest.json'),
      'utf8',
    ),
  )
  assert.equal(manifest.files.length, 1)
  assert.equal(manifest.files[0].revision, 3)
  assert.equal(manifest.files[0].changeType, 'content')
  assert.deepEqual(manifest.taskKeys, ['p-live::.trellis/tasks/task-live'])

  await sync._handleWatcherEvents([
    {
      repositoryId: 'p-live',
      trellisPath: '.trellis/tasks/task-live/task.json',
    },
  ])
  assert.equal(fake.calls.preflights.length, 0)

  const changed = '{"title":"user-edit"}\n'
  fs.writeFileSync(path.join(taskDir, 'task.json'), changed)
  await sync._handleWatcherEvents([
    {
      repositoryId: 'p-live',
      trellisPath: '.trellis/tasks/task-live/task.json',
    },
  ])
  assert.equal(fake.calls.uploads.length, 1)
  assert.equal(fake.calls.uploads[0].files[0].content, changed)
})

test('只读绑定只拉取服务端文件，不创建本地上传监听', async (t) => {
  const { root, repoPath, taskDir } = setupRepo()
  const store = new ConfigStore(path.join(root, 'agent'))
  await store.ensureDirectories()
  const local = { ...binding(repoPath), readOnly: true }
  await persistConfig(store, local)
  const remoteContent = '{"title":"readonly-remote"}\n'
  const fake = fakeApi({
    fetchLiveFiles: async () => ({
      revision: 2,
      files: [
        {
          path: '.trellis/tasks/task-live/task.json',
          operation: 'upsert',
          revision: 2,
          sha256: sha256(remoteContent),
          content: remoteContent,
        },
      ],
    }),
  })
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api,
    }),
  })
  await sync.start()
  t.after(() => {
    sync.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  assert.deepEqual(sync.watcher.status().watchedRepositories, [])
  await sync.pullProject('t-live', 'p-live')
  assert.equal(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8'), remoteContent)
  assert.equal(fake.calls.preflights.length, 0)
  assert.equal(fake.calls.uploads.length, 0)
  const config = await store.readConfig({ allowMissing: false })
  assert.equal(config.bindings[0].liveSyncStatus, 'ready')
})

test('只读首次初始化不扫描或上传关联前本地变化', async (t) => {
  const { root, repoPath, taskDir } = setupRepo()
  const localContent = '{"title":"dirty-readonly"}\n'
  fs.writeFileSync(path.join(taskDir, 'task.json'), localContent)
  const store = new ConfigStore(path.join(root, 'agent'))
  await store.ensureDirectories()
  const local = { ...binding(repoPath), readOnly: true }
  await persistConfig(store, local)
  const fake = fakeApi()
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api,
    }),
  })
  await sync.start()
  t.after(() => {
    sync.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  assert.equal(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8'), localContent)
  assert.equal(fake.calls.preflights.length, 0)
  assert.equal(fake.calls.uploads.length, 0)
  const config = await store.readConfig({ allowMissing: false })
  assert.equal(config.bindings[0].liveSyncStatus, 'ready')
})

test('首次初始化同路径冲突按服务端优先并保留本地备份', async (t) => {
  const { root, repoPath, taskDir } = setupRepo()
  const target = path.join(taskDir, 'task.json')
  const localContent = '{"title":"local-conflict"}\n'
  const remoteContent = '{"title":"remote-conflict"}\n'
  fs.writeFileSync(target, localContent)
  const store = new ConfigStore(path.join(root, 'agent'))
  await store.ensureDirectories()
  const local = binding(repoPath)
  await persistConfig(store, local)
  const controls = []
  const fake = fakeApi({
    fetchLiveFiles: async () => ({
      revision: 4,
      files: [
        {
          path: '.trellis/tasks/task-live/task.json',
          operation: 'upsert',
          revision: 4,
          sha256: sha256(remoteContent),
          content: remoteContent,
        },
      ],
    }),
  })
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    emitControl: (event) => controls.push(event),
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api,
    }),
  })
  await sync.start()
  t.after(() => {
    sync.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  assert.equal(fs.readFileSync(target, 'utf8'), remoteContent)
  assert.equal(fake.calls.preflights.length, 0)
  assert.equal(fake.calls.uploads.length, 0)
  assert.equal(controls[0].type, 'remote_overwrite')
  assert.deepEqual(controls[0].files, ['.trellis/tasks/task-live/task.json'])
  assert.equal(controls[0].conflicts[0].changeType, 'content')
  assert.equal(
    fs.readFileSync(
      path.join(controls[0].backupPath, 'files', 'tasks', 'task-live', 'task.json'),
      'utf8',
    ),
    localContent,
  )
  const config = await store.readConfig({ allowMissing: false })
  assert.equal(config.bindings[0].liveSyncStatus, 'ready')
})

test('混合拉取只报告真实冲突并把 LF/CRLF 差异标记为仅换行', async (t) => {
  const { root, repoPath, taskDir } = setupRepo()
  const sameTaskDir = path.join(repoPath, '.trellis', 'tasks', 'task-same')
  const secondTaskDir = path.join(repoPath, '.trellis', 'tasks', 'task-second')
  const prdFile = path.join(taskDir, 'prd.md')
  fs.mkdirSync(sameTaskDir, { recursive: true })
  fs.mkdirSync(secondTaskDir, { recursive: true })
  const sameContent = '{"title":"same"}\n'
  const remotePrd = '# local  \n'
  const remoteSecond = '{"title":"second-remote"}\n'
  fs.writeFileSync(path.join(sameTaskDir, 'task.json'), sameContent)
  fs.writeFileSync(prdFile, remotePrd)
  fs.writeFileSync(path.join(secondTaskDir, 'task.json'), remoteSecond)
  git(repoPath, [
    'add',
    '.trellis/tasks/task-same/task.json',
    '.trellis/tasks/task-live/prd.md',
    '.trellis/tasks/task-second/task.json',
  ])
  git(repoPath, ['commit', '-m', 'add same task'])

  const localContent = '{"title":"line-endings"}\r\n'
  const remoteContent = '{"title":"line-endings"}\n'
  fs.writeFileSync(path.join(taskDir, 'task.json'), localContent)
  fs.writeFileSync(prdFile, '# local\n')
  fs.writeFileSync(path.join(secondTaskDir, 'task.json'), '{"title":"second-local"}\n')

  const store = new ConfigStore(path.join(root, 'agent'))
  await store.ensureDirectories()
  const local = binding(repoPath)
  await persistConfig(store, local)
  const controls = []
  const fake = fakeApi({
    fetchLiveFiles: async () => ({
      revision: 12,
      files: [
        {
          path: '.trellis/tasks/task-live/task.json',
          operation: 'upsert',
          revision: 10,
          sha256: sha256(remoteContent),
          content: remoteContent,
          taskKey: 'p-live::.trellis/tasks/task-live',
        },
        {
          path: '.trellis/tasks/task-live/prd.md',
          operation: 'upsert',
          revision: 11,
          sha256: sha256(remotePrd),
          content: remotePrd,
          taskKey: 'p-live::.trellis/tasks/task-live',
        },
        {
          path: '.trellis/tasks/task-second/task.json',
          operation: 'upsert',
          revision: 12,
          sha256: sha256(remoteSecond),
          content: remoteSecond,
          taskKey: 'p-live::.trellis/tasks/task-second',
        },
        {
          path: '.trellis/tasks/task-same/task.json',
          operation: 'upsert',
          revision: 11,
          sha256: sha256(sameContent),
          content: sameContent,
          taskKey: 'p-live::.trellis/tasks/task-same',
        },
      ],
    }),
  })
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    emitControl: (event) => controls.push(event),
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api,
    }),
  })
  await sync.start()
  t.after(() => {
    sync.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  assert.equal(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8'), remoteContent)
  assert.equal(fs.readFileSync(prdFile, 'utf8'), remotePrd)
  assert.equal(fs.readFileSync(path.join(secondTaskDir, 'task.json'), 'utf8'), remoteSecond)
  assert.equal(fs.readFileSync(path.join(sameTaskDir, 'task.json'), 'utf8'), sameContent)
  assert.equal(controls.length, 1)
  assert.deepEqual(controls[0].taskKeys, [
    'p-live::.trellis/tasks/task-live',
    'p-live::.trellis/tasks/task-second',
  ])
  assert.deepEqual(controls[0].files, [
    '.trellis/tasks/task-live/task.json',
    '.trellis/tasks/task-live/prd.md',
    '.trellis/tasks/task-second/task.json',
  ])
  assert.equal(controls[0].fileCount, 3)
  assert.deepEqual(controls[0].conflicts, [
    {
      path: '.trellis/tasks/task-live/task.json',
      taskKey: 'p-live::.trellis/tasks/task-live',
      revision: 10,
      changeType: 'line-endings',
    },
    {
      path: '.trellis/tasks/task-live/prd.md',
      taskKey: 'p-live::.trellis/tasks/task-live',
      revision: 11,
      changeType: 'content',
    },
    {
      path: '.trellis/tasks/task-second/task.json',
      taskKey: 'p-live::.trellis/tasks/task-second',
      revision: 12,
      changeType: 'content',
    },
  ])

  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(store.paths.liveBackupsDir, 'p-live', controls[0].backupId, 'manifest.json'),
      'utf8',
    ),
  )
  assert.deepEqual(manifest.taskKeys, [
    'p-live::.trellis/tasks/task-live',
    'p-live::.trellis/tasks/task-second',
  ])
  assert.deepEqual(manifest.files, [
    {
      path: '.trellis/tasks/task-live/task.json',
      taskKey: 'p-live::.trellis/tasks/task-live',
      revision: 10,
      localSha256: sha256(localContent),
      remoteSha256: sha256(remoteContent),
      existedLocally: true,
      changeType: 'line-endings',
    },
    {
      path: '.trellis/tasks/task-live/prd.md',
      taskKey: 'p-live::.trellis/tasks/task-live',
      revision: 11,
      localSha256: sha256('# local\n'),
      remoteSha256: sha256(remotePrd),
      existedLocally: true,
      changeType: 'content',
    },
    {
      path: '.trellis/tasks/task-second/task.json',
      taskKey: 'p-live::.trellis/tasks/task-second',
      revision: 12,
      localSha256: sha256('{"title":"second-local"}\n'),
      remoteSha256: sha256(remoteSecond),
      existedLocally: true,
      changeType: 'content',
    },
  ])
})

test('首次初始化补传 Git 基线后的新增、修改和删除', async (t) => {
  const { root, repoPath, taskDir } = setupRepo()
  const prdFile = path.join(taskDir, 'prd.md')
  const gitignoreFile = path.join(repoPath, '.trellis', '.gitignore')
  const workspaceDir = path.join(repoPath, '.trellis', 'workspace')
  const workspaceFile = path.join(workspaceDir, 'notes.md')
  fs.mkdirSync(workspaceDir, { recursive: true })
  fs.writeFileSync(prdFile, '# 初始需求\n')
  fs.writeFileSync(gitignoreFile, '.developer\n')
  fs.writeFileSync(workspaceFile, 'unchanged\n')
  git(repoPath, [
    'add',
    '.trellis/.gitignore',
    '.trellis/tasks/task-live/prd.md',
    '.trellis/workspace/notes.md',
  ])
  git(repoPath, ['commit', '-m', 'add baseline files'])

  const modified = '{"title":"modified"}\n'
  fs.writeFileSync(path.join(taskDir, 'task.json'), modified)
  fs.writeFileSync(path.join(repoPath, '.trellis', '.developer'), 'name=writer\n')
  fs.rmSync(prdFile)
  const createdDir = path.join(repoPath, '.trellis', 'tasks', 'task-created')
  fs.mkdirSync(createdDir, { recursive: true })
  fs.writeFileSync(path.join(createdDir, 'task.json'), '{"title":"created"}\n')

  const store = new ConfigStore(path.join(root, 'agent'))
  await store.ensureDirectories()
  const local = binding(repoPath)
  await persistConfig(store, local)
  const fake = fakeApi()
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api,
    }),
  })
  t.after(() => {
    sync.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })
  await sync.start()

  const files = new Map(
    fake.calls.uploads.flatMap((upload) => upload.files.map((file) => [file.path, file])),
  )
  assert.equal(files.get('.trellis/tasks/task-live/task.json').content, modified)
  assert.equal(files.get('.trellis/tasks/task-live/prd.md').operation, 'delete')
  assert.equal(files.get('.trellis/tasks/task-created/task.json').operation, 'upsert')
  assert.equal(files.get('.trellis/.developer').content, 'name=writer\n')
  assert.equal(files.has('.trellis/workspace/notes.md'), false)
  const config = await store.readConfig({ allowMissing: false })
  assert.equal(config.bindings[0].liveSyncStatus, 'ready')
  assert.equal(config.bindings[0].liveSyncError, null)
})

test('首次初始化与服务端同摘要时跳过，重启后保持幂等', async (t) => {
  const { root, repoPath } = setupRepo()
  const createdDir = path.join(repoPath, '.trellis', 'tasks', 'task-created')
  fs.mkdirSync(createdDir, { recursive: true })
  const content = '{"title":"created"}\n'
  const relativePath = '.trellis/tasks/task-created/task.json'
  fs.writeFileSync(path.join(repoPath, ...relativePath.split('/')), content)
  const store = new ConfigStore(path.join(root, 'agent'))
  await store.ensureDirectories()
  const local = binding(repoPath)
  await persistConfig(store, local)
  const fake = fakeApi({
    fetchLiveFiles: async () => ({
      revision: 2,
      files: [
        {
          path: relativePath,
          operation: 'upsert',
          revision: 2,
          sha256: sha256(content),
          content,
        },
      ],
    }),
  })
  const first = new AgentLiveSync({
    store,
    logger: silentLogger,
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api,
    }),
  })
  const second = new AgentLiveSync({
    store,
    logger: silentLogger,
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api,
    }),
  })
  t.after(() => {
    first.stop()
    second.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  await first.start()
  first.stop()
  await second.start()
  assert.equal(fake.calls.preflights.length, 0)
  assert.equal(fake.calls.uploads.length, 0)
  const config = await store.readConfig({ allowMissing: false })
  assert.equal(config.bindings[0].liveSyncStatus, 'ready')
})

test('已有持久化游标时重启走增量并保留本地未提交修改', async (t) => {
  const { root, repoPath, taskDir } = setupRepo()
  const target = path.join(taskDir, 'task.json')
  const original = fs.readFileSync(target, 'utf8')
  const store = new ConfigStore(path.join(root, 'agent'))
  await store.ensureDirectories()
  const local = binding(repoPath)
  await persistConfig(store, local)
  const fetches = []
  const controls = []
  const fake = fakeApi({
    fetchLiveFiles: async ({ afterRevision }) => {
      fetches.push(afterRevision)
      return afterRevision === 0
        ? {
            revision: 2,
            files: [
              {
                path: '.trellis/tasks/task-live/task.json',
                operation: 'upsert',
                revision: 2,
                sha256: sha256(original),
                content: original,
              },
            ],
          }
        : { revision: 2, files: [] }
    },
  })
  const createSync = () =>
    new AgentLiveSync({
      store,
      logger: silentLogger,
      emitControl: (event) => controls.push(event),
      watch: fakeWatcher,
      loadContext: async () => ({
        config: { bindings: [local] },
        api: fake.api,
      }),
    })
  const first = createSync()
  const second = createSync()
  t.after(() => {
    first.stop()
    second.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  await first.start()
  first.stop()
  const modified = '{"title":"local-modified"}\n'
  fs.writeFileSync(target, modified)
  await second.start()

  assert.deepEqual(fetches, [0, 2])
  assert.equal(fs.readFileSync(target, 'utf8'), modified)
  assert.equal(controls.length, 0)
  assert.equal(fake.calls.preflights.length, 1)
  assert.equal(fake.calls.uploads.length, 1)
  assert.equal(fake.calls.uploads[0].files[0].content, modified)
})

test('初始化失败写错误状态，修复 Git 基线后可重试恢复', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-live-retry-'))
  const repoPath = path.join(root, 'repo')
  const taskDir = path.join(repoPath, '.trellis', 'tasks', 'task-live')
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(taskDir, 'task.json'), '{"title":"local"}\n')
  git(repoPath, ['init', '-b', 'main'])
  git(repoPath, ['config', 'user.email', 'live-test@example.invalid'])
  git(repoPath, ['config', 'user.name', 'Live Test'])
  const store = new ConfigStore(path.join(root, 'agent'))
  await store.ensureDirectories()
  const local = binding(repoPath)
  await persistConfig(store, local)
  const fake = fakeApi()
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api,
    }),
  })
  t.after(() => {
    sync.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  await sync.start()
  let config = await store.readConfig({ allowMissing: false })
  assert.equal(config.bindings[0].liveSyncStatus, 'error')
  assert.match(config.bindings[0].liveSyncError, /Git 本地变化扫描失败/)

  git(repoPath, ['add', '.trellis/tasks/task-live/task.json'])
  git(repoPath, ['commit', '-m', 'baseline'])
  await sync.retryPendingUploads()
  config = await store.readConfig({ allowMissing: false })
  assert.equal(config.bindings[0].liveSyncStatus, 'ready')
  assert.equal(config.bindings[0].liveSyncError, null)
})

test('客户端拒绝服务端返回 .trellis 白名单之外的路径', async (t) => {
  const { root, repoPath } = setupRepo()
  const gitConfigFile = path.join(repoPath, '.git', 'config')
  const originalGitConfig = fs.readFileSync(gitConfigFile, 'utf8')
  const store = new ConfigStore(path.join(root, 'agent'))
  await store.ensureDirectories()
  const local = binding(repoPath)
  await persistConfig(store, local)
  const fake = fakeApi({
    fetchLiveFiles: async () => ({
      revision: 1,
      files: [
        {
          path: '.git/config',
          operation: 'upsert',
          revision: 1,
          sha256: sha256('bad\n'),
          content: 'bad\n',
        },
      ],
    }),
  })
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api,
    }),
  })
  await sync.start()
  t.after(() => {
    sync.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  await assert.rejects(() => sync.pullProject('t-live', 'p-live'), /路径越界/)
  assert.equal(fs.readFileSync(gitConfigFile, 'utf8'), originalGitConfig)
})

test('同一项目变化按任务拆分批次', async (t) => {
  const { root, repoPath, taskDir } = setupRepo()
  const secondDir = path.join(repoPath, '.trellis', 'tasks', 'task-second')
  const store = new ConfigStore(path.join(root, 'agent'))
  await store.ensureDirectories()
  const local = binding(repoPath)
  await persistConfig(store, local)
  const fake = fakeApi()
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api,
    }),
  })
  await sync.start()
  t.after(() => {
    sync.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  fs.mkdirSync(secondDir, { recursive: true })
  fs.writeFileSync(path.join(secondDir, 'task.json'), '{"title":"second"}\n')
  fs.writeFileSync(path.join(taskDir, 'task.json'), '{"title":"first"}\n')
  await sync._handleWatcherEvents([
    { repositoryId: 'p-live', trellisPath: '.trellis/tasks/task-live/task.json' },
    { repositoryId: 'p-live', trellisPath: '.trellis/tasks/task-second/task.json' },
  ])
  assert.equal(fake.calls.preflights.length, 2)
  assert.equal(fake.calls.uploads.length, 2)
  for (const upload of fake.calls.uploads) {
    const taskRoots = new Set(
      upload.files.map((file) => taskKeysForTest(upload.projectId, file.path)),
    )
    assert.equal(taskRoots.size, 1)
  }
})

test('同一项目 watcher 批次严格串行，旧内容不会晚于新内容上传', async (t) => {
  const { root, repoPath, taskDir } = setupRepo()
  const store = new ConfigStore(path.join(root, 'agent'))
  await store.ensureDirectories()
  const local = binding(repoPath)
  await persistConfig(store, local)
  const uploads = []
  let releaseFirst
  let firstStarted
  const started = new Promise((resolve) => {
    firstStarted = resolve
  })
  const fake = fakeApi({
    uploadLiveChanges: async (input) => {
      uploads.push(input)
      if (uploads.length === 1) {
        firstStarted()
        await new Promise((resolve) => {
          releaseFirst = resolve
        })
      }
      return { revision: uploads.length }
    },
  })
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api,
    }),
  })
  await sync.start()
  t.after(() => {
    sync.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const firstContent = '{"title":"first-write"}\n'
  const secondContent = '{"title":"second-write"}\n'
  fs.writeFileSync(path.join(taskDir, 'task.json'), firstContent)
  const first = sync._handleWatcherEvents([
    {
      repositoryId: 'p-live',
      trellisPath: '.trellis/tasks/task-live/task.json',
    },
  ])
  await started
  fs.writeFileSync(path.join(taskDir, 'task.json'), secondContent)
  const second = sync._handleWatcherEvents([
    {
      repositoryId: 'p-live',
      trellisPath: '.trellis/tasks/task-live/task.json',
    },
  ])
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(uploads.length, 1)
  releaseFirst()
  await Promise.all([first, second])
  assert.equal(uploads.length, 2)
  assert.equal(uploads[0].files[0].content, firstContent)
  assert.equal(uploads[1].files[0].content, secondContent)
})

test('网络失败后使用原 batchId 重试上传', async (t) => {
  const { root, repoPath, taskDir } = setupRepo()
  const store = new ConfigStore(path.join(root, 'agent'))
  await store.ensureDirectories()
  const local = binding(repoPath)
  await persistConfig(store, local)
  const uploads = []
  const fake = fakeApi({
    uploadLiveChanges: async (input) => {
      uploads.push(input)
      if (uploads.length === 1) throw new Error('network down')
      return { revision: 7 }
    },
  })
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api,
    }),
  })
  await sync.start()
  t.after(() => {
    sync.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  fs.writeFileSync(path.join(taskDir, 'task.json'), '{"title":"offline"}\n')
  await sync._handleWatcherEvents([
    {
      repositoryId: 'p-live',
      trellisPath: '.trellis/tasks/task-live/task.json',
    },
  ])
  assert.equal(uploads.length, 1)
  const pendingNames = fs.readdirSync(store.paths.pendingLiveDir)
  assert.equal(pendingNames.length, 1)
  let config = await store.readConfig({ allowMissing: false })
  assert.equal(config.bindings[0].liveSyncStatus, 'error')
  assert.match(config.bindings[0].liveSyncError, /上传失败|network/i)
  const originalUnlink = fsPromises.unlink
  let injectedUnlinkFailure = false
  fsPromises.unlink = async (file) => {
    if (!injectedUnlinkFailure && String(file).endsWith(`${uploads[0].batchId}.json`)) {
      injectedUnlinkFailure = true
      const error = new Error('模拟 Windows 文件占用')
      error.code = 'EBUSY'
      throw error
    }
    return originalUnlink(file)
  }
  t.after(() => {
    fsPromises.unlink = originalUnlink
  })
  await sync.retryPendingUploads()
  assert.equal(uploads.length, 2)
  assert.equal(uploads[1].batchId, uploads[0].batchId)
  assert.equal(injectedUnlinkFailure, true)
  assert.equal(fs.readdirSync(store.paths.pendingLiveDir).length, 0)
  config = await store.readConfig({ allowMissing: false })
  assert.equal(config.bindings[0].liveSyncStatus, 'ready')
  assert.equal(config.bindings[0].liveSyncError, null)
})

test('重试循环不会并发处理同一 pending 批次', async (t) => {
  const { root, repoPath, taskDir } = setupRepo()
  const store = new ConfigStore(path.join(root, 'agent'))
  await store.ensureDirectories()
  const local = binding(repoPath)
  await persistConfig(store, local)
  const content = '{"title":"dirty pending"}\n'
  fs.writeFileSync(path.join(taskDir, 'task.json'), content)
  const batchId = 'pending-serial-1'
  fs.writeFileSync(
    path.join(store.paths.pendingLiveDir, `${batchId}.json`),
    JSON.stringify({
      kind: 'upload',
      createdAt: new Date().toISOString(),
      projectId: local.projectId,
      bindingId: local.serverBindingId,
      batchId,
      clientSequence: Date.now(),
      observedAt: new Date().toISOString(),
      files: [
        {
          path: '.trellis/tasks/task-live/task.json',
          operation: 'upsert',
          sha256: sha256(content),
          content,
        },
      ],
    }),
  )
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const uploads = []
  const fake = fakeApi({
    uploadLiveChanges: async (input) => {
      uploads.push(input)
      await gate
      return { revision: 8 }
    },
  })
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api,
    }),
  })
  sync.updateBindings([local])
  await sync._waitForInitializations()
  t.after(() => {
    sync.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  const first = sync.retryPendingUploads()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const second = sync.retryPendingUploads()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(uploads.length, 1)
  release()
  await Promise.all([first, second])
  assert.equal(uploads.length, 1)
  assert.equal(fs.existsSync(path.join(store.paths.pendingLiveDir, `${batchId}.json`)), false)
})

test('初始化仍失败时 pending 上传成功不会误报同步正常', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-live-error-'))
  const repoPath = path.join(root, 'repo')
  const taskDir = path.join(repoPath, '.trellis', 'tasks', 'task-live')
  fs.mkdirSync(taskDir, { recursive: true })
  const content = '{"title":"local"}\n'
  fs.writeFileSync(path.join(taskDir, 'task.json'), content)
  git(repoPath, ['init', '-b', 'main'])
  const store = new ConfigStore(path.join(root, 'agent'))
  await store.ensureDirectories()
  const local = binding(repoPath)
  await persistConfig(store, local)
  const fake = fakeApi()
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api,
    }),
  })
  await sync.start()
  const batchId = 'pending-with-init-error'
  fs.writeFileSync(
    path.join(store.paths.pendingLiveDir, `${batchId}.json`),
    JSON.stringify({
      kind: 'upload',
      createdAt: new Date().toISOString(),
      projectId: local.projectId,
      bindingId: local.serverBindingId,
      batchId,
      clientSequence: Date.now(),
      observedAt: new Date().toISOString(),
      files: [
        {
          path: '.trellis/tasks/task-live/task.json',
          operation: 'upsert',
          sha256: sha256(content),
          content,
        },
      ],
    }),
  )
  t.after(() => {
    sync.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  await sync.retryPendingUploads()
  assert.equal(fake.calls.uploads.length, 1)
  const config = await store.readConfig({ allowMissing: false })
  assert.equal(config.bindings[0].liveSyncStatus, 'error')
  assert.match(config.bindings[0].liveSyncError, /Git 本地变化扫描失败/)
})

function taskKeysForTest(projectId, filePath) {
  const relative = String(filePath).startsWith('.trellis/tasks/')
    ? String(filePath).slice('.trellis/tasks/'.length).split('/')[0]
    : ''
  return relative ? `${projectId}::.trellis/tasks/${relative}` : null
}

test('责任人警告持久化为待确认批次，继续推进时携带确认结果上传', async (t) => {
  const { root, repoPath, taskDir } = setupRepo()
  const store = new ConfigStore(path.join(root, 'agent'))
  await store.ensureDirectories()
  const local = binding(repoPath)
  await persistConfig(store, local)
  const controls = []
  const fake = fakeApi({
    preflightLiveChanges: async () => ({
      requiresConfirmation: true,
      warningId: 'warning-live-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      assignee: { username: 'owner', displayName: 'Owner' },
      task: {
        taskKey: 'p-live::.trellis/tasks/task-live',
        title: '任务',
      },
    }),
  })
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    emitControl: (event) => controls.push(event),
    watch: fakeWatcher,
    loadContext: async () => ({
      config: { bindings: [local] },
      api: fake.api,
    }),
  })
  await sync.start()
  t.after(() => {
    sync.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  fs.writeFileSync(path.join(taskDir, 'task.json'), '{"title":"changed"}\n')
  await sync._handleWatcherEvents([
    {
      repositoryId: 'p-live',
      trellisPath: '.trellis/tasks/task-live/task.json',
    },
  ])
  assert.equal(controls[0].type, 'assignment_warning')
  assert.equal(typeof controls[0].expiresAtEpochMs, 'number')
  assert.ok(controls[0].expiresAtEpochMs > Date.now())
  assert.equal(fake.calls.uploads.length, 0)
  await sync._emitPendingDecisions()
  assert.equal(controls.length, 2)
  assert.equal(controls[1].pendingId, controls[0].pendingId)

  const decisionApi = {
    preflightLiveChanges: async () => ({
      requiresConfirmation: true,
      warningId: 'warning-refreshed',
    }),
    uploadLiveChanges: async (input) => {
      fake.calls.uploads.push(input)
      return { revision: 4 }
    },
    fetchLiveFiles: async () => ({ revision: 0, files: [] }),
    writeLiveCursor: async () => ({ ok: true }),
  }
  const result = await decidePendingLiveChange({
    store,
    credentialStore: {
      loadCredential: async () => 'a'.repeat(43),
    },
    apiClientFactory: () => decisionApi,
    pendingId: controls[0].pendingId,
    action: 'continue',
  })
  assert.equal(result.revision, 4)
  assert.equal(fake.calls.uploads[0].assigneeDecision.action, 'continue')
  assert.equal(fake.calls.uploads[0].assigneeDecision.warningId, 'warning-refreshed')
  assert.equal(
    fs.existsSync(path.join(store.paths.pendingLiveDir, `${controls[0].pendingId}.json`)),
    false,
  )
})

test('过期的责任人确认事件不会再次弹出', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-live-expired-'))
  const store = new ConfigStore(path.join(root, 'agent'))
  await store.ensureDirectories()
  const pendingId = 'expired-warning-1'
  const pendingFile = path.join(store.paths.pendingLiveDir, `${pendingId}.json`)
  fs.writeFileSync(
    pendingFile,
    JSON.stringify({
      kind: 'decision',
      batchId: pendingId,
      projectId: 'p-live',
      files: [],
      warning: {
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
        task: { taskKey: 'p-live::.trellis/tasks/task-live' },
      },
    }),
  )
  const controls = []
  const sync = new AgentLiveSync({
    store,
    logger: silentLogger,
    emitControl: (event) => controls.push(event),
    loadContext: async () => {
      throw new Error('不应读取上下文')
    },
  })
  t.after(() => {
    sync.stop()
    fs.rmSync(root, { recursive: true, force: true })
  })

  await sync._emitPendingDecisions()
  assert.equal(controls.length, 0)
  assert.equal(fs.existsSync(pendingFile), false)
})

test('一键复原把备份作为新的实时批次上传', async (t) => {
  const { root, repoPath } = setupRepo()
  const store = new ConfigStore(path.join(root, 'agent'))
  await store.ensureDirectories()
  const local = binding(repoPath)
  await persistConfig(store, local)
  const backupId = 'backup-live-1'
  const backupRoot = path.join(store.paths.liveBackupsDir, 'p-live', backupId)
  fs.mkdirSync(path.join(backupRoot, 'files', 'tasks', 'task-live'), { recursive: true })
  const restored = '{"title":"restored"}\n'
  fs.writeFileSync(path.join(backupRoot, 'files', 'tasks', 'task-live', 'task.json'), restored)
  fs.writeFileSync(
    path.join(backupRoot, 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      backupId,
      projectId: 'p-live',
      revision: 3,
      files: [
        {
          path: '.trellis/tasks/task-live/task.json',
          existedLocally: true,
        },
      ],
    }),
  )
  const uploads = []
  const result = await restoreLiveBackup({
    store,
    credentialStore: {
      loadCredential: async () => 'a'.repeat(43),
    },
    apiClientFactory: () => ({
      preflightLiveChanges: async () => ({ requiresConfirmation: false }),
      uploadLiveChanges: async (input) => {
        uploads.push(input)
        return { revision: 5 }
      },
    }),
    backupId,
  })
  assert.equal(result.revision, 5)
  assert.equal(uploads[0].files[0].content, restored)
  assert.equal(uploads[0].batchId.length > 8, true)
  assert.equal(
    fs.readFileSync(path.join(repoPath, '.trellis', 'tasks', 'task-live', 'task.json'), 'utf8'),
    restored,
  )
  assert.equal(fs.existsSync(store.paths.liveSuppressionFile), true)
  const restoredManifest = JSON.parse(
    fs.readFileSync(path.join(backupRoot, 'manifest.json'), 'utf8'),
  )
  assert.equal(restoredManifest.restoreRevision, 5)
  assert.ok(restoredManifest.restoredAt)
})
