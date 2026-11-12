import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { ConfigStore } from '../config-store.js'
import {
  attachProject,
  checkInitialPush,
  initializeProject,
  inspectProject,
  preflightProject,
} from '../project-onboarding.js'

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

function createRepository({ withTrellis = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-onboarding-'))
  const remote = path.join(base, 'remote.git')
  const seed = path.join(base, 'seed')
  const local = path.join(base, 'local')
  fs.mkdirSync(seed, { recursive: true })
  runGit(base, ['init', '--bare', '--initial-branch=main', remote])
  runGit(seed, ['init', '-b', 'main'])
  runGit(seed, ['config', 'user.email', 'agent-test@example.invalid'])
  runGit(seed, ['config', 'user.name', 'Agent Test'])
  write(path.join(seed, 'README.md'), 'initial\n')
  if (withTrellis) {
    write(path.join(seed, '.trellis', 'tasks', '.keep'), 'tasks\n')
  }
  runGit(seed, ['add', '.'])
  runGit(seed, ['commit', '-m', 'initial'])
  const remoteUrl = pathToFileURL(remote).href
  runGit(seed, ['remote', 'add', 'origin', remoteUrl])
  runGit(seed, ['push', '-u', 'origin', 'main'])
  runGit(base, ['clone', remoteUrl, local])
  runGit(local, ['config', 'user.email', 'agent-test@example.invalid'])
  runGit(local, ['config', 'user.name', 'Agent Test'])
  return { base, remote, seed, local, remoteUrl }
}

function hooksDir(base) {
  return path.join(base, 'hooks')
}

test('项目预检只接受 Git 根目录，并区分已有和缺失 Trellis', async () => {
  const existing = createRepository()
  const missing = createRepository({ withTrellis: false })
  try {
    const existingResult = await inspectProject({
      repoPath: existing.local,
      hooksDir: hooksDir(existing.base),
      allowFileRemote: true,
    })
    assert.equal(existingResult.root, fs.realpathSync.native(existing.local))
    assert.equal(existingResult.hasTrellis, true)
    assert.equal(existingResult.hasTasks, true)
    assert.equal(existingResult.hasCommittedTrellis, true)
    assert.equal(existingResult.requiresInitialization, false)
    assert.equal(existingResult.branchName, 'main')

    const missingResult = await inspectProject({
      repoPath: missing.local,
      hooksDir: hooksDir(missing.base),
      allowFileRemote: true,
    })
    assert.equal(missingResult.hasTrellis, false)
    assert.equal(missingResult.hasCommittedTrellis, false)
    assert.equal(missingResult.requiresInitialization, true)

    await assert.rejects(
      () =>
        inspectProject({
          repoPath: path.join(existing.local, '.trellis'),
          hooksDir: hooksDir(existing.base),
          allowFileRemote: true,
        }),
      /仓库根目录/,
    )
  } finally {
    fs.rmSync(existing.base, { recursive: true, force: true })
    fs.rmSync(missing.base, { recursive: true, force: true })
  }
})

test('全新 Git 仓库没有首个提交时仍可预检和初始化', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-unborn-'))
  const local = path.join(base, 'empty')
  const remote = path.join(base, 'empty.git')
  try {
    fs.mkdirSync(local, { recursive: true })
    runGit(base, ['init', '--bare', '--initial-branch=main', remote])
    runGit(local, ['init', '-b', 'main'])
    runGit(local, ['remote', 'add', 'origin', pathToFileURL(remote).href])
    const inspected = await inspectProject({
      repoPath: local,
      hooksDir: hooksDir(base),
      allowFileRemote: true,
    })
    assert.equal(inspected.head, null)
    assert.equal(inspected.hasTrellis, false)
    const initialized = await initializeProject({
      repoPath: local,
      hooksDir: hooksDir(base),
      developerId: 'alice',
      agentTools: ['codex'],
      allowFileRemote: true,
      initialize: async ({ repoPath }) => {
        write(path.join(repoPath, '.trellis', 'tasks', '.keep'), 'tasks\n')
        write(path.join(repoPath, '.codex', '.keep'), 'codex\n')
      },
    })
    assert.equal(initialized.hasTrellis, true)
    assert.equal(initialized.hasTasks, true)
    assert.equal(initialized.hasCommittedTrellis, false)
    const push = await checkInitialPush({
      repoPath: local,
      branchName: 'main',
      hooksDir: hooksDir(base),
      allowFileRemote: true,
    })
    assert.equal(push.state, 'waiting_commit')
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('初始化只在缺失 Trellis 或本机缺少所选 Agent 工具时调用', async () => {
  const repo = createRepository()
  try {
    const calls = []
    const initialize = async ({ repoPath, developerId, agentTools }) => {
      calls.push({ repoPath, developerId, agentTools })
      write(path.join(repoPath, '.trellis', 'tasks', '.keep'), 'tasks\n')
      for (const tool of agentTools) {
        if (tool === 'codex') write(path.join(repoPath, '.codex', '.keep'), 'codex\n')
        if (tool === 'opencode') write(path.join(repoPath, '.opencode', '.keep'), 'opencode\n')
      }
    }

    const first = await initializeProject({
      repoPath: repo.local,
      hooksDir: hooksDir(repo.base),
      developerId: 'alice',
      agentTools: ['codex'],
      allowFileRemote: true,
      initialize,
    })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].agentTools, ['codex'])
    assert.deepEqual(first.existingAgentTools, ['codex'])

    await initializeProject({
      repoPath: repo.local,
      hooksDir: hooksDir(repo.base),
      developerId: 'alice',
      agentTools: ['codex'],
      allowFileRemote: true,
      initialize,
    })
    assert.equal(calls.length, 1)

    const second = await initializeProject({
      repoPath: repo.local,
      hooksDir: hooksDir(repo.base),
      developerId: 'alice',
      agentTools: ['codex', 'opencode'],
      allowFileRemote: true,
      initialize,
    })
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1].agentTools, ['codex', 'opencode'])
    assert.deepEqual(second.existingAgentTools.sort(), ['codex', 'opencode'])
  } finally {
    fs.rmSync(repo.base, { recursive: true, force: true })
  }
})

