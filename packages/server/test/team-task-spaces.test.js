import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../database.js'
import { createTaskSpaceService } from '../team/task-space-service.js'

function setup({ backupService = null, onTaskSpacePurged = null } = {}) {
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
  const service = createTaskSpaceService({ db, backupService, onTaskSpacePurged })
  return { db, service, now }
}

function addTeamAMember(db, suffix) {
  const now = new Date().toISOString()
  const userId = `user-${suffix}`
  const agentId = `agent-${suffix}`
  db.prepare(
    `INSERT INTO user_account(
      id, username_key, username, display_name, password_hash, password_params_json,
      system_admin, status, must_change_password, password_changed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'x', '{}', 0, 'active', 0, ?, ?, ?)`,
  ).run(userId, userId, userId, userId, now, now, now)
  db.prepare(
    `INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
     VALUES ('team-a', ?, 'member', ?, ?)`,
  ).run(userId, now, now)
  db.prepare(
    `INSERT INTO agent_device(
      id, user_id, device_name, platform, agent_version, protocol_version,
      credential_hash, status, last_seen_at, created_at
    ) VALUES (?, ?, ?, 'win32', '0.1.0', 3, ?, 'active', ?, ?)`,
  ).run(agentId, userId, agentId, `${agentId}-credential`, now, now)
  db.prepare(
    `INSERT INTO sync_active_agent(user_id, agent_id, updated_at)
     VALUES (?, ?, ?)`,
  ).run(userId, agentId, now)
  return { userId, agentId }
}

function markListening(db, bindings) {
  const now = new Date().toISOString()
  for (const binding of bindings) {
    db.prepare(`
      UPDATE sync_agent_binding
      SET is_listening = 1, listener_reported_at = ?, last_listener_at = ?
      WHERE id = ?
    `).run(now, now, binding.binding.id)
    db.prepare('UPDATE agent_device SET last_seen_at = ? WHERE id = ?').run(
      now,
      binding.binding.agentId,
    )
  }
  return now
}

function attachClient(service, userId, agentId, keyChar, developerId, teamId = 'team-a') {
  return service.attach(userId, agentId, {
    remoteUrl: 'https://example.com/acme/repo.git',
    branchName: 'main',
    displayName: 'Acme',
    teamId,
    developerId,
    localRepoKey: keyChar.repeat(64),
  })
}

function addTaskSnapshot(db, taskSpace, { title = '示例任务', archived = false } = {}) {
  const now = new Date().toISOString()
  const taskDir = `.trellis/tasks/${archived ? 'archive/2026-11/' : ''}01-example`
  const taskKey = `${taskSpace.projectId}::${taskDir}`
  db.prepare(`
    INSERT INTO sync_task_space_file(
      task_space_id, relative_path, revision, sha256, content_text, deleted,
      task_id, task_dir, updated_at
    ) VALUES (?, ?, 1, ?, ?, 0, 'task-example', ?, ?)
  `).run(
    taskSpace.id,
    `${taskDir}/task.json`,
    'b'.repeat(64),
    '{"id":"task-example"}\n',
    taskDir,
    now,
  )
  db.prepare(`
    INSERT INTO sync_task_index(
      task_space_id, project_id, task_key, execution_task_key, relative_dir, branch_name,
      title, search_text, archived, archived_at, priority, derived_stage, assignee_dev_id,
      assignee_user_id, due_date, last_activity_at, is_blocked, is_unblocked_ready,
      attention_flags_json, group_key, group_role, task_version, board_version, updated_at
    ) VALUES (?, ?, ?, 'task-example', ?, ?, ?, ?, ?, ?, 'P2', 'planning', 'alice',
      NULL, NULL, ?, 0, 0, '[]', 'task-example', 'parent', 'v1', 'b1', ?)
  `).run(
    taskSpace.id,
    taskSpace.projectId,
    taskKey,
    taskDir,
    taskSpace.branchName,
    title,
    title,
    archived ? 1 : 0,
    archived ? now : null,
    now,
    now,
  )
}

function addLifecycleArtifacts(db, taskSpace, agentId, bindingId = null) {
  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO sync_agent_cursor(agent_id, task_space_id, revision, updated_at)
    VALUES (?, ?, 1, ?)
  `).run(agentId, taskSpace.id, now)
  db.prepare(`
    INSERT INTO sync_task_command(
      id, task_space_id, project_id, target_user_id, agent_id, binding_id, command_type,
      idempotency_key, request_hash, payload_json, status, attempts,
      created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'user-a', ?, ?, 'create_task', ?, 'hash', '{}', 'running', 0,
      'user-a', ?, ?)
  `).run(
    `command-${taskSpace.id}`,
    taskSpace.id,
    taskSpace.projectId,
    agentId,
    bindingId,
    `idem-${taskSpace.id}`,
    now,
    now,
  )
  db.prepare(`
    INSERT INTO sync_conflict(
      id, task_space_id, files_json, server_revision, status,
      created_by_user_id, created_by_agent_id, created_at
    ) VALUES (?, ?, '[]', 1, 'pending', 'user-a', ?, ?)
  `).run(`conflict-${taskSpace.id}`, taskSpace.id, agentId, now)
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
      INSERT INTO sync_task(
        execution_task_key, task_key, task_space_id, project_id, task_id, relative_dir,
        title, description, priority, created_by_user_id, assignee_user_id, assignee_dev_id,
        stage, archived, materialization_state, task_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '', 'P2', 'user-a', 'user-a', 'alice',
        'planning', 0, 'materialized', 1, ?, ?)
    `).run(
      `${attached.taskSpace.id}::task-1`,
      `${attached.taskSpace.id}::.trellis/tasks/01-demo`,
      attached.taskSpace.id,
      attached.project.id,
      'task-1',
      '.trellis/tasks/01-demo',
      '示例任务一',
      now,
      now,
    )
    db.prepare(`
      INSERT INTO sync_task_space_file(
        task_space_id, relative_path, revision, sha256, content_text, deleted,
        task_id, task_dir, updated_at
      ) VALUES (?, ?, 1, ?, ?, 0, ?, ?, ?)
    `).run(
      attached.taskSpace.id,
      '.trellis/tasks/01-demo/task.json',
      'b'.repeat(64),
      '{"id":"task-1","title":"示例任务一","branch":"main"}\n',
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
        title: '示例任务一',
        taskBranch: 'main',
        files: [
          {
            path: '.trellis/tasks/01-demo/task.json',
            sha256: 'b'.repeat(64),
          },
        ],
      },
    ])
    assert.deepEqual(existing.hiddenTaskDirs, [])
    assert.deepEqual(existing.archivedTaskBasenames, [])
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
    assert.equal(main.project.baselineBranch, 'main')
    assert.equal(main.taskSpace.isBaseline, true)
    assert.equal(feature.taskSpace.isBaseline, false)
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

