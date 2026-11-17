import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../database.js'
import { createSyncAgentService } from '../team/sync-agent-service.js'

function setup() {
  const db = openDatabase({
    databaseFile: ':memory:',
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
  })
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO team(id, name, slug, status, created_at, updated_at)
     VALUES ('team-1', '团队', 'team-1', 'active', ?, ?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO user_account(
      id, username_key, username, display_name, password_hash, password_params_json,
      system_admin, status, must_change_password, password_changed_at, created_at, updated_at
    ) VALUES ('user-1', 'user-1', 'user-1', '用户一', 'x', '{}', 0, 'active', 0, ?, ?, ?)`,
  ).run(now, now, now)
  db.prepare(
    `INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
     VALUES ('team-1', 'user-1', 'member', ?, ?)`,
  ).run(now, now)
  const revoked = []
  const published = []
  return {
    db,
    revoked,
    published,
    service: createSyncAgentService({
      db,
      events: {
        publishAgentRevoked(agentId) {
          revoked.push(agentId)
        },
        publishBoardChanged() {
          published.push(true)
        },
      },
    }),
  }
}

function register(service, db, deviceName) {
  const actor = {
    userId: 'user-1',
    user: { id: 'user-1', username: 'user-1', displayName: '用户一', systemAdmin: false },
    systemAdmin: false,
    teams: [{ id: 'team-1', name: '团队', role: 'member' }],
  }
  const pairing = service.createPairingCode(actor, { teamId: 'team-1' })
  const enrolled = service.enroll(
    {
      protocolVersion: 3,
      agentVersion: '0.1.0',
      platform: 'win32',
      deviceName,
      pairingCode: pairing.pairingCode,
    },
    { ip: deviceName },
  )
  const request = {
    headers: { authorization: `Bearer ${enrolled.credential}` },
  }
  return { enrolled, request, agent: service.authenticate(request) }
}

function insertListenerBindings(db, agentId) {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO sync_project(
      id, name, remote_url, remote_identity_hash, baseline_branch, owner_team_id, status,
      created_by_user_id, created_by_agent_id, created_at, updated_at
    ) VALUES ('project-listener', '监听项目', 'https://example.com/listener.git', 'listener-hash',
      'main', 'team-1', 'active', 'user-1', ?, ?, ?)`,
  ).run(agentId, now, now)
  const insertSpace = db.prepare(
    `INSERT INTO sync_task_space(
      id, project_id, branch_name, status, revision, indexed_revision,
      created_by_user_id, created_by_agent_id, created_at, updated_at
    ) VALUES (?, 'project-listener', ?, 'active', 0, 0, 'user-1', ?, ?, ?)`,
  )
  const insertBinding = db.prepare(
    `INSERT INTO sync_agent_binding(
      id, agent_id, task_space_id, local_repo_key, local_display_name,
      branch_name, sync_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, '监听项目', ?, 'approved', ?, ?)`,
  )
  for (const [suffix, branchName, keyChar] of [
    ['a', 'main', 'a'],
    ['b', 'dev', 'b'],
  ]) {
    insertSpace.run(`space-${suffix}`, branchName, agentId, now, now)
    insertBinding.run(
      `binding-${suffix}`,
      agentId,
      `space-${suffix}`,
      keyChar.repeat(64),
      branchName,
      now,
      now,
    )
  }
}

function heartbeatInput(agent, listeningTaskSpaceIds) {
  return {
    protocolVersion: 3,
    agentId: agent.id,
    agentVersion: '0.1.0',
    deviceName: agent.deviceName,
    listenerReportVersion: 1,
    listeningTaskSpaceIds,
  }
}

test('新设备生效后旧设备立即不能鉴权', () => {
  const { db, service, revoked } = setup()
  try {
    const first = register(service, db, '设备 A')
    const second = register(service, db, '设备 B')
    assert.equal(service.authenticate(second.request).id, second.agent.id)
    assert.throws(() => service.authenticate(first.request), /凭证无效/)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_active_agent').get().count, 1)
    assert.deepEqual(revoked, [first.agent.id])
  } finally {
    db.close()
  }
})

