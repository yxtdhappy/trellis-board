import test from 'node:test'
import assert from 'node:assert/strict'
import { createPluginPolicy } from '../team/plugins/policy.js'
import {
  actorFor,
  cleanupWorkspace,
  makePluginWorkspace,
  openPluginWorkspaceDatabase,
  seedTeamPluginFixtures,
} from '@trellis-board/test-support/team-plugin-fixtures.js'

const PLUGIN = 'witops-core'
const OTHER = 'acp-dispatch'

async function withPolicy(fn) {
  const workspace = makePluginWorkspace()
  const db = openPluginWorkspaceDatabase(workspace)
  try {
    const fixtures = await seedTeamPluginFixtures(db)
    const stamp = '2026-11-16T00:00:00.000Z'
    const insert = db.prepare(`
      INSERT INTO plugin_registry(
        plugin_id, name, version, api_version, description, manifest_json, source_path,
        enabled, default_scope, discovered_at, updated_at
      ) VALUES (?, ?, '2.0.0', 1, '', '{}', ?, ?, 'user', ?, ?)
    `)
    insert.run(PLUGIN, 'WitOps 核心能力', '/tmp/witops-core', 1, stamp, stamp)
    insert.run(OTHER, 'ACP 调度', '/tmp/acp-dispatch', 0, stamp, stamp)
    db.prepare(
      `
      INSERT INTO plugin_team_setting(team_id, plugin_id, enabled, config_json, updated_by, created_at, updated_at)
      VALUES ('team-a', ?, 1, '{}', ?, ?, ?)
    `,
    ).run(PLUGIN, fixtures.admin.id, stamp, stamp)

    const policy = createPluginPolicy({ db })
    const admin = actorFor(fixtures.admin, {
      systemAdmin: true,
      teams: [{ id: 'team-a', name: 'A 队', role: 'admin' }],
    })
    const lead = actorFor(fixtures.lead, {
      teams: [{ id: 'team-a', name: 'A 队', role: 'member' }],
    })
    const member = actorFor(fixtures.member, {
      teams: [{ id: 'team-a', name: 'A 队', role: 'member' }],
    })
    const stranger = actorFor(fixtures.member, {
      teams: [{ id: 'team-b', name: 'B 队', role: 'member' }],
    })
    await fn({ policy, fixtures, admin, lead, member, stranger })
  } finally {
    cleanupWorkspace(workspace, db)
  }
}

test('未登录一律 401', async () => {
  await withPolicy(({ policy }) => {
    assert.throws(
      () => policy.assertAuthenticated(null),
      (error) => error.status === 401,
    )
    assert.throws(
      () => policy.assertPluginVisible(null, PLUGIN),
      (error) => error.status === 401,
    )
  })
})

test('系统管理员能看到所有已登记插件，但已禁用的仍被拒绝', async () => {
  await withPolicy(({ policy, admin }) => {
    assert.doesNotThrow(() => policy.assertPluginVisible(admin, PLUGIN))
    assert.throws(
      () => policy.assertPluginVisible(admin, OTHER),
      (error) => error.code === 'PLUGIN_DISABLED',
    )
    assert.throws(
      () => policy.assertPluginVisible(admin, 'nope'),
      (error) => error.code === 'PLUGIN_NOT_FOUND',
    )
  })
})

test('团队启用后该团队成员可见；未启用团队不可见', async () => {
  await withPolicy(({ policy, lead, member, stranger }) => {
    assert.doesNotThrow(() => policy.assertPluginVisible(lead, PLUGIN))
    assert.doesNotThrow(() => policy.assertPluginVisible(member, PLUGIN))
    assert.throws(
      () => policy.assertPluginVisible(stranger, PLUGIN),
      (error) => error.status === 403,
    )
    assert.equal(policy.isPluginVisible(stranger, PLUGIN), false)
  })
})

test('插件已被平台停用时，团队成员也看不到', async () => {
  await withPolicy(({ policy, lead, admin }) => {
    assert.throws(
      () => policy.assertPluginVisible(lead, OTHER),
      (error) => error.code === 'PLUGIN_DISABLED',
    )
    assert.throws(
      () => policy.assertPluginVisible(admin, OTHER),
      (error) => error.code === 'PLUGIN_DISABLED',
    )
  })
})

test('团队管理员按团队判定，跨团队不行', async () => {
  await withPolicy(({ policy, admin, lead }) => {
    // 系统管理员天然可以管理任意团队；团队成员只看自己那个团队。
    assert.doesNotThrow(() => policy.assertTeamAdmin(admin, 'team-a'))
    assert.doesNotThrow(() => policy.assertTeamAdmin(admin, 'team-b'))
    assert.throws(
      () => policy.assertTeamAdmin(lead, 'team-a'),
      (error) => error.status === 403,
    )
  })
})

test('只能配置自己的偏好，不能配置别人的', async () => {
  await withPolicy(({ policy, admin, lead, member }) => {
    assert.doesNotThrow(() => policy.assertCanConfigureSelf(lead, lead.userId))
    assert.throws(
      () => policy.assertCanConfigureSelf(lead, member.userId),
      (error) => error.status === 403,
    )
    // 管理员也不能替别人写偏好，只能强制下线（见 design.md §5）。
    assert.throws(
      () => policy.assertCanConfigureSelf(admin, member.userId),
      (error) => error.status === 403,
    )
  })
})

test('别人只能看到"是否在线"，不能强制下线', async () => {
  await withPolicy(({ policy, admin, lead, member }) => {
    assert.throws(
      () => policy.assertCanViewOther(lead, member.userId, 'team-a'),
      (error) => error.status === 403,
    )
    assert.doesNotThrow(() => policy.assertCanViewOther(admin, member.userId, 'team-a'))
    assert.throws(
      () => policy.assertCanForceLogout(lead, member.userId, 'team-a'),
      (error) => error.status === 403,
    )
    assert.doesNotThrow(() => policy.assertCanForceLogout(admin, member.userId, 'team-a'))
  })
})

test('项目 lead 能绑定自己的项目，普通成员不能', async () => {
  await withPolicy(({ policy, admin, lead, member }) => {
    assert.doesNotThrow(() =>
      policy.assertCanBindProject(lead, {
        teamId: 'team-a',
        projectId: 'project-a',
      }),
    )
    assert.throws(
      () =>
        policy.assertCanBindProject(member, {
          teamId: 'team-a',
          projectId: 'project-a',
        }),
      (error) => error.status === 403,
    )
    assert.doesNotThrow(() =>
      policy.assertCanBindProject(admin, {
        teamId: 'team-a',
        projectId: 'project-a',
      }),
    )
    assert.throws(
      () =>
        policy.assertCanBindProject(lead, {
          teamId: 'team-a',
          projectId: 'missing',
        }),
      (error) => error.status === 404,
    )
  })
})

test('团队参数改动要求团队管理员；系统管理员兜底', async () => {
  await withPolicy(({ policy, admin, lead }) => {
    assert.doesNotThrow(() => policy.assertTeamSetting(admin, 'team-a'))
    assert.throws(
      () => policy.assertTeamSetting(lead, 'team-a'),
      (error) => error.status === 403,
    )
  })
})