test('taskSpace status 聚合监听状态：在线、未激活、旧客户端和停用优先', () => {
  const { db, service } = setup()
  try {
    const first = attachClient(service, 'user-a', 'agent-a', 'a', 'alice')
    const extraUsers = ['c', 'd'].map((suffix) => addTeamAMember(db, suffix))
    const second = attachClient(service, extraUsers[0].userId, extraUsers[0].agentId, 'c', 'carol')
    const third = attachClient(service, extraUsers[1].userId, extraUsers[1].agentId, 'd', 'dave')
    assert.equal(second.taskSpace.id, first.taskSpace.id)
    assert.equal(third.taskSpace.id, first.taskSpace.id)
    const actor = service.actorContext('user-a')
    const space = () =>
      service
        .listStatusReadable(actor)
        .find((project) => project.id === first.project.id)
        .taskSpaces.find((item) => item.id === first.taskSpace.id)

    markListening(db, [first, second, third])
    assert.deepEqual(
      {
        state: space().listenerState,
        online: space().onlineListenerCount,
        approved: space().approvedBindingCount,
      },
      { state: 'online', online: 3, approved: 3 },
    )

    db.prepare('UPDATE sync_agent_binding SET is_listening = 0 WHERE id = ?').run(second.binding.id)
    assert.equal(space().onlineListenerCount, 2)
    assert.equal(space().approvedBindingCount, 3)
    assert.equal(space().listenerState, 'online')

    db.prepare(`
      UPDATE sync_agent_binding SET is_listening = 0
      WHERE task_space_id = ?
    `).run(first.taskSpace.id)
    assert.equal(space().onlineListenerCount, 0)
    assert.equal(space().approvedBindingCount, 3)
    assert.equal(space().listenerReportedBindingCount, 3)
    assert.equal(space().listenerState, 'inactive')
    assert.ok(space().lastListenerAt)

    db.prepare("UPDATE sync_task_space SET status = 'disabled' WHERE id = ?").run(
      first.taskSpace.id,
    )
    assert.equal(space().listenerState, 'disabled')
    assert.equal(service.listenerDetails(actor, first.taskSpace.id).listenerState, 'disabled')
    db.prepare('UPDATE sync_agent_binding SET is_listening = 1 WHERE task_space_id = ?').run(
      first.taskSpace.id,
    )
    service.disableProject(actor, first.project.id)
    assert.equal(
      db
        .prepare(`
          SELECT COUNT(*) AS count FROM sync_agent_binding
          WHERE task_space_id = ? AND is_listening = 0
        `)
        .get(first.taskSpace.id).count,
      3,
    )
  } finally {
    db.close()
  }
})

test('未上报监听协议的旧 binding 显示 unknown_legacy，不伪造在线', () => {
  const { db, service } = setup()
  try {
    const attached = attachClient(service, 'user-a', 'agent-a', 'a', 'alice')
    const project = service.listReadable(service.actorContext('user-a'), { teamId: 'team-a' })[0]
    const space = project.taskSpaces.find((item) => item.id === attached.taskSpace.id)
    assert.equal(space.canManage, true)
    assert.equal(space.listenerState, 'unknown_legacy')
    assert.equal(space.approvedBindingCount, 1)
    assert.equal(space.listenerReportedBindingCount, 0)
    assert.equal(space.onlineListenerCount, 0)
    assert.equal(space.lastListenerAt, null)
  } finally {
    db.close()
  }
})

test('监听详情只向管理者返回脱敏客户端信息并隔离团队权限', () => {
  const { db, service } = setup()
  try {
    const first = attachClient(service, 'user-a', 'agent-a', 'a', 'alice')
    const extra = addTeamAMember(db, 'c')
    service.upsertMember(service.actorContext('user-a'), {
      projectId: first.project.id,
      userId: extra.userId,
      role: 'member',
      trellisDevId: 'carol',
    })
    const second = attachClient(service, extra.userId, extra.agentId, 'c', 'carol', 'team-a')
    markListening(db, [first, second])

    const ownerDetails = service.listenerDetails(service.actorContext('user-a'), first.taskSpace.id)
    assert.equal(ownerDetails.listenerState, 'online')
    assert.equal(ownerDetails.approvedBindingCount, 2)
    assert.equal(ownerDetails.onlineListenerCount, 2)
    assert.equal(ownerDetails.listeners.length, 2)
    assert.equal(JSON.stringify(ownerDetails).includes('localRepoKey'), false)
    assert.equal(JSON.stringify(ownerDetails).includes('a'.repeat(64)), false)
    assert.throws(
      () => service.listenerDetails(service.actorContext(extra.userId), first.taskSpace.id),
      /负责人或团队管理员/,
    )
    assert.throws(
      () => service.listenerDetails(service.actorContext('user-b'), first.taskSpace.id),
      /任务空间不存在/,
    )

    db.prepare(
      "UPDATE team_member SET role = 'admin' WHERE team_id = 'team-b' AND user_id = 'user-b'",
    ).run()
    service.inviteTeam(service.actorContext('user-a'), first.project.id, 'team-b')
    assert.equal(
      service.listenerDetails(service.actorContext('user-b'), first.taskSpace.id).listeners.length,
      2,
    )
  } finally {
    db.close()
  }
})