test('新设备撤销旧设备时取消旧待执行命令和绑定', () => {
  const { db, service } = setup()
  try {
    const first = register(service, db, '设备 A')
    const now = new Date().toISOString()
    db.prepare(
      `INSERT INTO sync_project(
        id, name, remote_url, remote_identity_hash, owner_team_id, status,
        created_by_user_id, created_by_agent_id, created_at, updated_at
      ) VALUES ('project-1', '项目', 'https://example.com/a.git', 'hash', 'team-1', 'active',
        'user-1', ?, ?, ?)`,
    ).run(first.agent.id, now, now)
    db.prepare(
      `INSERT INTO sync_task_space(
        id, project_id, branch_name, status, revision, indexed_revision,
        created_by_user_id, created_by_agent_id, created_at, updated_at
      ) VALUES ('space-1', 'project-1', 'main', 'active', 0, 0, 'user-1', ?, ?, ?)`,
    ).run(first.agent.id, now, now)
    db.prepare(
      `INSERT INTO sync_agent_binding(
        id, agent_id, task_space_id, local_repo_key, local_display_name,
        branch_name, sync_status, created_at, updated_at
      ) VALUES ('binding-1', ?, 'space-1', ?, '项目', 'main', 'approved', ?, ?)`,
    ).run(first.agent.id, 'a'.repeat(64), now, now)
    db.prepare(
      `INSERT INTO sync_task_command(
        id, task_space_id, project_id, agent_id, binding_id, command_type,
        idempotency_key, request_hash, payload_json, status,
        attempts, created_by_user_id, created_at, updated_at
      ) VALUES ('command-1', 'space-1', 'project-1', ?, 'binding-1', 'create_task',
        'idem-1', 'hash', '{}', 'pending', 0, 'user-1', ?, ?)`,
    ).run(first.agent.id, now, now)
    db.prepare(
      "UPDATE sync_agent_binding SET is_listening = 1, listener_reported_at = ?, last_listener_at = ? WHERE id = 'binding-1'",
    ).run(now, now)
    register(service, db, '设备 B')
    assert.equal(
      db.prepare("SELECT status FROM sync_task_command WHERE id = 'command-1'").get().status,
      'cancelled',
    )
    assert.equal(
      db.prepare("SELECT sync_status FROM sync_agent_binding WHERE id = 'binding-1'").get()
        .sync_status,
      'revoked',
    )
    assert.equal(
      db.prepare("SELECT is_listening FROM sync_agent_binding WHERE id = 'binding-1'").get()
        .is_listening,
      0,
    )
  } finally {
    db.close()
  }
})

test('监听协议心跳只把上报集合标记为在线，并为全部 approved binding 记录报告时间', () => {
  const { db, service } = setup()
  try {
    const first = register(service, db, '监听设备')
    insertListenerBindings(db, first.agent.id)
    const input = heartbeatInput(first.agent, ['space-a'])
    input.bindings = [
      { taskSpaceId: 'space-a', localRepoKey: 'a'.repeat(64) },
      { taskSpaceId: 'space-b', localRepoKey: 'b'.repeat(64) },
    ]
    const heartbeat = service.heartbeat(first.agent, input)
    assert.deepEqual(
      Object.fromEntries(
        heartbeat.bindings.map((binding) => [binding.taskSpaceId, binding.baselineBranch]),
      ),
      { 'space-a': 'main', 'space-b': 'main' },
    )
    const rows = Object.fromEntries(
      db
        .prepare(`
          SELECT id, is_listening, listener_reported_at, last_listener_at
          FROM sync_agent_binding
          WHERE agent_id = ?
        `)
        .all(first.agent.id)
        .map((row) => [row.id, row]),
    )
    assert.equal(rows['binding-a'].is_listening, 1)
    assert.ok(rows['binding-a'].listener_reported_at)
    assert.ok(rows['binding-a'].last_listener_at)
    assert.equal(rows['binding-b'].is_listening, 0)
    assert.equal(rows['binding-b'].listener_reported_at, rows['binding-a'].listener_reported_at)
    assert.equal(rows['binding-b'].last_listener_at, null)
    assert.equal(service.onlineAgentForTaskSpace('space-a', 'user-1').length, 1)
    assert.equal(service.onlineAgentForTaskSpace('space-b', 'user-1').length, 0)
    assert.equal(service.onlineListenerCount('space-a'), 1)
  } finally {
    db.close()
  }
})