test('首次推送检测区分未提交、未推送、已就绪、远端领先和无法确认', async () => {
  const repo = createRepository()
  try {
    write(path.join(repo.local, '.trellis', 'tasks', '.keep'), 'uncommitted\n')
    const waitingCommit = await checkInitialPush({
      repoPath: repo.local,
      branchName: 'main',
      hooksDir: hooksDir(repo.base),
      allowFileRemote: true,
    })
    assert.equal(waitingCommit.state, 'waiting_commit')

    runGit(repo.local, ['add', '.trellis/tasks/.keep'])
    runGit(repo.local, ['commit', '-m', 'update trellis'])
    const waitingPush = await checkInitialPush({
      repoPath: repo.local,
      branchName: 'main',
      hooksDir: hooksDir(repo.base),
      allowFileRemote: true,
    })
    assert.equal(waitingPush.state, 'waiting_push')
    assert.equal(waitingPush.localAhead, 1)
    assert.equal(waitingPush.remoteAhead, 0)

    runGit(repo.local, ['push', 'origin', 'main'])
    const ready = await checkInitialPush({
      repoPath: repo.local,
      branchName: 'main',
      hooksDir: hooksDir(repo.base),
      allowFileRemote: true,
    })
    assert.equal(ready.state, 'ready')
    assert.equal(ready.localHead, ready.remoteHead)

    runGit(repo.seed, ['fetch', 'origin', 'main'])
    runGit(repo.seed, ['merge', '--ff-only', 'FETCH_HEAD'])
    write(path.join(repo.seed, '.trellis', 'tasks', 'remote-only.txt'), 'remote\n')
    runGit(repo.seed, ['add', '.trellis/tasks/remote-only.txt'])
    runGit(repo.seed, ['commit', '-m', 'remote update'])
    runGit(repo.seed, ['push', 'origin', 'main'])
    const remoteAhead = await checkInitialPush({
      repoPath: repo.local,
      branchName: 'main',
      hooksDir: hooksDir(repo.base),
      allowFileRemote: true,
    })
    assert.equal(remoteAhead.state, 'remote_ahead')
    assert.equal(remoteAhead.localAhead, 0)
    assert.equal(remoteAhead.remoteAhead, 1)

    runGit(repo.local, [
      'remote',
      'set-url',
      'origin',
      pathToFileURL(path.join(repo.base, 'missing.git')).href,
    ])
    const unreachable = await checkInitialPush({
      repoPath: repo.local,
      branchName: 'main',
      hooksDir: hooksDir(repo.base),
      allowFileRemote: true,
    })
    assert.equal(unreachable.state, 'unable_to_verify')
    assert.match(unreachable.message, /无法连接远端/)
  } finally {
    fs.rmSync(repo.base, { recursive: true, force: true })
  }
})