test('Agent 主动解绑原子撤销 binding、取消命令、清理 cursor 并只审计一次', () => {
  const { db, service } = setup()
  try {
    const first = attachClient(service, 'user-a', 'agent-a', 'a', 'alice')
    const extra = addTeamAMember(db, 'c')
    const second = attachClient(service, extra.userId, extra.agentId, 'c', 'carol')
    markListening(db, [first, second])
    const now = new Date().toISOString()
    for (const binding of [first, second]) {
      db.prepare(`
        INSERT INTO sync_agent_cursor(agent_id, task_space_id, revision, updated_at)
        VALUES (?, ?, 1, ?)
      `).run(binding.binding.agentId, first.taskSpace.id, now)
    }
    const insertCommand = db.prepare(`
      INSERT INTO sync_task_command(
        id, task_space_id, project_id, target_user_id, agent_id, binding_id, command_type,
        idempotency_key, request_hash, payload_json, status, attempts,
        created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'create_task', ?, 'hash', '{}', 'running', 0, 'user-a', ?, ?)
    `)
    insertCommand.run(
      'detach-command-a',
      first.taskSpace.id,
      first.project.id,
      'user-a',
      first.binding.agentId,
      first.binding.id,
      'detach-a',
      now,
      now,
    )
    insertCommand.run(
      'detach-command-c',
      first.taskSpace.id,
      first.project.id,
      extra.userId,
      second.binding.agentId,
      second.binding.id,
      'detach-c',
      now,
      now,
    )
    db.prepare(`
      INSERT INTO sync_task_space_file(
        task_space_id, relative_path, revision, sha256, content_text, deleted,
        task_id, task_dir, updated_at
      ) VALUES (?, '.trellis/tasks/01-demo/task.json', 1, ?, ?, 0, 'task-1',
        '.trellis/tasks/01-demo', ?)
    `).run(first.taskSpace.id, 'b'.repeat(64), '{"id":"task-1"}\n', now)
    db.prepare(`
      INSERT INTO sync_conflict(
        id, task_space_id, files_json, server_revision, status,
        created_by_user_id, created_by_agent_id, created_at
      ) VALUES ('detach-conflict', ?, '[]', 1, 'pending', 'user-a', ?, ?)
    `).run(first.taskSpace.id, first.binding.agentId, now)

    assert.throws(
      () =>
        service.detachAgent(
          { id: first.binding.agentId, userId: extra.userId },
          first.taskSpace.id,
          { localRepoKey: 'a'.repeat(64) },
        ),
      /不是当前账号的有效设备/,
    )
    assert.throws(
      () =>
        service.detachAgent({ id: 'agent-a', userId: 'user-a' }, first.taskSpace.id, {
          localRepoKey: 'f'.repeat(64),
        }),
      (error) => error.code === 'TASK_SPACE_BINDING_MISMATCH',
    )
    const detached = service.detachAgent({ id: 'agent-a', userId: 'user-a' }, first.taskSpace.id, {
      localRepoKey: 'a'.repeat(64),
    })
    assert.deepEqual(detached, {
      detached: true,
      alreadyDetached: false,
      taskSpaceId: first.taskSpace.id,
      bindingId: first.binding.id,
    })
    assert.equal(
      db.prepare('SELECT sync_status FROM sync_agent_binding WHERE id = ?').get(first.binding.id)
        .sync_status,
      'revoked',
    )
    assert.equal(
      db.prepare('SELECT is_listening FROM sync_agent_binding WHERE id = ?').get(first.binding.id)
        .is_listening,
      0,
    )
    assert.ok(
      db
        .prepare('SELECT last_listener_at FROM sync_agent_binding WHERE id = ?')
        .get(first.binding.id).last_listener_at,
    )
    const cancelled = db
      .prepare("SELECT status, error_text FROM sync_task_command WHERE id = 'detach-command-a'")
      .get()
    assert.equal(cancelled.status, 'cancelled')
    assert.equal(cancelled.error_text, '客户端主动解除任务空间关联')
    assert.equal(
      db
        .prepare('SELECT COUNT(*) AS count FROM sync_agent_cursor WHERE agent_id = ?')
        .get('agent-a').count,
      0,
    )
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_task_space_file').get().count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_conflict').get().count, 1)
    assert.equal(
      db
        .prepare('SELECT COUNT(*) AS count FROM sync_task_space WHERE id = ?')
        .get(first.taskSpace.id).count,
      1,
    )
    const auditCount = () =>
      Number(
        db
          .prepare(`
            SELECT COUNT(*) AS count FROM audit_event
            WHERE action = 'task_space_binding_detached' AND target_id = ?
          `)
          .get(first.binding.id).count,
      )
    assert.equal(auditCount(), 1)
    assert.equal(
      db.prepare('SELECT sync_status FROM sync_agent_binding WHERE id = ?').get(second.binding.id)
        .sync_status,
      'approved',
    )

    const replay = service.detachAgent({ id: 'agent-a', userId: 'user-a' }, first.taskSpace.id, {
      localRepoKey: 'a'.repeat(64),
    })
    assert.equal(replay.alreadyDetached, true)
    assert.equal(auditCount(), 1)

    db.exec(`
      CREATE TRIGGER fail_detach_audit
      BEFORE INSERT ON audit_event
      WHEN NEW.action = 'task_space_binding_detached'
      BEGIN
        SELECT RAISE(ABORT, 'detach audit failed');
      END;
    `)
    assert.throws(
      () =>
        service.detachAgent(
          { id: second.binding.agentId, userId: extra.userId },
          first.taskSpace.id,
          { localRepoKey: 'c'.repeat(64) },
        ),
      /detach audit failed/,
    )
    assert.equal(
      db.prepare('SELECT sync_status FROM sync_agent_binding WHERE id = ?').get(second.binding.id)
        .sync_status,
      'approved',
    )
    assert.equal(
      db.prepare("SELECT status FROM sync_task_command WHERE id = 'detach-command-c'").get().status,
      'running',
    )
    assert.equal(
      db
        .prepare('SELECT COUNT(*) AS count FROM sync_agent_cursor WHERE agent_id = ?')
        .get(second.binding.agentId).count,
      1,
    )
    db.exec('DROP TRIGGER fail_detach_audit')

    service.detachAgent({ id: second.binding.agentId, userId: extra.userId }, first.taskSpace.id, {
      localRepoKey: 'c'.repeat(64),
    })
    const finalSpace = service
      .listReadable(service.actorContext('user-a'), { teamId: 'team-a' })
      .flatMap((project) => project.taskSpaces)
      .find((space) => space.id === first.taskSpace.id)
    assert.equal(finalSpace.approvedBindingCount, 0)
    assert.equal(finalSpace.onlineListenerCount, 0)
    assert.equal(finalSpace.listenerState, 'unassociated')
  } finally {
    db.close()
  }
})

