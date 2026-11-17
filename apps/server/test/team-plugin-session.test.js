import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionStore, maskAccount } from '../team/plugins/session.js'
import {
  cleanupWorkspace,
  makePluginWorkspace,
  openPluginWorkspaceDatabase,
  seedTeamPluginFixtures,
} from '@trellis-board/test-support/team-plugin-fixtures.js'

async function withSessions(fn, options = {}) {
  const workspace = makePluginWorkspace()
  const db = openPluginWorkspaceDatabase(workspace)
  const clock = { now: Date.UTC(2026, 10, 16, 8, 0, 0) }
  const audits = []
  try {
    const fixtures = await seedTeamPluginFixtures(db)
    const store = createSessionStore({
      db,
      now: () => clock.now,
      audit: (pluginId, kind, detail) => audits.push({ pluginId, kind, detail }),
      ...options,
    })
    try {
      await fn({ store, fixtures, clock, audits, db })
    } finally {
      store.stop()
    }
  } finally {
    cleanupWorkspace(workspace, db)
  }
}

const PLUGIN = 'witops-core'

test('创建后可以解析，公开视图不含 token', async () => {
  await withSessions(({ store, fixtures }) => {
    const session = store.create({
      userId: fixtures.lead.id,
      pluginId: PLUGIN,
      account: 'zhangsan@example.com',
      token: 'tok-1',
    })
    const handle = session.handle
    assert.equal(typeof handle, 'string')
    assert.equal(JSON.stringify(session).includes('tok-1'), false)
    assert.equal(JSON.stringify(session).includes('token'), false)

    const resolved = store.resolve({
      handle,
      userId: fixtures.lead.id,
      pluginId: PLUGIN,
    })
    assert.equal(resolved.token, 'tok-1')
    assert.equal(resolved.account, 'zhangsan@example.com')
    assert.equal(store.resolve({ handle, userId: fixtures.member.id, pluginId: PLUGIN }), null)
    assert.equal(store.resolve({ handle, userId: fixtures.lead.id, pluginId: 'other' }), null)
  })
})

test('同一用户重登替换旧句柄，不占用两条', async () => {
  await withSessions(({ store, fixtures, audits }) => {
    const first = store.create({
      userId: fixtures.lead.id,
      pluginId: PLUGIN,
      account: 'zhangsan',
      token: 'tok-1',
    })
    const second = store.create({
      userId: fixtures.lead.id,
      pluginId: PLUGIN,
      account: 'zhangsan',
      token: 'tok-2',
    })
    assert.equal(store.size(), 1)
    assert.equal(
      store.resolve({
        handle: first.handle,
        userId: fixtures.lead.id,
        pluginId: PLUGIN,
      }),
      null,
    )
    assert.equal(
      store.resolve({
        handle: second.handle,
        userId: fixtures.lead.id,
        pluginId: PLUGIN,
      }).token,
      'tok-2',
    )
    assert.equal(
      audits.some((item) => item.detail?.reason === 'replaced'),
      true,
    )
  })
})

test('同一 WitOps 账号被另一用户占用时返回 409 ACCOUNT_IN_USE', async () => {
  await withSessions(({ store, fixtures, audits }) => {
    store.create({
      userId: fixtures.lead.id,
      pluginId: PLUGIN,
      account: 'ZhangSan@example.com',
      token: 'tok-1',
    })
    assert.throws(
      () =>
        store.create({
          userId: fixtures.member.id,
          pluginId: PLUGIN,
          account: 'zhangsan@example.com',
          token: 'tok-2',
        }),
      (error) => {
        assert.equal(error.code, 'ACCOUNT_IN_USE')
        assert.equal(error.status, 409)
        assert.equal(error.details.displayName, fixtures.lead.displayName)
        return true
      },
    )
    assert.equal(store.size(), 1)
    assert.equal(
      audits.some((item) => item.kind === 'session.conflict'),
      true,
    )
  })
})

test('超过 TTL 后惰性失效', async () => {
  await withSessions(({ store, fixtures, clock }) => {
    const { handle } = store.create({
      userId: fixtures.lead.id,
      pluginId: PLUGIN,
      account: 'zhangsan',
      token: 'tok-1',
    })
    clock.now += 12 * 60 * 60 * 1000 - 1
    assert.notEqual(store.resolve({ handle, userId: fixtures.lead.id, pluginId: PLUGIN }), null)
    clock.now += 1
    assert.equal(store.resolve({ handle, userId: fixtures.lead.id, pluginId: PLUGIN }), null)
    assert.equal(store.statusOf(fixtures.lead.id, PLUGIN), null)
  })
})

test('revoke 与 revokeUser 只清内存并留审计', async () => {
  await withSessions(({ store, fixtures, audits }) => {
    const one = store.create({
      userId: fixtures.lead.id,
      pluginId: PLUGIN,
      account: 'zhangsan',
      token: 'tok-1',
    })
    store.create({
      userId: fixtures.lead.id,
      pluginId: 'acp-dispatch',
      account: 'zhangsan',
      token: 'tok-2',
    })
    assert.match(one.handle, /^[0-9a-f-]{36}$/)
    store.revoke({ handle: one.handle, reason: 'logout' })
    assert.equal(
      store.resolve({
        handle: one.handle,
        userId: fixtures.lead.id,
        pluginId: PLUGIN,
      }),
      null,
    )
    assert.equal(store.revokeUser(fixtures.lead.id, 'acp-dispatch'), true)
    assert.equal(store.revokeUser(fixtures.lead.id, 'acp-dispatch'), false)
    assert.equal(store.size(), 0)
    assert.equal(audits.filter((item) => item.detail?.reason === 'logout').length, 1)
  })
})

test('达到上限时淘汰最早过期的条目', async () => {
  await withSessions(
    ({ store, fixtures, clock }) => {
      const handles = []
      for (const [index, offset] of [5000, 1000, 3000].entries()) {
        clock.now = Date.UTC(2026, 10, 16, 8, 0, 0) + index * 1000
        handles.push(
          store.create({
            userId: `${fixtures.lead.id}-${offset}`,
            pluginId: PLUGIN,
            account: `user-${offset}`,
            token: `tok-${offset}`,
          }).handle,
        )
      }
      assert.equal(store.size(), 2)
      assert.equal(
        store.resolve({
          handle: handles[0],
          userId: fixtures.lead.id,
          pluginId: PLUGIN,
        }),
        null,
      )
      assert.equal(store.size(), 2)
    },
    { maxEntries: 2 },
  )
})

test('listOnline 只返回掩码账号与时间', async () => {
  await withSessions(({ store, fixtures }) => {
    store.create({
      userId: fixtures.lead.id,
      pluginId: PLUGIN,
      account: 'zhangsan@example.com',
      token: 'tok-1',
    })
    const [online] = store.listOnline({ pluginId: PLUGIN })
    assert.equal(online.account, maskAccount('zhangsan@example.com'))
    assert.equal(online.account.includes('zhangsan@'), false)
    assert.equal(JSON.stringify(online).includes('tok-1'), false)
  })
})

test('maskAccount 覆盖短账号', () => {
  assert.equal(maskAccount('ab'), 'a**')
  assert.equal(maskAccount('abcd'), 'a***d')
  assert.equal(maskAccount('zhangsan'), 'zh***an')
})