test('监听集合变化才发布看板事件，重复心跳不重复发布', () => {
  const { db, service, published } = setup()
  try {
    const first = register(service, db, '监听设备')
    insertListenerBindings(db, first.agent.id)
    service.heartbeat(first.agent, heartbeatInput(first.agent, ['space-a']))
    assert.equal(published.length, 1)
    service.heartbeat(first.agent, heartbeatInput(first.agent, ['space-a']))
    assert.equal(published.length, 1)
    service.heartbeat(first.agent, heartbeatInput(first.agent, ['space-a', 'space-b']))
    assert.equal(published.length, 2)
    service.heartbeat(first.agent, heartbeatInput(first.agent, []))
    assert.equal(published.length, 3)
    const legacy = {
      protocolVersion: 3,
      agentId: first.agent.id,
      agentVersion: '0.1.0',
      deviceName: first.agent.deviceName,
    }
    service.heartbeat(first.agent, legacy)
    assert.equal(published.length, 3)
  } finally {
    db.close()
  }
})

test('binding 仓库不匹配时不会被监听报告标记为在线', () => {
  const { db, service } = setup()
  try {
    const first = register(service, db, '监听设备')
    insertListenerBindings(db, first.agent.id)
    const input = heartbeatInput(first.agent, ['space-a'])
    input.bindings = [{ taskSpaceId: 'space-a', localRepoKey: 'f'.repeat(64) }]
    const heartbeat = service.heartbeat(first.agent, input)
    assert.equal(heartbeat.bindings[0].errorCode, 'REMOTE_MISMATCH')
    assert.equal(service.onlineListenerCount('space-a'), 0)
    const binding = db
      .prepare('SELECT is_listening, listener_reported_at FROM sync_agent_binding WHERE id = ?')
      .get('binding-a')
    assert.equal(binding.is_listening, 0)
    assert.ok(binding.listener_reported_at)
  } finally {
    db.close()
  }
})

test('空监听集合清除在线状态，旧客户端心跳不刷新监听报告', () => {
  const { db, service } = setup()
  try {
    const first = register(service, db, '监听设备')
    insertListenerBindings(db, first.agent.id)
    const oldTime = '2026-11-12T00:00:00.000Z'
    db.prepare(`
      UPDATE sync_agent_binding
      SET is_listening = 1, listener_reported_at = ?, last_listener_at = ?
      WHERE agent_id = ?
    `).run(oldTime, oldTime, first.agent.id)
    service.heartbeat(first.agent, heartbeatInput(first.agent, []))
    const cleared = db
      .prepare(`
        SELECT is_listening, listener_reported_at, last_listener_at
        FROM sync_agent_binding WHERE agent_id = ? ORDER BY id
      `)
      .all(first.agent.id)
    assert.deepEqual(
      cleared.map((row) => row.is_listening),
      [0, 0],
    )
    assert.notEqual(cleared[0].listener_reported_at, oldTime)
    assert.equal(cleared[0].last_listener_at, oldTime)
    assert.equal(cleared[1].last_listener_at, oldTime)

    const reportedAt = cleared[0].listener_reported_at
    service.heartbeat(first.agent, {
      protocolVersion: 3,
      agentId: first.agent.id,
      agentVersion: '0.1.0',
      deviceName: first.agent.deviceName,
    })
    assert.deepEqual(
      db
        .prepare(`
          SELECT is_listening, listener_reported_at, last_listener_at
          FROM sync_agent_binding WHERE agent_id = ? ORDER BY id
        `)
        .all(first.agent.id)
        .map((row) => ({ ...row })),
      cleared.map((row) => ({
        ...row,
        listener_reported_at: reportedAt,
      })),
    )
  } finally {
    db.close()
  }
})