test('项目负责人可弃用和恢复分支，普通列表隐藏而管理列表保留数据摘要', () => {
  const { db, service } = setup()
  try {
    const attached = attachClient(service, 'user-a', 'agent-a', 'a', 'alice')
    addTaskSnapshot(db, attached.taskSpace, { title: '待保留任务' })
    addLifecycleArtifacts(db, attached.taskSpace, attached.binding.agentId, attached.binding.id)
    markListening(db, [attached])
    const actor = service.actorContext('user-a')

    const retired = service.retireTaskSpace(actor, attached.project.id, attached.taskSpace.id, {
      reason: '历史功能已经结束',
    })
    assert.equal(retired.lifecycleStatus, 'retired')
    assert.equal(retired.retiredReason, '历史功能已经结束')
    assert.deepEqual(retired.unarchivedTaskTitles, ['待保留任务'])
    assert.equal(
      db
        .prepare('SELECT is_listening FROM sync_agent_binding WHERE id = ?')
        .get(attached.binding.id).is_listening,
      0,
    )
    assert.equal(
      db
        .prepare('SELECT status FROM sync_task_command WHERE task_space_id = ?')
        .get(attached.taskSpace.id).status,
      'cancelled',
    )
    assert.equal(
      db
        .prepare('SELECT COUNT(*) AS count FROM sync_task_space_file WHERE task_space_id = ?')
        .get(attached.taskSpace.id).count,
      1,
    )
    assert.deepEqual(
      service
        .listReadable(actor, { teamId: 'team-a' })
        .find((project) => project.id === attached.project.id).taskSpaces,
      [],
    )
    assert.deepEqual(
      service.listStatusReadable(actor).find((project) => project.id === attached.project.id)
        .taskSpaces,
      [],
    )
    const retiredResolve = service.resolve('user-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      teamId: 'team-a',
    })
    assert.equal(retiredResolve.status, 'unavailable')
    assert.equal(retiredResolve.canCreate, false)
    assert.equal(retiredResolve.taskSpace, null)
    const retiredAdmin = service
      .listAdminTaskSpaces(actor, attached.project.id)
      .find((item) => item.id === attached.taskSpace.id)
    assert.equal(retiredAdmin.lifecycleStatus, 'retired')
    assert.deepEqual(retiredAdmin.unarchivedTaskTitles, ['待保留任务'])

    const replay = service.retireTaskSpace(actor, attached.project.id, attached.taskSpace.id)
    assert.equal(replay.alreadyRetired, true)
    assert.equal(
      db
        .prepare(`
          SELECT COUNT(*) AS count FROM audit_event
          WHERE action = 'task_space_retired' AND target_id = ?
        `)
        .get(attached.taskSpace.id).count,
      1,
    )

    const restored = service.restoreTaskSpace(actor, attached.project.id, attached.taskSpace.id)
    assert.equal(restored.lifecycleStatus, 'active')
    assert.equal(restored.retiredAt, null)
    assert.equal(
      db
        .prepare('SELECT is_listening FROM sync_agent_binding WHERE id = ?')
        .get(attached.binding.id).is_listening,
      0,
    )
    assert.equal(
      service
        .listReadable(actor, { teamId: 'team-a' })
        .flatMap((project) => project.taskSpaces)
        .some((item) => item.id === attached.taskSpace.id),
      true,
    )
    assert.throws(
      () => service.restoreTaskSpace(actor, attached.project.id, attached.taskSpace.id),
      /不是已弃用状态/,
    )
  } finally {
    db.close()
  }
})

test('普通项目成员不能弃用分支，团队管理员和系统管理员可以管理', () => {
  const { db, service } = setup()
  try {
    const attached = attachClient(service, 'user-a', 'agent-a', 'a', 'alice')
    const ordinary = addTeamAMember(db, 'ordinary')
    service.upsertMember(service.actorContext('user-a'), {
      projectId: attached.project.id,
      userId: ordinary.userId,
      role: 'member',
      trellisDevId: 'ordinary',
    })
    assert.throws(
      () =>
        service.retireTaskSpace(
          service.actorContext(ordinary.userId),
          attached.project.id,
          attached.taskSpace.id,
        ),
      /无权管理项目分支/,
    )

    db.prepare(
      "UPDATE team_member SET role = 'admin' WHERE team_id = 'team-b' AND user_id = 'user-b'",
    ).run()
    service.inviteTeam(service.actorContext('user-a'), attached.project.id, 'team-b')
    const teamAdminRetired = service.retireTaskSpace(
      service.actorContext('user-b'),
      attached.project.id,
      attached.taskSpace.id,
    )
    assert.equal(teamAdminRetired.lifecycleStatus, 'retired')
    service.restoreTaskSpace(
      service.actorContext('user-b'),
      attached.project.id,
      attached.taskSpace.id,
    )

    db.prepare("UPDATE user_account SET system_admin = 1 WHERE id = 'user-b'").run()
    const systemAdminRetired = service.retireTaskSpace(
      service.actorContext('user-b'),
      attached.project.id,
      attached.taskSpace.id,
    )
    assert.equal(systemAdminRetired.lifecycleStatus, 'retired')
  } finally {
    db.close()
  }
})

