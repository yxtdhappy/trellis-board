import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { repositoryPathKey, resolveBoardDataDir } from '../config.js'
import { migrateLegacyRuntimeData } from '../data-migration.js'
import { openDatabase } from '../database.js'

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-data-migration-'))
}

function seedLegacyData(root) {
  const sourceDir = path.join(root, 'repo', 'data')
  const projectPath = path.join(sourceDir, 'projects', 'workspace-1')
  fs.mkdirSync(path.join(projectPath, '.trellis'), { recursive: true })
  fs.mkdirSync(path.join(sourceDir, 'plugins'), { recursive: true })
  fs.writeFileSync(path.join(sourceDir, 'plugins', 'demo.json'), '{}')
  fs.mkdirSync(path.join(sourceDir, '.git-auth', 'run-stale'), { recursive: true })
  fs.writeFileSync(path.join(sourceDir, '.git-auth', 'run-stale', 'identity'), 'stale')
  fs.mkdirSync(path.join(sourceDir, '.empty-git-hooks'), { recursive: true })
  fs.writeFileSync(path.join(sourceDir, '.empty-git-config'), '')
  fs.writeFileSync(path.join(sourceDir, 'unknown.txt'), 'keep')
  fs.writeFileSync(path.join(sourceDir, 'plugins.example.json'), '{}')

  const db = openDatabase({
    databaseFile: path.join(sourceDir, 'board.sqlite'),
    legacyFiles: {},
    fallbackRepositories: [],
    legacyJsonImport: false,
    logger: { warn() {} },
  })
  const now = new Date().toISOString()
  db.prepare(
    "INSERT INTO team(id, name, slug, status, created_at, updated_at) VALUES ('t1','团队一','t1','active',?,?)",
  ).run(now, now)
  db.prepare(`
    INSERT INTO repositories(id, name, path, path_key, position, created_at, updated_at)
    VALUES ('p1', '项目一', ?, ?, 0, ?, ?)
  `).run(projectPath, projectPath.toLowerCase(), now, now)
  db.prepare(`
    INSERT INTO team_project(
      repository_id, team_id, workspace_key, remote_url, remote_identity_hash,
      sync_branch, trusted_task_toolchain_sha256, sync_status, created_at, updated_at
    ) VALUES ('p1', 't1', 'workspace-1', 'https://example.com/p1.git', 'hash',
      'main', ?, 'current', ?, ?)
  `).run('a'.repeat(64), now, now)
  db.close()
  return { sourceDir, projectPath }
}

test('数据根按显式环境和平台默认值解析', () => {
  assert.equal(
    resolveBoardDataDir({
      platform: 'linux',
      env: { TRELLIS_BOARD_DATA_DIR: '/srv/trellis-board' },
      homeDir: '/home/alice',
    }),
    '/srv/trellis-board',
  )
  assert.equal(
    resolveBoardDataDir({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
      homeDir: 'C:\\Users\\alice',
    }),
    'C:\\Users\\alice\\AppData\\Local\\TrellisBoard\\server',
  )
  assert.equal(
    resolveBoardDataDir({
      platform: 'darwin',
      env: {},
      homeDir: '/Users/alice',
    }),
    '/Users/alice/Library/Application Support/TrellisBoard/server',
  )
  assert.equal(
    resolveBoardDataDir({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/var/data/alice' },
      homeDir: '/home/alice',
    }),
    '/var/data/alice/TrellisBoard/server',
  )
  assert.equal(
    resolveBoardDataDir({
      platform: 'linux',
      env: {},
      homeDir: '/home/alice',
    }),
    '/home/alice/.local/share/TrellisBoard/server',
  )
})

