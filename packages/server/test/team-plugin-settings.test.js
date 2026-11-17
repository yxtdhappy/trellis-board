import test from 'node:test'
import assert from 'node:assert/strict'
import { createPluginSettings } from '../team/plugins/settings.js'
import { syncRegistry } from '../team/plugins/registry.js'
import {
  cleanupWorkspace,
  makePluginWorkspace,
  openPluginWorkspaceDatabase,
  seedTeamPluginFixtures,
} from '@trellis-board/test-support/team-plugin-fixtures.js'

async function withSettings(fn) {
  const workspace = makePluginWorkspace()
  const db = openPluginWorkspaceDatabase(workspace)
  try {
    const fixtures = await seedTeamPluginFixtures(db)
    db.prepare(
      `
      INSERT INTO plugin_registry(
        plugin_id, name, version, api_version, description, manifest_json, source_path,
        enabled, default_scope, discovered_at, updated_at
      ) VALUES ('witops-core', 'WitOps 核心能力', '2.0.0', 1, '', '{}', '/tmp/witops-core',
        1, 'user', '2026-11-16T00:00:00.000Z', '2026-11-16T00:00:00.000Z')
    `,
    ).run()
    const settings = createPluginSettings({
      db,
      now: () => '2026-11-16T01:00:00.000Z',
    })
    await fn({ db, fixtures, settings, workspace })
  } finally {
    cleanupWorkspace(workspace, db)
  }
}

test('团队配置 upsert 后可读回', async () => {
  await withSettings(({ settings, fixtures }) => {
    const created = settings.setTeamSetting({
      teamId: 'team-a',
      pluginId: 'witops-core',
      enabled: true,
      config: { baseUrl: 'https://witops.example.com', types: '0,1,5' },
      actorUserId: fixtures.admin.id,
    })
    assert.equal(created.enabled, true)
    assert.equal(created.config.baseUrl, 'https://witops.example.com')

    const updated = settings.setTeamSetting({
      teamId: 'team-a',
      pluginId: 'witops-core',
      enabled: false,
      config: { baseUrl: 'https://other.example.com' },
    })
    assert.equal(updated.enabled, false)
    assert.equal(settings.listTeamSettings('team-a').length, 1)
    assert.equal(settings.getTeamSetting('team-b', 'witops-core'), null)
  })
})

test('用户配置只接受白名单字段', async () => {
  await withSettings(({ settings, fixtures }) => {
    const fields = ['defaultProjectId', 'lastTaskSpaceId']
    assert.throws(
      () =>
        settings.setUserConfig({
          userId: fixtures.lead.id,
          pluginId: 'witops-core',
          config: { unknownField: 'project-a' },
          fields,
        }),
      (error) => error.code === 'INVALID_INPUT',
    )
    const saved = settings.setUserConfig({
      userId: fixtures.lead.id,
      pluginId: 'witops-core',
      config: { defaultProjectId: 'project-a' },
      fields,
      status: 'active',
    })
    assert.equal(saved.config.defaultProjectId, 'project-a')
    assert.equal(saved.status, 'active')
  })
})

test('未声明 userConfigFields 的插件只接受空配置', async () => {
  await withSettings(({ settings, fixtures }) => {
    assert.throws(
      () =>
        settings.setUserConfig({
          userId: fixtures.lead.id,
          pluginId: 'witops-core',
          config: { anything: 1 },
          fields: [],
        }),
      (error) => error.code === 'INVALID_INPUT',
    )
    const saved = settings.setUserConfig({
      userId: fixtures.lead.id,
      pluginId: 'witops-core',
      config: {},
      fields: [],
    })
    assert.deepEqual(saved.config, {})
  })
})

test('配置大小超限会被拒绝', async () => {
  await withSettings(({ settings, fixtures }) => {
    assert.throws(
      () =>
        settings.setUserConfig({
          userId: fixtures.lead.id,
          pluginId: 'witops-core',
          config: { defaultProjectId: 'x'.repeat(9000) },
          fields: ['defaultProjectId'],
        }),
      (error) => error.code === 'INVALID_INPUT',
    )
  })
})

test('describeUserPlugin 不回显敏感值，只合并会话状态', async () => {
  await withSettings(({ settings, fixtures }) => {
    settings.setUserStatus({
      userId: fixtures.lead.id,
      pluginId: 'witops-core',
      status: 'active',
    })
    const withoutSession = settings.describeUserPlugin(fixtures.lead.id, 'witops-core')
    assert.equal(withoutSession.configured, true)
    assert.equal(withoutSession.online, false)
    assert.equal(withoutSession.lastLoginAt, null)

    const withSession = settings.describeUserPlugin(fixtures.lead.id, 'witops-core', {
      session: { createdAt: 1_700_000_000_000, account: 'zh***an' },
    })
    assert.equal(withSession.online, true)
    const serialized = JSON.stringify(withSession)
    assert.equal(serialized.includes('token'), false)
    assert.equal(serialized.includes('password'), false)
  })
})

test('删除用户后其插件配置级联清理', async () => {
  await withSettings(({ db, settings, fixtures }) => {
    settings.setUserStatus({
      userId: fixtures.member.id,
      pluginId: 'witops-core',
      status: 'active',
    })
    assert.equal(
      db
        .prepare('SELECT COUNT(*) AS count FROM plugin_user_config WHERE user_id = ?')
        .get(fixtures.member.id).count,
      1,
    )
    db.prepare('DELETE FROM user_account WHERE id = ?').run(fixtures.member.id)
    assert.equal(
      db
        .prepare('SELECT COUNT(*) AS count FROM plugin_user_config WHERE user_id = ?')
        .get(fixtures.member.id).count,
      0,
    )
  })
})

test('syncRegistry 与 settings 共用同一库时字段对齐', async () => {
  await withSettings(({ db }) => {
    const result = syncRegistry(db, [
      {
        id: 'acp-dispatch',
        name: 'ACP 调度',
        version: '1.0.0',
        apiVersion: 1,
        description: '',
        manifest: { id: 'acp-dispatch' },
        sourcePath: '/tmp/acp-dispatch',
      },
    ])
    assert.deepEqual(result.inserted, ['acp-dispatch'])
  })
})