test('仅系统管理员可永久移除项目，删除前备份、写审计并级联清理', () => {
  let runtimeDb
  let backupCalls = 0
  let backupMode = 'ok'
  let cleanupCalls = 0
  let cleanupFails = false
  const backupService = {
    backupNowOrThrow(options) {
      backupCalls += 1
      assert.equal(options.force, true)
      if (backupMode === 'fail') throw new Error('backup failed')
      if (backupMode === 'rename') {
        runtimeDb
          .prepare('UPDATE sync_project SET name = ? WHERE id = ?')
          .run('Renamed', target.project.id)
      }
      return 'D:\\data\\backups\\board.sqlite.snapshot.project.test'
    },
  }
  const { db, service } = setup({
    backupService,
    onTaskSpacePurged() {
      cleanupCalls += 1
      if (cleanupFails) throw new Error('cleanup failed')
    },
  })
  runtimeDb = db
  let target
  try {
    target = attachClient(service, 'user-a', 'agent-a', 'a', 'alice')
    const survivor = service.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/keep.git',
      branchName: 'main',
      displayName: '保留项目',
      teamId: 'team-a',
      developerId: 'alice',
      localRepoKey: 'b'.repeat(64),
    })
    addTaskSnapshot(db, target.taskSpace, { title: '待删任务' })
    addTaskSnapshot(db, survivor.taskSpace, { title: '保留任务' })
    const executionTaskKey = `${target.taskSpace.id}::task-example`
    const taskNow = new Date().toISOString()
    db.prepare(`
      INSERT INTO sync_task(
        execution_task_key, task_key, task_space_id, project_id, task_id, relative_dir,
        title, description, priority, stage, archived, materialization_state,
        task_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'task-example', '.trellis/tasks/01-example',
        '待删任务', '', 'P2', 'planning', 0, 'materialized', 1, ?, ?)
    `).run(
      executionTaskKey,
      `${target.taskSpace.id}::.trellis/tasks/01-example`,
      target.taskSpace.id,
      target.project.id,
      taskNow,
      taskNow,
    )
    db.prepare(`
      INSERT INTO sync_task_lease(
        id, execution_task_key, agent_id, user_id, lease_token, status,
        expires_at, last_heartbeat_at, created_at, updated_at
      ) VALUES ('lease-project-purge', ?, ?, 'user-a', 'token', 'active', ?, ?, ?, ?)
    `).run(executionTaskKey, target.binding.agentId, taskNow, taskNow, taskNow, taskNow)
    addLifecycleArtifacts(db, target.taskSpace, target.binding.agentId, target.binding.id)

    const ordinary = addTeamAMember(db, 'ordinary')
    service.upsertMember(service.actorContext('user-a'), {
      projectId: target.project.id,
      userId: ordinary.userId,
      role: 'member',
      trellisDevId: 'ordinary',
    })
    for (const actor of [service.actorContext('user-a'), service.actorContext(ordinary.userId)]) {
      assert.throws(
        () =>
          service.purgeProject(actor, target.project.id, {
            confirmation: target.project.name,
          }),
        (error) => error.status === 403,
      )
    }
    db.prepare(`
      UPDATE team_member SET role = 'admin'
      WHERE team_id = 'team-a' AND user_id = 'user-a'
    `).run()
    assert.throws(
      () =>
        service.purgeProject(service.actorContext('user-a'), target.project.id, {
          confirmation: target.project.name,
        }),
      (error) => error.status === 403,
    )
    assert.equal(backupCalls, 0)

    db.prepare("UPDATE user_account SET system_admin = 1 WHERE id = 'user-a'").run()
    const admin = service.actorContext('user-a')
    for (const input of [{}, { confirmation: ' Acme ' }, { confirmation: 'Other' }]) {
      assert.throws(() => service.purgeProject(admin, target.project.id, input), /项目确认名称/)
    }
    assert.throws(
      () =>
        service.purgeProject(admin, 'missing-project', {
          confirmation: 'missing-project',
        }),
      (error) => error.status === 404,
    )
    assert.equal(backupCalls, 0)

    assert.throws(
      () =>
        createTaskSpaceService({ db }).purgeProject(admin, target.project.id, {
          confirmation: target.project.name,
        }),
      (error) => error.code === 'DATABASE_BACKUP_UNAVAILABLE',
    )

    backupMode = 'fail'
    assert.throws(
      () =>
        service.purgeProject(admin, target.project.id, {
          confirmation: target.project.name,
        }),
      (error) => error.code === 'DATABASE_BACKUP_FAILED',
    )
    assert.equal(backupCalls, 1)
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM sync_project WHERE id = ?').get(target.project.id)
        .count,
      1,
    )

    backupMode = 'rename'
    assert.throws(
      () =>
        service.purgeProject(admin, target.project.id, {
          confirmation: target.project.name,
        }),
      (error) => error.status === 409,
    )
    assert.equal(backupCalls, 2)
    db.prepare('UPDATE sync_project SET name = ? WHERE id = ?').run(
      target.project.name,
      target.project.id,
    )
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM audit_event WHERE action = 'project_purged'").get()
        .count,
      0,
    )

    backupMode = 'ok'
    cleanupFails = true
    const result = service.purgeProject(admin, target.project.id, {
      confirmation: target.project.name,
    })
    assert.equal(result.purged, true)
    assert.equal(result.projectId, target.project.id)
    assert.equal(result.projectName, target.project.name)
    assert.equal(result.backupName, 'board.sqlite.snapshot.project.test')
    assert.deepEqual(result.summary, {
      remoteUrl: target.project.remoteUrl,
      taskSpaceCount: 1,
      taskCount: 1,
      memberCount: 2,
      teamAccessCount: 1,
      backupName: 'board.sqlite.snapshot.project.test',
    })
    assert.equal(backupCalls, 3)
    assert.equal(cleanupCalls, 1)
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM sync_project WHERE id = ?').get(target.project.id)
        .count,
      0,
    )
    for (const [table, column, id] of [
      ['sync_project_member', 'project_id', target.project.id],
      ['sync_project_team_access', 'project_id', target.project.id],
      ['sync_task_space', 'project_id', target.project.id],
      ['sync_task', 'project_id', target.project.id],
      ['sync_task_lease', 'execution_task_key', executionTaskKey],
      ['sync_task_index', 'project_id', target.project.id],
      ['sync_task_command', 'project_id', target.project.id],
      ['sync_agent_binding', 'task_space_id', target.taskSpace.id],
      ['sync_agent_cursor', 'task_space_id', target.taskSpace.id],
      ['sync_task_space_file', 'task_space_id', target.taskSpace.id],
      ['sync_conflict', 'task_space_id', target.taskSpace.id],
    ]) {
      assert.equal(
        db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`).get(id).count,
        0,
        table,
      )
    }
    const audit = db
      .prepare("SELECT project_id, detail_json FROM audit_event WHERE action = 'project_purged'")
      .get()
    assert.equal(audit.project_id, target.project.id)
    assert.deepEqual(JSON.parse(audit.detail_json), {
      projectName: target.project.name,
      ...result.summary,
    })
    assert.equal(
      db.prepare('SELECT COUNT(*) AS count FROM sync_project WHERE id = ?').get(survivor.project.id)
        .count,
      1,
    )
    assert.equal(
      service.listReadable(admin).some((project) => project.id === target.project.id),
      false,
    )
    assert.equal(
      service.listReadable(admin).some((project) => project.id === survivor.project.id),
      true,
    )
  } finally {
    db.close()
  }
})

test('移除分支直接删除 active taskSpace 的级联数据并保留其他分支', () => {
  let backupCalls = 0
  const { db, service } = setup({
    backupService: {
      backupNowOrThrow(options) {
        backupCalls += 1
        assert.equal(options.force, true)
        return 'D:\\data\\backups\\board.sqlite.snapshot.test'
      },
    },
  })
  try {
    const main = attachClient(service, 'user-a', 'agent-a', 'a', 'alice')
    const featureSpace = service.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'feature/cleanup',
      displayName: 'Acme',
      teamId: 'team-a',
      developerId: 'alice',
      localRepoKey: 'a'.repeat(64),
    })
    assert.notEqual(featureSpace.taskSpace.id, main.taskSpace.id)
    addTaskSnapshot(db, featureSpace.taskSpace, { title: '清理任务' })
    addLifecycleArtifacts(
      db,
      featureSpace.taskSpace,
      featureSpace.binding.agentId,
      featureSpace.binding.id,
    )
    const actor = service.actorContext('user-a')
    for (const confirmation of [' feature/cleanup ', 123]) {
      assert.throws(
        () =>
          service.purgeTaskSpace(actor, featureSpace.project.id, featureSpace.taskSpace.id, {
            confirmation,
          }),
        /确认名称/,
      )
    }
    assert.equal(backupCalls, 0)

    const result = service.purgeTaskSpace(
      actor,
      featureSpace.project.id,
      featureSpace.taskSpace.id,
      { confirmation: 'feature/cleanup' },
    )
    assert.equal(result.purged, true)
    assert.equal(result.backupName, 'board.sqlite.snapshot.test')
    assert.equal('backupFile' in result, false)
    assert.deepEqual(result.summary.unarchivedTasks, ['清理任务'])
    assert.equal(backupCalls, 1)
    assert.equal(
      db
        .prepare('SELECT COUNT(*) AS count FROM sync_task_space WHERE id = ?')
        .get(featureSpace.taskSpace.id).count,
      0,
    )
    for (const table of [
      'sync_agent_binding',
      'sync_agent_cursor',
      'sync_task_space_file',
      'sync_task_index',
      'sync_task_command',
      'sync_conflict',
    ]) {
      assert.equal(
        db
          .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE task_space_id = ?`)
          .get(featureSpace.taskSpace.id).count,
        0,
        table,
      )
    }
    assert.equal(
      db
        .prepare('SELECT COUNT(*) AS count FROM sync_task_space WHERE id = ?')
        .get(main.taskSpace.id).count,
      1,
    )
    assert.equal(
      db
        .prepare(`
          SELECT COUNT(*) AS count FROM audit_event
          WHERE action = 'task_space_purged' AND target_id = ?
        `)
        .get(featureSpace.taskSpace.id).count,
      1,
    )
  } finally {
    db.close()
  }
})