test('只迁移运行数据并重写受管项目路径', () => {
  const root = makeRoot()
  try {
    const { sourceDir } = seedLegacyData(root)
    const targetDir = path.join(root, 'appdata', 'TrellisBoard', 'server')
    const result = migrateLegacyRuntimeData({
      sourceDir,
      targetDir,
      logger: { warn() {} },
    })
    assert.equal(result.migrated, true)
    assert.equal(fs.existsSync(path.join(targetDir, 'board.sqlite')), true)
    assert.equal(fs.existsSync(path.join(targetDir, '.layout-v1')), true)
    assert.equal(
      fs.readdirSync(path.join(targetDir, 'backups')).some((name) => name.startsWith('layout-v1-')),
      true,
    )
    assert.equal(fs.existsSync(path.join(targetDir, 'plugins', 'demo.json')), true)
    assert.equal(fs.existsSync(path.join(targetDir, 'unknown.txt')), false)
    assert.equal(fs.existsSync(path.join(targetDir, 'plugins.example.json')), false)
    assert.equal(fs.existsSync(path.join(sourceDir, 'board.sqlite')), false)
    assert.equal(fs.existsSync(path.join(sourceDir, 'plugins')), false)
    assert.equal(fs.existsSync(path.join(sourceDir, 'projects')), false)
    assert.equal(fs.existsSync(path.join(sourceDir, '.git-auth')), false)
    assert.equal(fs.existsSync(path.join(sourceDir, '.empty-git-hooks')), false)
    assert.equal(fs.existsSync(path.join(sourceDir, '.empty-git-config')), false)
    assert.equal(fs.existsSync(path.join(sourceDir, 'unknown.txt')), true)
    assert.equal(fs.existsSync(path.join(sourceDir, 'plugins.example.json')), true)
    assert.equal(
      migrateLegacyRuntimeData({ sourceDir, targetDir, logger: { warn() {} } }).migrated,
      false,
    )

    const db = new DatabaseSync(path.join(targetDir, 'board.sqlite'), { readOnly: true })
    try {
      const repository = db.prepare("SELECT path, path_key FROM repositories WHERE id = 'p1'").get()
      assert.equal(
        repository.path,
        path.join(targetDir, 'projects', 'workspace-1').replaceAll('\\', '/'),
      )
      assert.equal(repository.path_key, repositoryPathKey(repository.path))
    } finally {
      db.close()
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('拒绝把运行数据目录放回源码工作树', () => {
  const root = makeRoot()
  try {
    const sourceDir = path.join(root, 'repo', 'data')
    fs.mkdirSync(sourceDir, { recursive: true })
    fs.writeFileSync(path.join(sourceDir, 'plugins.json'), '{}')
    assert.throws(
      () =>
        migrateLegacyRuntimeData({
          sourceDir,
          targetDir: path.join(root, 'repo', 'nested-data'),
          appRoot: path.join(root, 'repo'),
          logger: { warn() {} },
        }),
      /必须位于源码工作树之外/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('目标已有数据库时拒绝自动合并旧数据', () => {
  const root = makeRoot()
  try {
    const sourceDir = path.join(root, 'repo', 'data')
    const targetDir = path.join(root, 'appdata')
    fs.mkdirSync(sourceDir, { recursive: true })
    fs.writeFileSync(path.join(sourceDir, 'plugins.json'), '{}')
    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(path.join(targetDir, 'board.sqlite'), 'existing')
    assert.throws(() => migrateLegacyRuntimeData({ sourceDir, targetDir }), /旧运行数据未自动合并/)
    assert.equal(fs.readFileSync(path.join(targetDir, 'board.sqlite'), 'utf8'), 'existing')
    assert.equal(fs.existsSync(path.join(targetDir, 'plugins.json')), false)
    assert.equal(fs.existsSync(path.join(sourceDir, 'plugins.json')), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('目标目录只有布局标记时可以迁移后续出现的旧运行数据', () => {
  const root = makeRoot()
  try {
    const sourceDir = path.join(root, 'repo', 'data')
    const targetDir = path.join(root, 'appdata')
    fs.mkdirSync(sourceDir, { recursive: true })
    fs.mkdirSync(targetDir, { recursive: true })
    fs.writeFileSync(path.join(sourceDir, 'plugins.json'), '{"plugins":[]}')
    fs.writeFileSync(path.join(targetDir, '.layout-v1'), 'initialized\n')

    const result = migrateLegacyRuntimeData({ sourceDir, targetDir })

    assert.equal(result.migrated, true)
    assert.deepEqual(result.entries, ['plugins.json'])
    assert.equal(fs.readFileSync(path.join(targetDir, 'plugins.json'), 'utf8'), '{"plugins":[]}')
    assert.equal(fs.existsSync(path.join(targetDir, '.layout-v1')), true)
    assert.equal(fs.existsSync(path.join(sourceDir, 'plugins.json')), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('没有旧运行数据时重复启动保持幂等', () => {
  const root = makeRoot()
  try {
    const sourceDir = path.join(root, 'repo', 'data')
    const targetDir = path.join(root, 'appdata')
    fs.mkdirSync(sourceDir, { recursive: true })
    fs.writeFileSync(path.join(sourceDir, 'plugins.example.json'), '{}')
    assert.equal(migrateLegacyRuntimeData({ sourceDir, targetDir }).migrated, false)
    assert.equal(migrateLegacyRuntimeData({ sourceDir, targetDir }).migrated, false)
    assert.deepEqual(fs.readdirSync(targetDir), ['.layout-v1'])
    assert.equal(fs.existsSync(path.join(sourceDir, 'plugins.example.json')), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('迁移失败时保留源运行数据并清理 staging', () => {
  const root = makeRoot()
  try {
    const sourceDir = path.join(root, 'repo', 'data')
    const targetDir = path.join(root, 'appdata')
    fs.mkdirSync(sourceDir, { recursive: true })
    fs.writeFileSync(path.join(sourceDir, 'plugins.json'), '{"plugins":[]}')
    fs.writeFileSync(targetDir, 'not-a-directory')
    assert.throws(
      () => migrateLegacyRuntimeData({ sourceDir, targetDir, logger: { warn() {} } }),
      /目标数据路径不是目录/,
    )
    assert.equal(fs.existsSync(path.join(sourceDir, 'plugins.json')), true)
    assert.deepEqual(
      fs.readdirSync(root).filter((name) => name.startsWith('.trellis-board-data-')),
      [],
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
