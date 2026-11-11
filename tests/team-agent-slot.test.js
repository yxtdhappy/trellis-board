import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../server/database.js'
import { createSyncAgentService } from '../server/team/sync-agent-service.js'

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
  return {
    db,
    revoked,
    service: createSyncAgentService({
      db,
      events: {
        publishAgentRevoked(agentId) {
          revoked.push(agentId)
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