test('移除分支在备份失败时不删除 taskSpace，跨项目操作被拒绝', () => {
  const { db, service } = setup({
    backupService: {
      backupNowOrThrow() {
        throw new Error('disk full')
      },
    },
  })
  try {
    const first = attachClient(service, 'user-a', 'agent-a', 'a', 'alice')
    const second = service.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/other/repo.git',
      branchName: 'main',
      displayName: 'Other',
      teamId: 'team-a',
      developerId: 'alice',
      localRepoKey: 'c'.repeat(64),
    })
    const actor = service.actorContext('user-a')
    assert.throws(
      () =>
        service.purgeTaskSpace(actor, first.project.id, second.taskSpace.id, {
          confirmation: 'main',
        }),
      /任务空间不存在/,
    )
    assert.throws(
      () =>
        service.purgeTaskSpace(actor, first.project.id, first.taskSpace.id, {
          confirmation: 'main',
        }),
      (error) => error.code === 'DATABASE_BACKUP_FAILED',
    )
    assert.equal(
      db
        .prepare('SELECT COUNT(*) AS count FROM sync_task_space WHERE id = ?')
        .get(first.taskSpace.id).count,
      1,
    )
    assert.equal(
      db
        .prepare(`
          SELECT COUNT(*) AS count FROM audit_event
          WHERE action = 'task_space_purged' AND target_id = ?
        `)
        .get(first.taskSpace.id).count,
      0,
    )
  } finally {
    db.close()
  }
})

