import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import { ConfigStore } from '../agent/config-store.js'
import {
  associateDesktopProject,
  preflightDesktopProject,
} from '../desktop/sidecar/desktop-association.js'
import { readLocalAssociations } from '../desktop/sidecar/desktop-device.js'

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`)
  }
  return result.stdout.trim()
}

function createRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-desktop-association-'))
  const remote = path.join(root, 'remote.git')
  const local = path.join(root, 'repo')
  git(root, ['init', '--bare', '--initial-branch=main', remote])
  fs.mkdirSync(path.join(local, '.trellis', 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(local, '.trellis', 'tasks', '.keep'), 'tasks\n')
  git(local, ['init', '-b', 'main'])
  git(local, ['config', 'user.email', 'desktop-test@example.invalid'])
  git(local, ['config', 'user.name', 'Desktop Test'])
  git(local, ['add', '.trellis/tasks/.keep'])
  git(local, ['commit', '-m', 'initialize trellis tasks'])
  git(local, ['remote', 'add', 'origin', pathToFileURL(remote).href])
  git(local, ['push', '-u', 'origin', 'main'])
  return { root, local }
}

async function createStore(root, allowLocalGitRemotes = true) {
  const store = new ConfigStore(path.join(root, 'agent'), { secureDirectory: false })
  await store.saveConfig({
    schemaVersion: 2,
    revision: 'a'.repeat(32),
    serverUrl: 'http://127.0.0.1:4317',
    caFile: null,
    allowLocalGitRemotes,
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
  return store
}

test('团队服务关闭本地远端时客户端拒绝 file origin', async (t) => {
  const repository = createRepository()
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }))
  const store = await createStore(repository.root, false)
  await assert.rejects(
    () =>
      associateDesktopProject({
        teamId: 'team-1',
        developerId: 'alice',
        repoPath: repository.local,
        branchName: 'main',
        initialSyncMode: 'review',
        store,
        credentialStore: {
          async loadCredential() {
            return 'x'.repeat(43)
          },
        },
        apiClientFactory: () => ({
          async attachTaskSpace() {
            throw new Error('本地远端关闭时不应调用 attach')
          },
        }),
      }),
    /Git 远端只允许 HTTPS、SSH 或受控测试的 file URL/,
  )
})

test('桌面接入选择本地 Git 项目并持久化任务空间绑定', async (t) => {
  const repository = createRepository()
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }))
  const store = await createStore(repository.root)
  const calls = []
  const result = await associateDesktopProject({
    teamId: 'team-1',
    developerId: 'alice',
    repoPath: repository.local,
    branchName: 'main',
    initialSyncMode: 'review',
    store,
    credentialStore: {
      async loadCredential() {
        return 'x'.repeat(43)
      },
    },
    apiClientFactory: () => ({
      async attachTaskSpace(input) {
        calls.push(['attach', input])
        return {
          project: { id: 'project-1', name: '示例项目', ownerTeamId: 'team-1' },
          taskSpace: { id: 'space-1', branchName: 'main' },
          binding: {
            id: 'binding-1',
            taskSpaceId: 'space-1',
            branchName: 'main',
            status: 'approved',
            readOnly: true,
          },
        }
      },
    }),
  })
  assert.equal(result.projectId, 'project-1')
  assert.equal(result.taskSpaceId, 'space-1')
  assert.equal(result.readOnly, true)
  assert.equal(result.liveSyncStatus, 'syncing')
  assert.equal(calls[0][0], 'attach')
  const config = await store.readConfig({ allowMissing: false })
  assert.equal(config.bindings.length, 1)
  assert.equal(config.bindings[0].serverBindingId, 'binding-1')
  assert.equal(config.bindings[0].taskSpaceId, 'space-1')
  assert.equal(config.bindings[0].initialSyncMode, 'review')
  assert.equal(config.bindings[0].initialSyncCompleted, false)
  const associations = await readLocalAssociations(store.paths.root)
  assert.equal(associations[0].taskSpaceId, 'space-1')
  assert.equal(associations[0].deferredCount, 0)
  assert.deepEqual(associations[0].deferredTaskDirs, [])
  fs.writeFileSync(
    store.paths.liveCursorsFile,
    `${JSON.stringify({
      version: 3,
      taskSpaces: {
        'space-1': {
          deferred: {
            '.trellis/tasks/task-b': {},
            '.trellis/tasks/task-a': {},
            'outside/tasks/task-c': {},
          },
        },
      },
    })}\n`,
  )
  const deferred = await readLocalAssociations(store.paths.root)
  assert.equal(deferred[0].deferredCount, 2)
  assert.deepEqual(deferred[0].deferredTaskDirs, ['.trellis/tasks/task-a', '.trellis/tasks/task-b'])
  fs.writeFileSync(store.paths.liveCursorsFile, '{broken')
  const malformed = await readLocalAssociations(store.paths.root)
  assert.equal(malformed[0].deferredCount, 0)
  assert.deepEqual(malformed[0].deferredTaskDirs, [])
  assert.ok(!fs.readFileSync(store.paths.configFile, 'utf8').includes('x'.repeat(43)))
})

test('桌面预检遇到团队未授权时只返回只读结果，不建立本地 binding', async (t) => {
  const repository = createRepository()
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }))
  const store = await createStore(repository.root)
  const result = await preflightDesktopProject({
    teamId: 'team-2',
    repoPath: repository.local,
    store,
    credentialStore: {
      async loadCredential() {
        return 'y'.repeat(43)
      },
    },
    apiClientFactory: () => ({
      async preflightTaskSpaceAccess() {
        return {
          status: 'access_required',
          project: { id: 'project-1', name: '已存在项目' },
          tasks: [],
        }
      },
    }),
  })
  assert.equal(result.status, 'access_required')
  assert.deepEqual((await store.readConfig({ allowMissing: false })).bindings, [])
})

test('桌面接入期间切换分支时拒绝沿用预检分支', async (t) => {
  const repository = createRepository()
  t.after(() => fs.rmSync(repository.root, { recursive: true, force: true }))
  const store = await createStore(repository.root)
  git(repository.local, ['branch', 'feature/onboarding-race'])

  await assert.rejects(
    () =>
      associateDesktopProject({
        teamId: 'team-1',
        developerId: 'alice',
        repoPath: repository.local,
        branchName: 'feature/onboarding-race',
        initialSyncMode: 'safe',
        store,
        credentialStore: {
          async loadCredential() {
            return 'z'.repeat(43)
          },
        },
        apiClientFactory: () => ({
          async attachTaskSpace() {
            throw new Error('分支不一致时不应调用服务端 attach')
          },
        }),
      }),
    /当前分支为 main，期望 feature\/onboarding-race/,
  )
  assert.deepEqual((await store.readConfig({ allowMissing: false })).bindings, [])
})