test('监听报告或设备心跳超过统一阈值后不再算在线', () => {
  const { db, service } = setup()
  try {
    const first = register(service, db, '监听设备')
    insertListenerBindings(db, first.agent.id)
    const now = new Date().toISOString()
    db.prepare(`
      UPDATE sync_agent_binding
      SET is_listening = 1, listener_reported_at = ?, last_listener_at = ?
      WHERE id = 'binding-a'
    `).run(now, now)
    assert.equal(service.onlineListenerCount('space-a'), 1)
    db.prepare(
      "UPDATE sync_agent_binding SET listener_reported_at = '2000-01-01T00:00:00.000Z' WHERE id = 'binding-a'",
    ).run()
    assert.equal(service.onlineListenerCount('space-a'), 0)
    db.prepare("UPDATE sync_agent_binding SET listener_reported_at = ? WHERE id = 'binding-a'").run(
      now,
    )
    db.prepare("UPDATE agent_device SET last_seen_at = '2000-01-01T00:00:00.000Z'").run()
    assert.equal(service.onlineListenerCount('space-a'), 0)
  } finally {
    db.close()
  }
})

test('心跳把 retired taskSpace 标为不可同步，删除后的 binding 返回 BINDING_UNKNOWN', () => {
  const { db, service } = setup()
  try {
    const first = register(service, db, '监听设备')
    insertListenerBindings(db, first.agent.id)
    const now = new Date().toISOString()
    db.prepare(`
      UPDATE sync_task_space
      SET status = 'disabled', retired_at = ?
      WHERE id = 'space-a'
    `).run(now)

    const retired = service.heartbeat(first.agent, {
      ...heartbeatInput(first.agent, ['space-a', 'space-b']),
      bindings: [{ taskSpaceId: 'space-a', localRepoKey: 'a'.repeat(64) }],
    })
    assert.equal(retired.bindings[0].status, 'disabled')
    assert.equal(retired.bindings[0].errorCode, 'TASK_SPACE_RETIRED')
    assert.equal(
      db.prepare('SELECT is_listening FROM sync_agent_binding WHERE id = ?').get('binding-a')
        .is_listening,
      0,
    )

    db.prepare('DELETE FROM sync_task_space WHERE id = ?').run('space-a')
    const removed = service.heartbeat(first.agent, {
      ...heartbeatInput(first.agent, ['space-a']),
      bindings: [{ taskSpaceId: 'space-a', localRepoKey: 'a'.repeat(64) }],
    })
    assert.equal(removed.bindings[0].status, 'rejected')
    assert.equal(removed.bindings[0].errorCode, 'BINDING_UNKNOWN')
  } finally {
    db.close()
  }
})

test('心跳不会把索引中或投影失败的任务空间误标为停用', () => {
  const { db, service } = setup()
  try {
    const first = register(service, db, '监听设备')
    insertListenerBindings(db, first.agent.id)
    for (const status of ['indexing', 'error']) {
      db.prepare("UPDATE sync_task_space SET status = ? WHERE id = 'space-a'").run(status)
      const heartbeat = service.heartbeat(first.agent, {
        ...heartbeatInput(first.agent, ['space-a']),
        bindings: [{ taskSpaceId: 'space-a', localRepoKey: 'a'.repeat(64) }],
      })
      assert.equal(heartbeat.bindings[0].status, 'approved')
      assert.equal(heartbeat.bindings[0].errorCode, undefined)
      assert.equal(
        db.prepare('SELECT is_listening FROM sync_agent_binding WHERE id = ?').get('binding-a')
          .is_listening,
        1,
      )
    }
  } finally {
    db.close()
  }
})

test('心跳忽略已物理删除任务空间的监听 ID，不拒绝其他已批准关联', () => {
  const { db, service } = setup()
  try {
    const first = register(service, db, '监听设备')
    insertListenerBindings(db, first.agent.id)
    const heartbeat = service.heartbeat(first.agent, {
      ...heartbeatInput(first.agent, ['missing-space', 'space-a']),
      bindings: [{ taskSpaceId: 'space-a', localRepoKey: 'a'.repeat(64) }],
    })
    assert.equal(heartbeat.bindings[0].status, 'approved')
    assert.equal(
      db.prepare('SELECT is_listening FROM sync_agent_binding WHERE id = ?').get('binding-a')
        .is_listening,
      1,
    )
  } finally {
    db.close()
  }
})

