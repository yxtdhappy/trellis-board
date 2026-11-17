import test from 'node:test'
import assert from 'node:assert/strict'
import { createActorContext, DEFAULT_ACTOR_TTL_MS } from '../team/plugins/actors.js'
import {
  actorFor,
  cleanupWorkspace,
  makePluginWorkspace,
  openPluginWorkspaceDatabase,
  seedTeamPluginFixtures,
} from '@trellis-board/test-support/team-plugin-fixtures.js'

async function withActors(fn, options = {}) {
  const workspace = makePluginWorkspace()
  const db = openPluginWorkspaceDatabase(workspace)
  const clock = { now: Date.UTC(2026, 10, 16, 9, 0, 0) }
  try {
    const fixtures = await seedTeamPluginFixtures(db)
    const context = createActorContext({
      db,
      now: () => clock.now,
      ...options,
    })
    try {
      await fn({ context, fixtures, clock })
    } finally {
      context.stop()
    }
  } finally {
    cleanupWorkspace(workspace, db)
  }
}

test('签发的 actor 载荷带团队与项目，且可反解', async () => {
  await withActors(({ context, fixtures }) => {
    const actor = actorFor(fixtures.lead, {
      teams: [{ id: 'team-a', name: 'A 队', role: 'member' }],
    })
    const payload = context.issue({ actor, pluginId: 'witops-core' })
    assert.match(payload.ref, /^act_/)
    assert.equal(payload.userId, fixtures.lead.id)
    assert.equal(payload.displayName, fixtures.lead.displayName)
    assert.equal(payload.systemAdmin, false)
    assert.deepEqual(payload.teams, [{ id: 'team-a', name: 'A 队', role: 'member' }])
    assert.deepEqual(payload.projects, [{ id: 'project-a', role: 'lead', teamId: 'team-a' }])
    assert.equal(payload.expiresAt - payload.issuedAt, DEFAULT_ACTOR_TTL_MS)

    const resolved = context.resolve({
      ref: payload.ref,
      pluginId: 'witops-core',
    })
    assert.equal(resolved.userId, fixtures.lead.id)
  })
})

test('缺少 ref、未知 ref、插件不匹配、过期一律拒绝', async () => {
  await withActors(({ context, fixtures, clock }) => {
    const payload = context.issue({
      actor: actorFor(fixtures.member),
      pluginId: 'witops-core',
    })
    const denied = (error) => error.code === 1001

    assert.throws(() => context.resolve({ ref: '', pluginId: 'witops-core' }), denied)
    assert.throws(() => context.resolve({ ref: 'act_nope', pluginId: 'witops-core' }), denied)
    assert.throws(() => context.resolve({ ref: payload.ref, pluginId: 'acp-dispatch' }), denied)
    clock.now += DEFAULT_ACTOR_TTL_MS
    assert.throws(() => context.resolve({ ref: payload.ref, pluginId: 'witops-core' }), denied)
    assert.equal(context.size(), 0)
  })
})

test('未登录的 actor 不能签发', async () => {
  await withActors(({ context }) => {
    assert.throws(
      () => context.issue({ actor: { userId: null }, pluginId: 'witops-core' }),
      (error) => error.status === 401,
    )
    assert.throws(
      () => context.issue({ actor: { userId: 'u1' }, pluginId: '' }),
      (error) => error.status === 400,
    )
  })
})

test('超过上限时淘汰最早的引用', async () => {
  await withActors(
    ({ context, fixtures, clock }) => {
      const first = context.issue({
        actor: actorFor(fixtures.lead),
        pluginId: 'witops-core',
      })
      clock.now += 1000
      const second = context.issue({
        actor: actorFor(fixtures.member),
        pluginId: 'witops-core',
      })
      assert.equal(context.size(), 2)
      clock.now += 1000
      context.issue({
        actor: actorFor(fixtures.admin),
        pluginId: 'witops-core',
      })
      assert.equal(context.size(), 2)
      assert.throws(() => context.resolve({ ref: first.ref, pluginId: 'witops-core' }))
      assert.equal(
        context.resolve({ ref: second.ref, pluginId: 'witops-core' }).userId,
        fixtures.member.id,
      )
    },
    { maxEntries: 2 },
  )
})