test('预检仅返回当前用户未归档活跃任务并列出隐藏目录与归档基名', () => {
  const { db, service, now } = setup()
  try {
    const memberB = addTeamAMember(db, 'c')
    const attached = attachClient(service, 'user-a', 'agent-a', 'a', 'alice')
    service.upsertMember(service.actorContext('user-a'), {
      projectId: attached.project.id,
      userId: memberB.userId,
      role: 'member',
      trellisDevId: 'charlie',
    })
    const insertTask = db.prepare(`
      INSERT INTO sync_task(
        execution_task_key, task_key, task_space_id, project_id, task_id, relative_dir,
        title, description, priority, created_by_user_id, assignee_user_id, assignee_dev_id,
        stage, archived, materialization_state, task_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '', 'P2', ?, ?, ?, 'planning', ?, 'materialized', 1, ?, ?)
    `)
    const insertFile = db.prepare(`
      INSERT INTO sync_task_space_file(
        task_space_id, relative_path, revision, sha256, content_text, deleted,
        task_id, task_dir, updated_at
      ) VALUES (?, ?, 1, ?, ?, 0, ?, ?, ?)
    `)
    const taskSpaceId = attached.taskSpace.id
    const projectId = attached.project.id

    // 1. 当前用户活跃任务
    insertTask.run(
      `${taskSpaceId}::mine`,
      `${taskSpaceId}::.trellis/tasks/11-25-mine`,
      taskSpaceId,
      projectId,
      'mine',
      '.trellis/tasks/11-25-mine',
      '我的任务',
      'user-a',
      'user-a',
      'alice',
      0,
      now,
      now,
    )
    insertFile.run(
      taskSpaceId,
      '.trellis/tasks/11-25-mine/task.json',
      '1'.repeat(64),
      JSON.stringify({ id: 'mine', title: '我的任务（最新）', branch: 'main' }),
      'mine',
      '.trellis/tasks/11-25-mine',
      now,
    )

    // 2. 他人活跃任务
    insertTask.run(
      `${taskSpaceId}::theirs`,
      `${taskSpaceId}::.trellis/tasks/11-23-theirs`,
      taskSpaceId,
      projectId,
      'theirs',
      '.trellis/tasks/11-23-theirs',
      '他人任务',
      memberB.userId,
      memberB.userId,
      'charlie',
      0,
      now,
      now,
    )
    insertFile.run(
      taskSpaceId,
      '.trellis/tasks/11-23-theirs/task.json',
      '2'.repeat(64),
      JSON.stringify({ id: 'theirs', title: '他人任务', branch: 'main' }),
      'theirs',
      '.trellis/tasks/11-23-theirs',
      now,
    )

    // 3. 已归档任务
    insertTask.run(
      `${taskSpaceId}::archived-one`,
      `${taskSpaceId}::.trellis/tasks/11-20-archived`,
      taskSpaceId,
      projectId,
      'archived-one',
      '.trellis/tasks/11-20-archived',
      '已归档任务',
      'user-a',
      'user-a',
      'alice',
      1,
      now,
      now,
    )
    insertFile.run(
      taskSpaceId,
      '.trellis/tasks/11-20-archived/task.json',
      '3'.repeat(64),
      JSON.stringify({ id: 'archived-one', title: '已归档任务', branch: 'main' }),
      'archived-one',
      '.trellis/tasks/11-20-archived',
      now,
    )

    // 4. 误入 archive 路径的活动文件
    insertFile.run(
      taskSpaceId,
      '.trellis/tasks/archive/2026-11/11-19-old/task.json',
      '4'.repeat(64),
      JSON.stringify({ id: 'mine', title: '归档路径', branch: 'main' }),
      'mine',
      '.trellis/tasks/archive/2026-11/11-19-old',
      now,
    )

    // 5. 无 sync_task 行的 legacy 文件
    insertFile.run(
      taskSpaceId,
      '.trellis/tasks/11-18-legacy/task.json',
      '5'.repeat(64),
      JSON.stringify({ id: 'legacy', title: '遗留任务', branch: 'main' }),
      'legacy',
      '.trellis/tasks/11-18-legacy',
      now,
    )

    const result = service.preflight('user-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      teamId: 'team-a',
    })
    assert.equal(result.status, 'existing')
    assert.deepEqual(result.tasks, [
      {
        taskDir: '.trellis/tasks/11-25-mine',
        taskId: 'mine',
        title: '我的任务（最新）',
        taskBranch: 'main',
        files: [{ path: '.trellis/tasks/11-25-mine/task.json', sha256: '1'.repeat(64) }],
      },
    ])
    assert.deepEqual(result.hiddenTaskDirs, [
      '.trellis/tasks/11-18-legacy',
      '.trellis/tasks/11-20-archived',
      '.trellis/tasks/11-23-theirs',
    ])
    assert.deepEqual(result.archivedTaskBasenames, ['11-20-archived'])
    assert.equal(JSON.stringify(result).includes('"content"'), false)
  } finally {
    db.close()
  }
})