test('非法监听集合整次拒绝，不更新设备心跳或部分 binding', () => {
  const { db, service } = setup()
  try {
    const first = register(service, db, '监听设备')
    insertListenerBindings(db, first.agent.id)
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO sync_task_space(
        id, project_id, branch_name, status, revision, indexed_revision,
        created_by_user_id, created_by_agent_id, created_at, updated_at
      ) VALUES ('space-unapproved', 'project-listener', 'unapproved', 'active', 0, 0,
        'user-1', ?, ?, ?)
    `).run(first.agent.id, now, now)
    const oldTime = '2026-11-12T00:00:00.000Z'
    db.prepare(`
      UPDATE sync_agent_binding
      SET is_listening = 1, listener_reported_at = ?, last_listener_at = ?
      WHERE agent_id = ?
    `).run(oldTime, oldTime, first.agent.id)
    db.prepare('UPDATE agent_device SET last_seen_at = ? WHERE id = ?').run(oldTime, first.agent.id)
    for (const ids of [
      ['space-a', 'space-a'],
      ['space-a', 'space-unapproved'],
      Array.from({ length: 65 }, (_, index) => `space-${index}`),
    ]) {
      assert.throws(
        () => service.heartbeat(first.agent, heartbeatInput(first.agent, ids)),
        /重复|不属于|不能超过/,
      )
    }
    assert.equal(
      db.prepare('SELECT last_seen_at FROM agent_device WHERE id = ?').get(first.agent.id)
        .last_seen_at,
      oldTime,
    )
    assert.deepEqual(
      db
        .prepare(`
          SELECT is_listening, listener_reported_at, last_listener_at
          FROM sync_agent_binding WHERE agent_id = ? ORDER BY id
        `)
        .all(first.agent.id)
        .map((row) => ({ ...row })),
      [
        {
          is_listening: 1,
          listener_reported_at: oldTime,
          last_listener_at: oldTime,
        },
        {
          is_listening: 1,
          listener_reported_at: oldTime,
          last_listener_at: oldTime,
        },
      ],
    )
  } finally {
    db.close()
  }
})

test('团队管理员不能查看或撤销其他团队成员之外设备的记录', () => {
  const { db, service } = setup()
  try {
    const now = new Date().toISOString()
    const first = register(service, db, '设备一')
    db.prepare(
      `INSERT INTO team(id, name, slug, status, created_at, updated_at)
       VALUES ('team-2', '团队二', 'team-2', 'active', ?, ?)`,
    ).run(now, now)
    db.prepare(
      `INSERT INTO user_account(
        id, username_key, username, display_name, password_hash, password_params_json,
        system_admin, status, must_change_password, password_changed_at, created_at, updated_at
      ) VALUES ('user-2', 'user-2', 'user-2', '用户二', 'x', '{}', 0, 'active', 0, ?, ?, ?)`,
    ).run(now, now, now)
    db.prepare(
      `INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
       VALUES ('team-2', 'user-2', 'member', ?, ?)`,
    ).run(now, now)
    db.prepare(
      `INSERT INTO agent_device(
        id, user_id, device_name, platform, agent_version, protocol_version,
        credential_hash, status, last_seen_at, created_at
      ) VALUES ('agent-2', 'user-2', '设备二', 'win32', '0.1.0', 3, 'credential-2', 'active', ?, ?)`,
    ).run(now, now)
    const actor = {
      userId: 'user-1',
      user: { id: 'user-1', username: 'user-1', displayName: '用户一', systemAdmin: false },
      systemAdmin: false,
      teams: [
        { id: 'team-1', name: '团队', role: 'admin' },
        { id: 'team-2', name: '团队二', role: 'member' },
      ],
    }
    assert.deepEqual(
      service.listDevices(actor, { teamId: 'team-1' }).map((device) => device.id),
      [first.agent.id],
    )
    assert.throws(
      () => service.revokeDevice(actor, 'agent-2', { teamId: 'team-1' }),
      /Agent 不存在/,
    )
    assert.equal(
      db.prepare("SELECT status FROM agent_device WHERE id = 'agent-2'").get().status,
      'active',
    )
  } finally {
    db.close()
  }
})