test('项目预检只读比较任务元数据，不建立 binding 或游标', async () => {
  const repo = createRepository()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-preflight-agent-'))
  try {
    const localTask = path.join(repo.local, '.trellis', 'tasks', '01-local', 'task.json')
    write(localTask, `${JSON.stringify({ id: 'local-task', title: '本地任务' })}\n`)
    const store = new ConfigStore(root, { secureDirectory: false })
    await store.saveConfig({
      schemaVersion: 2,
      revision: 'a'.repeat(32),
      serverUrl: 'http://127.0.0.1:4317',
      caFile: null,
      agentId: 'agent-1',
      deviceName: '测试设备',
      username: 'alice',
      teamId: null,
      teams: [{ id: 'team-1', name: '团队一', role: 'member' }],
      protocolVersion: 3,
      agentVersion: '0.1.0',
      pairedAt: new Date().toISOString(),
      bindings: [],
    })
    let mode = 'new'
    const calls = []
    const api = {
      async preflightTaskSpaceAccess(input) {
        calls.push(['preflight', input])
        if (mode === 'new') {
          return { status: 'new', revision: 0, tasks: [] }
        }
        return {
          status: 'existing',
          revision: 3,
          tasks: [
            {
              taskId: 'server-task',
              taskDir: '.trellis/tasks/02-server',
              files: [
                {
                  path: '.trellis/tasks/02-server/task.json',
                  sha256: 'f'.repeat(64),
                },
              ],
            },
          ],
        }
      },
      async attachTaskSpace() {
        throw new Error('预检不能调用 attach')
      },
    }

    const empty = await preflightProject({
      api,
      repoPath: repo.local,
      hooksDir: hooksDir(repo.base),
      teamId: 'team-1',
      allowFileRemote: true,
    })
    assert.equal(empty.status, 'new')
    assert.equal(empty.counts.localOnly, 1)
    assert.equal(empty.counts.serverOnly, 0)

    mode = 'existing'
    const existing = await preflightProject({
      api,
      repoPath: repo.local,
      hooksDir: hooksDir(repo.base),
      teamId: 'team-1',
      allowFileRemote: true,
    })
    assert.equal(existing.status, 'existing')
    assert.equal(existing.counts.localOnly, 1)
    assert.equal(existing.counts.serverOnly, 1)
    assert.deepEqual(
      calls.map(([name]) => name),
      ['preflight', 'preflight'],
    )
    assert.deepEqual((await store.readConfig()).bindings, [])
    assert.equal(fs.existsSync(store.paths.liveCursorsFile), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(repo.base, { recursive: true, force: true })
  }
})

test('接入项目只有在调用 attach 后才建立本地 binding', async () => {
  const repo = createRepository()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-onboarding-agent-'))
  try {
    const store = new ConfigStore(root, { secureDirectory: false })
    const inspected = await inspectProject({
      repoPath: repo.local,
      hooksDir: hooksDir(repo.base),
      allowFileRemote: true,
    })
    const calls = []
    const api = {
      async attachTaskSpace(input) {
        calls.push(['attach', input])
        return {
          project: {
            id: 'project-1',
            name: '测试项目',
            ownerTeamId: 'team-1',
          },
          taskSpace: {
            id: 'space-1',
            branchName: 'main',
          },
          binding: {
            id: 'binding-1',
            status: 'approved',
            readOnly: false,
          },
        }
      },
    }
    await store.saveConfig({
      schemaVersion: 2,
      revision: 'a'.repeat(32),
      serverUrl: 'http://127.0.0.1:4317',
      caFile: null,
      agentId: 'agent-1',
      deviceName: '测试设备',
      username: 'alice',
      teamId: null,
      teams: [{ id: 'team-1', name: '团队一', role: 'member' }],
      protocolVersion: 3,
      agentVersion: '0.1.0',
      pairedAt: new Date().toISOString(),
      bindings: [],
    })
    const result = await attachProject({
      api,
      store,
      repoPath: repo.local,
      hooksDir: hooksDir(repo.base),
      teamId: 'team-1',
      developerId: 'alice',
      allowFileRemote: true,
      initialSyncMode: 'review',
    })
    assert.equal(result.status, 'attached')
    assert.deepEqual(
      calls.map(([name]) => name),
      ['attach'],
    )
    assert.equal(calls[0][1].branchName, 'main')
    assert.equal(calls[0][1].localRepoKey, inspected.localRepoKey)
    const config = await store.readConfig()
    assert.equal(config.bindings.length, 1)
    assert.equal(config.bindings[0].taskSpaceId, 'space-1')
    assert.equal(config.bindings[0].serverBindingId, 'binding-1')
    assert.equal(config.bindings[0].syncStatus, 'approved')
    assert.equal(config.bindings[0].initialSyncMode, 'review')
    assert.equal(config.bindings[0].initialSyncCompleted, false)
    assert.equal(config.bindings[0].initialReviewPending, true)

    await attachProject({
      api: {
        async attachTaskSpace() {
          return {
            project: {
              id: 'project-1',
              name: '测试项目',
              ownerTeamId: 'team-1',
            },
            taskSpace: {
              id: 'space-2',
              branchName: 'main',
            },
            binding: {
              id: 'binding-2',
              status: 'approved',
              readOnly: false,
            },
          }
        },
      },
      store,
      repoPath: repo.local,
      hooksDir: hooksDir(repo.base),
      teamId: 'team-1',
      developerId: 'alice',
      allowFileRemote: true,
      initialSyncMode: 'safe',
    })
    const replaced = await store.readConfig()
    assert.equal(replaced.bindings.length, 1)
    assert.equal(replaced.bindings[0].taskSpaceId, 'space-2')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(repo.base, { recursive: true, force: true })
  }
})