test('preflight 将仅存在于 sync_archive_file 活跃快照中的归档任务纳入 archivedTaskBasenames', () => {
  const { db, service } = setup()
  try {
    const attached = service.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      displayName: 'Acme',
      teamId: 'team-a',
      developerId: 'dev-a',
      localRepoKey: 'a'.repeat(64),
    })
    const taskSpaceId = attached.taskSpace.id
    const now = new Date().toISOString()

    db.prepare(`
      INSERT INTO sync_archive_snapshot(
        id, task_space_id, source_head, status, active, storage_root,
        file_count, byte_count, manifest_sha256, published_at
      ) VALUES
        (?, ?, ?, 'retired', 0, 'snap-old', 1, 10, ?, ?),
        (?, ?, ?, 'published', 1, 'snap-active', 1, 10, ?, ?)
    `).run(
      'snap-old',
      taskSpaceId,
      '1'.repeat(40),
      'c'.repeat(64),
      now,
      'snap-active',
      taskSpaceId,
      '2'.repeat(40),
      'd'.repeat(64),
      now,
    )
    db.prepare('UPDATE sync_task_space SET archive_snapshot_id = ? WHERE id = ?').run(
      'snap-active',
      taskSpaceId,
    )

    const insertArchiveFile = db.prepare(`
      INSERT INTO sync_archive_file(
        id, task_space_id, snapshot_id, relative_path, blob_oid, sha256, content_text,
        task_id, task_dir, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insertArchiveFile.run(
      'af-active',
      taskSpaceId,
      'snap-active',
      '.trellis/tasks/archive/2026-11/11-21-git-archived/task.json',
      '1'.repeat(40),
      'a'.repeat(64),
      JSON.stringify({ id: 'git-archived', title: 'Git归档任务' }),
      'git-archived',
      '.trellis/tasks/archive/2026-11/11-21-git-archived',
      now,
    )
    insertArchiveFile.run(
      'af-stale',
      taskSpaceId,
      'snap-old',
      '.trellis/tasks/archive/2026-11/11-10-stale-snap/task.json',
      '2'.repeat(40),
      'b'.repeat(64),
      JSON.stringify({ id: 'stale-snap', title: '旧快照任务' }),
      'stale-snap',
      '.trellis/tasks/archive/2026-11/11-10-stale-snap',
      now,
    )

    const result = service.preflight('user-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      teamId: 'team-a',
    })
    assert.deepEqual(result.archivedTaskBasenames, ['11-21-git-archived'])
    assert.deepEqual(result.hiddenTaskDirs, ['.trellis/tasks/archive/2026-11/11-21-git-archived'])
  } finally {
    db.close()
  }
})

test('preflight 排除同用户其他设备持有有效活跃租约的任务并保留本机与过期租约任务', () => {
  const { db, service } = setup()
  try {
    const attached = service.attach('user-a', 'agent-a', {
      remoteUrl: 'https://example.com/acme/repo.git',
      branchName: 'main',
      displayName: 'Acme',
      teamId: 'team-a',
      developerId: 'alice',
      localRepoKey: 'a'.repeat(64),
    })
    const now = new Date().toISOString()
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const taskSpaceId = attached.taskSpace.id
    const projectId = attached.project.id
    const insertTask = db.prepare(`
      INSERT INTO sync_task(
        execution_task_key, task_key, task_space_id, project_id, task_id, relative_dir,
        title, description, priority, created_by_user_id, assignee_user_id, assignee_dev_id,
        stage, archived, materialization_state, task_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '', 'P2', 'user-a', ?, 'alice',
        'planning', 0, 'materialized', 1, ?, ?)
    `)
    const insertFile = db.prepare(`
      INSERT INTO sync_task_space_file(
        task_space_id, relative_path, revision, sha256, content_text, deleted,
        task_id, task_dir, updated_at
      ) VALUES (?, ?, 1, ?, ?, 0, ?, ?, ?)
    `)
    const insertLease = db.prepare(`
      INSERT INTO sync_task_lease(
        id, execution_task_key, agent_id, user_id, lease_token, status,
        expires_at, last_heartbeat_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'user-a', ?, 'active', ?, ?, ?, ?)
    `)
    db.prepare(
      `INSERT INTO agent_device(
        id, user_id, device_name, platform, agent_version, protocol_version,
        credential_hash, status, last_seen_at, created_at
      ) VALUES (?, 'user-a', 'other-pc', 'win32', '0.1.0', 3, 'agent-other-credential', 'active', ?, ?)`,
    ).run('agent-other', now, now)

    for (const item of [
      {
        id: 'held-other',
        dir: '.trellis/tasks/11-25-held-other',
        title: '他机租约中',
        leaseAgent: 'agent-other',
        expiresAt: future,
      },
      {
        id: 'held-self',
        dir: '.trellis/tasks/11-25-held-self',
        title: '本机租约中',
        leaseAgent: 'agent-a',
        expiresAt: future,
      },
      {
        id: 'expired-other',
        dir: '.trellis/tasks/11-25-expired',
        title: '租约已过期',
        leaseAgent: 'agent-other',
        expiresAt: past,
      },
    ]) {
      const key = `${taskSpaceId}::${item.id}`
      insertTask.run(
        key,
        `${taskSpaceId}::${item.dir}`,
        taskSpaceId,
        projectId,
        item.id,
        item.dir,
        item.title,
        'user-a',
        now,
        now,
      )
      insertFile.run(
        taskSpaceId,
        `${item.dir}/task.json`,
        '1'.repeat(64),
        JSON.stringify({ id: item.id, title: item.title, branch: 'main' }),
        item.id,
        item.dir,
        now,
      )
      insertLease.run(
        `lease-${item.id}`,
        key,
        item.leaseAgent,
        `token-${item.id}`,
        item.expiresAt,
        now,
        now,
        now,
      )
    }

    const result = service.preflight(
      'user-a',
      {
        remoteUrl: 'https://example.com/acme/repo.git',
        branchName: 'main',
        teamId: 'team-a',
      },
      { agentId: 'agent-a' },
    )
    assert.equal(result.status, 'existing')
    assert.deepEqual(
      result.tasks.map((task) => task.taskId),
      ['expired-other', 'held-self'],
    )
    assert.equal(JSON.stringify(result).includes('"content"'), false)
  } finally {
    db.close()
  }
})
