import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from '@trellis-board/server/database.js'
import { createUser } from '@trellis-board/server/team/auth.js'

/**
 * team 插件测试的公共夹具：一个库 + 两个团队 + 三个用户 + 一个项目。
 *
 * 不用 HTTP 运行时（太重），直接写表；需要 HTTP 的用例自己起 `createTeamRuntime`。
 */

export const PLUGIN_TEST_PASSWORD = 'Team-Plugin-Password-123'

export function makePluginWorkspace({ prefix = 'trellis-team-plugin-' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}${process.pid}-`))
  const dataDir = path.join(root, 'data')
  const pluginsDir = path.join(root, 'plugins')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(pluginsDir, { recursive: true })
  return {
    root,
    dataDir,
    pluginsDir,
    databaseFile: path.join(dataDir, 'board.sqlite'),
    legacyFiles: {
      repositoriesFile: path.join(dataDir, 'repos.json'),
      metadataFile: path.join(dataDir, 'task-metadata.json'),
      scanCacheFile: path.join(dataDir, 'scan-cache.json'),
      stateFile: path.join(dataDir, 'board-state.json'),
    },
  }
}

export function openPluginWorkspaceDatabase(workspace) {
  return openDatabase({
    databaseFile: workspace.databaseFile,
    legacyFiles: workspace.legacyFiles,
    fallbackRepositories: [],
    logger: { warn() {} },
    legacyJsonImport: false,
  })
}

/**
 * 写入两个团队、三个用户和一个项目：
 * - admin：系统管理员，同时是 team-a 的 admin；
 * - lead：team-a 成员，project-a 的 lead；
 * - member：team-a 成员，project-a 的 member，没有团队管理员权限。
 */
export async function seedTeamPluginFixtures(db) {
  const now = new Date().toISOString()
  for (const [id, name] of [
    ['team-a', '团队 A'],
    ['team-b', '团队 B'],
  ]) {
    db.prepare(
      `
      INSERT INTO team(id, name, slug, status, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?)
    `,
    ).run(id, name, id, now, now)
  }

  const admin = await createUser(db, {
    username: 'plugin-admin',
    displayName: '系统管理员',
    password: PLUGIN_TEST_PASSWORD,
    mustChangePassword: false,
  })
  db.prepare('UPDATE user_account SET system_admin = 1 WHERE id = ?').run(admin.id)
  const lead = await createUser(db, {
    username: 'plugin-lead',
    displayName: '项目负责人',
    password: PLUGIN_TEST_PASSWORD,
    mustChangePassword: false,
  })
  const member = await createUser(db, {
    username: 'plugin-member',
    displayName: '项目成员',
    password: PLUGIN_TEST_PASSWORD,
    mustChangePassword: false,
  })

  for (const [teamId, userId, role] of [
    ['team-a', admin.id, 'admin'],
    ['team-a', lead.id, 'member'],
    ['team-a', member.id, 'member'],
  ]) {
    db.prepare(
      `
      INSERT INTO team_member(team_id, user_id, role, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `,
    ).run(teamId, userId, role, now, now)
  }

  db.prepare(
    `
    INSERT INTO repositories(id, name, path, path_key, position, created_at, updated_at)
    VALUES ('project-a', '项目 A', '/tmp/project-a', '/tmp/project-a', 0, ?, ?)
  `,
  ).run(now, now)
  db.prepare(
    `
    INSERT INTO team_project(
      repository_id, team_id, workspace_key, remote_url, remote_identity_hash,
      sync_branch, sync_status, created_at, updated_at
    ) VALUES ('project-a', 'team-a', 'project-a', 'https://example.com/a.git', 'hash-a',
      'main', 'current', ?, ?)
  `,
  ).run(now, now)
  for (const [userId, role, developerId] of [
    [lead.id, 'lead', 'alice'],
    [member.id, 'member', 'bob'],
  ]) {
    db.prepare(
      `
      INSERT INTO project_member(
        project_id, user_id, role, trellis_dev_id, created_by, created_at, updated_at
      ) VALUES ('project-a', ?, ?, ?, ?, ?, ?)
    `,
    ).run(userId, role, developerId, admin.id, now, now)
  }

  return { admin, lead, member }
}

export function actorFor(user, { systemAdmin = false, teams = [] } = {}) {
  return {
    userId: user.id,
    systemAdmin,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      systemAdmin,
      mustChangePassword: false,
    },
    teams,
    activeTeamId: null,
  }
}

export function cleanupWorkspace(workspace, db) {
  try {
    db?.close()
  } catch {
    // 关闭失败不掩盖断言。
  }
  fs.rmSync(workspace.root, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 50,
  })
}
