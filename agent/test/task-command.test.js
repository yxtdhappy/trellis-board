import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { ConfigStore } from '../config-store.js'
import { inspectGitProject } from '../git-sync.js'
import { AgentTaskCommandExecutor } from '../task-command.js'
import { snapshotSha256 } from '../../shared/task-snapshot.js'

function runGit(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    env: process.env,
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`)
  }
  return result.stdout.trim()
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function createRepository() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-task-command-'))
  const remote = path.join(base, 'remote.git')
  const seed = path.join(base, 'seed')
  const local = path.join(base, 'local')
  fs.mkdirSync(seed, { recursive: true })
  runGit(base, ['init', '--bare', '--initial-branch=main', remote])
  runGit(seed, ['init', '-b', 'main'])
  runGit(seed, ['config', 'user.email', 'agent-test@example.invalid'])
  runGit(seed, ['config', 'user.name', 'Agent Test'])
  write(path.join(seed, '.trellis', 'tasks', '.keep'), 'tasks\n')
  write(
    path.join(seed, '.trellis', 'scripts', 'task.py'),
    [
      'import json',
      'import pathlib',
      'import sys',
      '',
      'args = sys.argv[1:]',
      'slug = next((item.split("=", 1)[1] for item in args if item.startswith("--slug=")), "created")',
      'assignee = next((item.split("=", 1)[1] for item in args if item.startswith("--assignee=")), "alice")',
      'target = pathlib.Path(".trellis/tasks") / slug',
      'target.mkdir(parents=True, exist_ok=False)',
      '(target / "task.json").write_text(json.dumps({"id": slug, "title": args[1], "status": "planning", "assignee": assignee, "priority": "P2"}, indent=2) + "\\n", encoding="utf-8")',
      '(target / "prd.md").write_text("# 新任务\\n", encoding="utf-8")',
      '',
    ].join('\n'),
  )
  write(path.join(seed, 'README.md'), 'initial\n')
  runGit(seed, ['add', '.'])
  runGit(seed, ['commit', '-m', 'initial'])
  const remoteUrl = pathToFileURL(remote).href
  runGit(seed, ['remote', 'add', 'origin', remoteUrl])
  runGit(seed, ['push', '-u', 'origin', 'main'])
  runGit(base, ['clone', remoteUrl, local])
  runGit(local, ['config', 'user.email', 'agent-test@example.invalid'])
  runGit(local, ['config', 'user.name', 'Agent Test'])
  return { base, local, remoteUrl }
}

async function setup(repo) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-task-command-agent-'))
  const store = new ConfigStore(root, { secureDirectory: false })
  const hooksDir = path.join(store.paths.hooksBaseDir, 'local-1')
  const repository = await inspectGitProject({
    repoPath: repo.local,
    branchName: 'main',
    hooksDir,
    allowFileRemote: true,
  })
  const binding = {
    localId: 'local-1',
    serverBindingId: 'binding-1',
    taskSpaceId: 'space-1',
    projectId: 'project-1',
    teamId: 'team-1',
    repoPath: repository.root,
    branchName: 'main',
    remoteIdentityKey: repository.remoteIdentityKey,
    localRepoKey: repository.localRepoKey,
    displayName: '测试项目',
    createdAt: new Date().toISOString(),
    allowFileRemote: true,
    readOnly: false,
    syncStatus: 'approved',
    liveSyncStatus: 'ready',
    liveSyncError: null,
    lastSyncedAt: null,
    lastHead: repository.head,
    lastError: null,
    lastErrorCode: null,
  }
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
    bindings: [binding],
  }
  await store.saveConfig(config)
  const syncCalls = []
  const taskSync = {
    async syncTaskDirectories(taskSpaceId, taskDirs, options) {
      syncCalls.push({ taskSpaceId, taskDirs, options })
      return { revision: 7 }
    },
  }
  return { root, store, binding, config, syncCalls, taskSync }
}

function command(type, payload) {
  return {
    id: `command-${type}`,
    bindingId: 'binding-1',
    type,
    payload: {
      taskSpaceId: 'space-1',
      projectId: 'project-1',
      branchName: 'main',
      ...payload,
    },
  }
}

test('创建任务允许无关文件 dirty，并通过同一快照同步上传完整目录', async () => {
  const repo = createRepository()
  let setupResult
  try {
    setupResult = await setup(repo)
    write(path.join(repo.local, 'notes.txt'), '本地无关草稿\n')
    const executor = new AgentTaskCommandExecutor({
      store: setupResult.store,
      taskSync: setupResult.taskSync,
      loadContext: async () => ({ config: setupResult.config }),
    })
    const result = await executor.execute(
      command('create_task', {
        title: '客户端任务',
        description: '由在线 Agent 创建',
        priority: 'P2',
        slug: 'client-created',
        assigneeUserId: 'user-b',
        assigneeDevId: 'bob',
      }),
    )
    assert.equal(result.taskId, 'client-created')
    assert.equal(result.relativeDir, '.trellis/tasks/client-created')
    assert.equal(result.revision, 7)
    assert.deepEqual(setupResult.syncCalls[0].taskDirs, ['.trellis/tasks/client-created'])
    assert.equal(setupResult.syncCalls[0].options, undefined)
    assert.equal(fs.existsSync(path.join(repo.local, 'notes.txt')), true)
    const task = JSON.parse(
      fs.readFileSync(
        path.join(repo.local, '.trellis', 'tasks', 'client-created', 'task.json'),
        'utf8',
      ),
    )
    assert.equal(task.assignee, 'bob')
  } finally {
    if (setupResult) fs.rmSync(setupResult.root, { recursive: true, force: true })
    fs.rmSync(repo.base, { recursive: true, force: true })
  }
})

test('创建命令重试命中已生成任务时复用本地游标基线', async () => {
  const repo = createRepository()
  let setupResult
  try {
    setupResult = await setup(repo)
    const taskDir = '.trellis/tasks/client-created'
    write(
      path.join(repo.local, ...taskDir.split('/'), 'task.json'),
      `${JSON.stringify({
        id: 'client-created',
        title: '客户端任务',
        status: 'planning',
        assignee: 'bob',
        priority: 'P2',
      })}\n`,
    )
    const executor = new AgentTaskCommandExecutor({
      store: setupResult.store,
      taskSync: setupResult.taskSync,
      loadContext: async () => ({ config: setupResult.config }),
    })
    const result = await executor.execute(
      command('create_task', {
        title: '客户端任务',
        slug: 'client-created',
        assigneeUserId: 'user-b',
        assigneeDevId: 'bob',
      }),
    )
    assert.equal(result.taskId, 'client-created')
    assert.deepEqual(setupResult.syncCalls[0].taskDirs, [taskDir])
    assert.equal(setupResult.syncCalls[0].options, undefined)
  } finally {
    if (setupResult) fs.rmSync(setupResult.root, { recursive: true, force: true })
    fs.rmSync(repo.base, { recursive: true, force: true })
  }
})

test('改派只更新 task.json，并以服务端基线摘要 CAS 上传', async () => {
  const repo = createRepository()
  let setupResult
  try {
    const taskJson = `${JSON.stringify(
      {
        id: 'task-1',
        title: '待改派任务',
        status: 'planning',
        assignee: 'alice',
        priority: 'P2',
      },
      null,
      2,
    )}\n`
    write(path.join(repo.local, '.trellis', 'tasks', '01-dispatch', 'task.json'), taskJson)
    runGit(repo.local, ['add', '.trellis/tasks/01-dispatch/task.json'])
    runGit(repo.local, ['commit', '-m', 'add dispatch task'])
    setupResult = await setup(repo)
    write(path.join(repo.local, 'README.md'), 'unrelated local edit\n')
    const remoteSha = snapshotSha256(taskJson)
    const api = {
      async fetchTaskDirectory(taskSpaceId, taskDir) {
        assert.equal(taskSpaceId, 'space-1')
        assert.equal(taskDir, '.trellis/tasks/01-dispatch')
        return {
          files: [
            {
              path: '.trellis/tasks/01-dispatch/task.json',
              sha256: remoteSha,
            },
          ],
        }
      },
    }
    const executor = new AgentTaskCommandExecutor({
      store: setupResult.store,
      taskSync: setupResult.taskSync,
      loadContext: async () => ({ config: setupResult.config, api }),
    })
    const result = await executor.execute(
      command('assign_task', {
        executionTaskKey: 'space-1::task-1',
        taskKey: 'space-1::.trellis/tasks/01-dispatch',
        relativeDir: '.trellis/tasks/01-dispatch',
        assigneeUserId: 'user-b',
        assigneeDevId: 'bob',
        baseTaskSha256: remoteSha,
      }),
    )
    assert.equal(result.assignee, 'bob')
    const updated = JSON.parse(
      fs.readFileSync(
        path.join(repo.local, '.trellis', 'tasks', '01-dispatch', 'task.json'),
        'utf8',
      ),
    )
    assert.equal(updated.assignee, 'bob')
    assert.deepEqual(setupResult.syncCalls[0].options.baseShaByPath, {
      '.trellis/tasks/01-dispatch/task.json': remoteSha,
    })
  } finally {
    if (setupResult) fs.rmSync(setupResult.root, { recursive: true, force: true })
    fs.rmSync(repo.base, { recursive: true, force: true })
  }
})

test('目标目录 dirty 或存在中断 Git 操作时拒绝执行命令', async () => {
  const repo = createRepository()
  let setupResult
  try {
    const taskJson = `${JSON.stringify({
      id: 'task-1',
      title: '待改派任务',
      status: 'planning',
      assignee: 'alice',
      priority: 'P2',
    })}\n`
    write(path.join(repo.local, '.trellis', 'tasks', '01-dispatch', 'task.json'), taskJson)
    runGit(repo.local, ['add', '.trellis/tasks/01-dispatch/task.json'])
    runGit(repo.local, ['commit', '-m', 'add dispatch task'])
    setupResult = await setup(repo)
    const executor = new AgentTaskCommandExecutor({
      store: setupResult.store,
      taskSync: setupResult.taskSync,
      loadContext: async () => ({ config: setupResult.config, api: {} }),
    })
    write(path.join(repo.local, '.trellis', 'tasks', '01-dispatch', 'task.json'), `${taskJson} `)
    await assert.rejects(
      () =>
        executor.execute(
          command('assign_task', {
            relativeDir: '.trellis/tasks/01-dispatch',
            assigneeUserId: 'user-b',
            assigneeDevId: 'bob',
          }),
        ),
      /目标任务目录有未提交修改/,
    )
    write(path.join(repo.local, '.trellis', 'tasks', '01-dispatch', 'task.json'), taskJson)
    write(path.join(repo.local, '.git', 'MERGE_HEAD'), `${'f'.repeat(40)}\n`)
    await assert.rejects(
      () =>
        executor.execute(
          command('create_task', {
            title: '不会创建',
            slug: 'must-not-create',
            assigneeUserId: 'user-b',
            assigneeDevId: 'bob',
          }),
        ),
      /未完成的合并操作/,
    )
    assert.equal(
      fs.existsSync(path.join(repo.local, '.trellis', 'tasks', 'must-not-create')),
      false,
    )
  } finally {
    if (setupResult) fs.rmSync(setupResult.root, { recursive: true, force: true })
    fs.rmSync(repo.base, { recursive: true, force: true })
  }
})
