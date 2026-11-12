import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../database.js'
import { createTaskSpaceService } from '../team/task-space-service.js'

function setup() {
  const db = openDatabase({
    databaseFile: ':memory:',
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
  })
  const now = new Date().toISOString()
  for (const [id, name] of [
    ['team-a', '团队 A'],
    ['team-b', '团队 B'],
  ]) {
    db.prepare(
      `INSERT INTO team(id, name, slug, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
    ).run(id, name, id, now, now)
  }
  for (const id of ['user-a', 'user-b']) {
    db.prepare(
      `INSERT INTO user_account(
        id, username_key, username, display_name, password_hash, password_params_json,
        system_admin, status, must_change_password, password_changed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'x', '{}', 0, 'active', 0, ?, ?, ?)`,
    ).run(id, id, id, id, now, now, now)
  }
  db.prepare(
    `INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
     VALUES ('team-a', 'user-a', 'member', ?, ?)`,
  ).run(now, now)
  db.prepare(
    `INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
     VALUES ('team-b', 'user-b', 'member', ?, ?)`,
  ).run(now, now)
  for (const [id, userId] of [
    ['agent-a', 'user-a'],
    ['agent-b', 'user-b'],
  ]) {
    db.prepare(
      `INSERT INTO agent_device(
        id, user_id, device_name, platform, agent_version, protocol_version,
        credential_hash, status, last_seen_at, created_at
      ) VALUES (?, ?, ?, 'win32', '0.1.0', 3, ?, 'active', ?, ?)`,
    ).run(id, userId, id, `${id}-credential`, now, now)
    db.prepare(`
      INSERT INTO sync_active_agent(user_id, agent_id, updated_at)
      VALUES (?, ?, ?)
    `).run(userId, id, now)
  }
  const service = createTaskSpaceService({ db })
  return { db, service, now }
}

test('相同远端可以通过 HTTPS 或 SSH 命中同一项目和任务空间', () => {
  const { db, service } = setup()
  try {
    const first = service.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      displayName: 'Acme',
      teamId: 'team-a',
      developerId: 'alice',
      localRepoKey: 'a'.repeat(64),
    })
    const resolved = service.resolve('user-b', {
      remoteUrl: 'git@example.com:acme/repo.git',
      branchName: 'main',
      teamId: 'team-b',
    })
    assert.equal(first.project.id, resolved.project.id)
    assert.equal(resolved.status, 'access_required')
    assert.equal(resolved.taskSpace, null)
  } finally {
    db.close()
  }
})

test('预检无需 binding 只返回任务元数据，无权团队拿不到任务内容', () => {
  const { db, service, now } = setup()
  const tables = [
    'sync_project',
    'sync_project_team_access',
    'sync_project_member',
    'sync_task_space',
    'sync_agent_binding',
    'sync_agent_cursor',
  ]
  const counts = () =>
    Object.fromEntries(
      tables.map((table) => [
        table,
        Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count),
      ]),
    )
  try {
    const empty = service.preflight('user-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      teamId: 'team-a',
    })
    assert.equal(empty.status, 'new')
    assert.deepEqual(empty.tasks, [])
    assert.deepEqual(counts(), {
      sync_project: 0,
      sync_project_team_access: 0,
      sync_project_member: 0,
      sync_task_space: 0,
      sync_agent_binding: 0,
      sync_agent_cursor: 0,
    })

    const attached = service.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      displayName: 'Acme',
      teamId: 'team-a',
      developerId: 'alice',
      localRepoKey: 'a'.repeat(64),
    })
    db.prepare(`
      INSERT INTO sync_task_space_file(
        task_space_id, relative_path, revision, sha256, content_text, deleted,
        task_id, task_dir, updated_at
      ) VALUES (?, ?, 1, ?, ?, 0, ?, ?, ?)
    `).run(
      attached.taskSpace.id,
      '.trellis/tasks/01-demo/task.json',
      'b'.repeat(64),
      '{"id":"task-1"}\n',
      'task-1',
      '.trellis/tasks/01-demo',
      now,
    )
    db.prepare('UPDATE sync_task_space SET revision = 1 WHERE id = ?').run(attached.taskSpace.id)

    const before = counts()
    const existing = service.preflight('user-a', {
      remoteUrl: 'ssh://example.com/acme/repo.git',
      branchName: 'main',
      teamId: 'team-a',
    })
    assert.equal(existing.status, 'existing')
    assert.deepEqual(existing.tasks, [
      {
        taskDir: '.trellis/tasks/01-demo',
        taskId: 'task-1',
        files: [
          {
            path: '.trellis/tasks/01-demo/task.json',
            sha256: 'b'.repeat(64),
          },
        ],
      },
    ])
    assert.equal(JSON.stringify(existing).includes('"content"'), false)
    assert.deepEqual(counts(), before)

    db.prepare("UPDATE sync_project SET status = 'disabled' WHERE id = ?").run(attached.project.id)
    const unavailable = service.preflight('user-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      teamId: 'team-a',
    })
    assert.equal(unavailable.status, 'unavailable')
    assert.deepEqual(unavailable.tasks, [])
    assert.equal(JSON.stringify(unavailable).includes('task-1'), false)
    assert.deepEqual(counts(), before)
    db.prepare("UPDATE sync_project SET status = 'active' WHERE id = ?").run(attached.project.id)

    const denied = service.preflight('user-b', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      teamId: 'team-b',
    })
    assert.equal(denied.status, 'access_required')
    assert.deepEqual(denied.tasks, [])
    assert.equal(JSON.stringify(denied).includes('task-1'), false)
    assert.deepEqual(counts(), before)
  } finally {
    db.close()
  }
})

test('邀请团队后加入同一任务空间且不复制项目', () => {
  const { db, service } = setup()
  try {
    const first = service.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      displayName: 'Acme',
      teamId: 'team-a',
      developerId: 'alice',
      localRepoKey: 'a'.repeat(64),
    })
    service.inviteTeam(service.actorContext('user-a'), first.project.id, 'team-b')
    const joined = service.attach('user-b', 'agent-b', {
      remoteUrl: 'ssh://example.com/acme/repo.git',
      branchName: 'main',
      displayName: 'Acme',
      teamId: 'team-b',
      localRepoKey: 'b'.repeat(64),
    })
    assert.equal(joined.project.id, first.project.id)
    assert.equal(joined.taskSpace.id, first.taskSpace.id)
    assert.equal(joined.binding.readOnly, true)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_project').get().count, 1)
  } finally {
    db.close()
  }
})

test('同一用户切换未授权团队时不能借用其他团队的访问权限', () => {
  const { db, service, now } = setup()
  try {
    const attached = service.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      displayName: 'Acme',
      teamId: 'team-a',
      developerId: 'alice',
      localRepoKey: 'a'.repeat(64),
    })
    db.prepare(
      `INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
       VALUES ('team-b', 'user-a', 'member', ?, ?)`,
    ).run(now, now)

    const resolved = service.resolve('user-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      teamId: 'team-b',
    })
    assert.equal(resolved.status, 'access_required')
    assert.equal(resolved.project.id, attached.project.id)
    assert.equal(resolved.taskSpace, null)

    const preflight = service.preflight('user-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      teamId: 'team-b',
    })
    assert.equal(preflight.status, 'access_required')
    assert.deepEqual(preflight.tasks, [])
    assert.throws(
      () =>
        service.attach('user-a', 'agent-a', {
          remoteUrl: 'https://example.com/acme/repo.git',
          branchName: 'main',
          displayName: 'Acme',
          teamId: 'team-b',
          localRepoKey: 'a'.repeat(64),
        }),
      /没有访问权限/,
    )
  } finally {
    db.close()
  }
})

test('同一 Agent 从仓库 main 切换到其他分支时撤销旧 binding 并保留两个 taskSpace', () => {
  const { db, service } = setup()
  try {
    const main = service.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      displayName: 'Acme',
      teamId: 'team-a',
      developerId: 'alice',
      localRepoKey: 'a'.repeat(64),
    })
    const feature = service.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'feature/x',
      displayName: 'Acme',
      teamId: 'team-a',
      developerId: 'alice',
      localRepoKey: 'a'.repeat(64),
    })
    assert.notEqual(main.taskSpace.id, feature.taskSpace.id)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_task_space').get().count, 2)
    assert.deepEqual(feature.replacedBindings, [
      {
        id: main.binding.id,
        taskSpaceId: main.taskSpace.id,
        branchName: 'main',
        status: 'revoked',
      },
    ])
    const bindings = db
      .prepare(`
        SELECT task_space_id, sync_status FROM sync_agent_binding
        WHERE agent_id = 'agent-a' ORDER BY task_space_id
      `)
      .all()
    assert.deepEqual(
      bindings.map((binding) => [binding.task_space_id, binding.sync_status]).sort(),
      [
        [feature.taskSpace.id, 'approved'],
        [main.taskSpace.id, 'revoked'],
      ].sort(),
    )
  } finally {
    db.close()
  }
})

test('当前 Agent 切换分支不撤销其他设备对旧分支的 binding', () => {
  const { db, service } = setup()
  try {
    const main = service.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      displayName: 'Acme',
      teamId: 'team-a',
      developerId: 'alice',
      localRepoKey: 'a'.repeat(64),
    })
    service.inviteTeam(service.actorContext('user-a'), main.project.id, 'team-b')
    service.attach('user-b', 'agent-b', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      displayName: 'Acme',
      teamId: 'team-b',
      developerId: 'bob',
      localRepoKey: 'b'.repeat(64),
    })
    service.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'feature/x',
      displayName: 'Acme',
      teamId: 'team-a',
      developerId: 'alice',
      localRepoKey: 'a'.repeat(64),
    })
    assert.equal(
      db
        .prepare(`
          SELECT sync_status FROM sync_agent_binding
          WHERE agent_id = 'agent-b' AND task_space_id = ?
        `)
        .get(main.taskSpace.id).sync_status,
      'approved',
    )
  } finally {
    db.close()
  }
})

test('团队管理员的项目列表只包含其管理团队有权访问的项目', () => {
  const { db, service } = setup()
  try {
    const owner = service.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      displayName: 'Acme',
      teamId: 'team-a',
      developerId: 'alice',
      localRepoKey: 'a'.repeat(64),
    })
    db.prepare(
      "UPDATE team_member SET role = 'admin' WHERE team_id = 'team-b' AND user_id = 'user-b'",
    ).run()
    const adminB = service.actorContext('user-b')
    assert.deepEqual(service.listAll(adminB, { teamId: 'team-b' }), [])
    service.inviteTeam(service.actorContext('user-a'), owner.project.id, 'team-b')
    assert.equal(service.listAll(adminB, { teamId: 'team-b' }).length, 1)
  } finally {
    db.close()
  }
})

test('没有 developer ID 映射的团队管理员仍显示为只读', () => {
  const { db, service } = setup()
  try {
    db.prepare(
      "UPDATE team_member SET role = 'admin' WHERE team_id = 'team-b' AND user_id = 'user-b'",
    ).run()
    const attached = service.attach('user-b', 'agent-b', {
      remoteUrl: 'https://example.com/team-b/repo.git',
      branchName: 'main',
      displayName: 'Team B',
      teamId: 'team-b',
      developerId: 'bob',
      localRepoKey: 'b'.repeat(64),
    })
    db.prepare("DELETE FROM sync_project_member WHERE project_id = ? AND user_id = 'user-b'").run(
      attached.project.id,
    )
    const project = service.listReadable(service.actorContext('user-b'), {
      teamId: 'team-b',
    })[0]
    assert.equal(project.taskSpaces[0].readOnly, true)
  } finally {
    db.close()
  }
})
