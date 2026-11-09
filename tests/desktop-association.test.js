import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ConfigStore } from '../agent/config-store.js'
import { associateDesktopProject } from '../desktop/sidecar/desktop-association.js'
import { readLocalAssociations } from '../desktop/sidecar/desktop-device.js'

test('桌面项目关联写入本地配置并持久化服务端只读状态', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-associate-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new ConfigStore(root, { secureDirectory: false })
  await store.saveConfig({
    schemaVersion: 1,
    revision: 'a'.repeat(32),
    serverUrl: 'http://127.0.0.1:4317',
    caFile: null,
    agentId: 'agent-1',
    deviceName: '测试设备',
    username: 'alice',
    teamId: null,
    teams: [{ id: 'team-1', name: '团队一', role: 'member' }],
    protocolVersion: 2,
    agentVersion: '0.1.0',
    pairedAt: new Date().toISOString(),
    bindings: [],
  })
  const result = await associateDesktopProject({
    projectId: 'project-1',
    repoPath: root,
    branchName: 'main',
    store,
    credentialStore: {
      async loadCredential() {
        return 'x'.repeat(43)
      },
    },
    inspectRepository: async () => ({
      root,
      localRepoKey: 'b'.repeat(64),
      branchName: 'main',
      currentBranch: 'main',
      head: 'c'.repeat(40),
      clean: true,
      dirtySummary: '',
      remoteIdentityKey: 'd'.repeat(64),
    }),
    apiClientFactory: () => ({
      async heartbeat(input) {
        assert.equal(input.bindings[0].projectId, 'project-1')
        assert.equal(input.bindings[0].remoteIdentityKey, 'd'.repeat(64))
        return {
          bindings: [
            {
              id: 'binding-1',
              projectId: 'project-1',
              teamId: 'team-1',
              status: 'approved',
              readOnly: true,
            },
          ],
        }
      },
    }),
  })
  assert.equal(result.status, 'approved')
  assert.equal(result.readOnly, true)
  assert.equal(result.liveSyncStatus, 'pending')
  assert.equal(result.liveSyncError, null)
  const config = await store.readConfig({ allowMissing: false })
  assert.equal(config.bindings.length, 1)
  assert.equal(config.bindings[0].serverBindingId, 'binding-1')
  assert.equal(config.bindings[0].syncStatus, 'approved')
  assert.equal(config.bindings[0].readOnly, true)
  assert.equal(config.bindings[0].liveSyncStatus, 'pending')
  assert.equal(config.bindings[0].liveSyncError, null)
  const associations = await readLocalAssociations(root)
  assert.equal(associations[0].liveSyncStatus, 'pending')
  assert.equal(associations[0].liveSyncError, null)
  assert.ok(!fs.readFileSync(store.paths.configFile, 'utf8').includes('x'.repeat(43)))
})

test('服务端拒绝关联时回滚本地绑定', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-associate-reject-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const store = new ConfigStore(root, { secureDirectory: false })
  await store.saveConfig({
    schemaVersion: 1,
    revision: 'e'.repeat(32),
    serverUrl: 'http://127.0.0.1:4317',
    caFile: null,
    agentId: 'agent-2',
    deviceName: '测试设备',
    username: 'alice',
    teamId: null,
    teams: [{ id: 'team-1', name: '团队一', role: 'member' }],
    protocolVersion: 2,
    agentVersion: '0.1.0',
    pairedAt: new Date().toISOString(),
    bindings: [],
  })
  await assert.rejects(
    associateDesktopProject({
      projectId: 'project-2',
      repoPath: root,
      branchName: 'main',
      store,
      credentialStore: {
        async loadCredential() {
          return 'y'.repeat(43)
        },
      },
      inspectRepository: async () => ({
        root,
        localRepoKey: 'f'.repeat(64),
        branchName: 'main',
        currentBranch: 'main',
        head: '1'.repeat(40),
        clean: true,
        dirtySummary: '',
        remoteIdentityKey: '2'.repeat(64),
      }),
      apiClientFactory: () => ({
        async heartbeat() {
          return {
            bindings: [
              {
                id: 'rejected-binding',
                projectId: 'project-2',
                teamId: 'team-1',
                status: 'rejected',
                readOnly: false,
                errorCode: 'REMOTE_MISMATCH',
                error: '本地仓库远端与项目不一致',
              },
            ],
          }
        },
      }),
    }),
    (error) => error.code === 'REMOTE_MISMATCH' && /远端与项目不一致/.test(error.message),
  )
  const config = await store.readConfig({ allowMissing: false })
  assert.deepEqual(config.bindings, [])
})
