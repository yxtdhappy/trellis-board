import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { openDatabase, DATABASE_SCHEMA_VERSION } from '../database.js'
import { createPluginStore } from '../plugins/store.js'
import { makeWorkspace, openPluginDatabase } from '@trellis-board/test-support/plugin-runtime.js'

function workspaceDb() {
  const workspace = makeWorkspace()
  const db = openPluginDatabase(workspace)
  return {
    workspace,
    db,
    store: createPluginStore({ db }),
    close() {
      try {
        db.close()
      } catch {
        // 关闭失败不掩盖测试断言。
      }
      fs.rmSync(workspace.root, { recursive: true, force: true })
    },
  }
}

test('plugin_state 按插件前缀隔离并支持 list/delete', () => {
  const fixture = workspaceDb()
  try {
    const { store } = fixture
    store.setState('alpha', 'k', { a: 1 })
    store.setState('beta', 'k', { a: 2 })
    store.setState('alpha', 'session', { token: 'x' })
    assert.deepEqual(store.getState('alpha', 'k'), { a: 1 })
    assert.deepEqual(store.getState('beta', 'k'), { a: 2 })
    assert.equal(store.getState('alpha', 'missing'), null)
    const listed = store.listState('alpha')
    assert.deepEqual(listed.map((entry) => entry.key).sort(), ['k', 'session'])
    assert.equal(store.deleteState('alpha', 'k'), true)
    assert.equal(store.getState('alpha', 'k'), null)
    assert.equal(store.deleteState('alpha', 'k'), false)
  } finally {
    fixture.close()
  }
})

test('__manifest 快照用于升级/降级比较', () => {
  const fixture = workspaceDb()
  try {
    const { store } = fixture
    store.setManifest('alpha', { id: 'alpha', version: '1.0.0', apiVersion: 1 })
    assert.equal(store.getManifest('alpha').version, '1.0.0')
    store.setManifest('alpha', { id: 'alpha', version: '1.1.0', apiVersion: 1 })
    assert.equal(store.getManifest('alpha').version, '1.1.0')
  } finally {
    fixture.close()
  }
})

test('plugin_run 的状态流转、活动查询与尝试次数', () => {
  const fixture = workspaceDb()
  try {
    const { store } = fixture
    const run = store.createRun({
      runId: 'alpha:repo::task:1',
      pluginId: 'alpha',
      pluginVersion: '1.0.0',
      taskKey: 'repo::task',
      request: { prompt: 'x' },
    })
    assert.equal(run.status, 'queued')
    assert.deepEqual(run.request, { prompt: 'x' })
    assert.equal(store.findActiveRun('alpha', 'repo::task').runId, run.runId)
    assert.equal(store.nextAttempt('alpha', 'repo::task'), 2)

    store.updateRun(run.runId, { status: 'running' })
    assert.equal(store.findActiveRun('alpha', 'repo::task').status, 'running')
    store.updateRun(run.runId, { status: 'completed', result: { ok: true } })
    const finished = store.getRun(run.runId)
    assert.equal(finished.status, 'completed')
    assert.ok(finished.finishedAt)
    assert.equal(store.findActiveRun('alpha', 'repo::task'), null)
    assert.equal(store.listRuns({ pluginId: 'alpha' }).length, 1)
    assert.equal(store.listRuns({ pluginId: 'alpha', taskKey: 'other' }).length, 0)
  } finally {
    fixture.close()
  }
})

test('宿主重启时把未完成 run 标为 failed', () => {
  const fixture = workspaceDb()
  try {
    const { store } = fixture
    store.createRun({ runId: 'r1', pluginId: 'alpha', taskKey: 't' })
    store.createRun({ runId: 'r2', pluginId: 'alpha', taskKey: 't2' })
    store.updateRun('r2', { status: 'completed' })
    assert.equal(store.failInterruptedRuns(), 1)
    assert.equal(store.getRun('r1').status, 'failed')
    assert.equal(store.getRun('r2').status, 'completed')
  } finally {
    fixture.close()
  }
})

test('plugin_audit 追加并按时间倒序查询', () => {
  const fixture = workspaceDb()
  try {
    const { store } = fixture
    store.audit('alpha', 'loaded', { version: '1.0.0' }, { version: '1.0.0' })
    store.audit('alpha', 'started', null, { version: '1.0.0' })
    store.audit('beta', 'loaded', null, { version: '2.0.0' })
    const entries = store.listAudit('alpha')
    assert.deepEqual(
      entries.map((entry) => entry.kind),
      ['started', 'loaded'],
    )
    assert.equal(entries[1].detail.version, '1.0.0')
    assert.equal(store.listAudit('beta').length, 1)
  } finally {
    fixture.close()
  }
})

test('新库 schema v17 包含插件表并保留项目数据', () => {
  const workspace = makeWorkspace()
  const db = openPluginDatabase(workspace)
  try {
    const version = db
      .prepare("SELECT value FROM app_meta WHERE key = 'schema_version'")
      .get().value
    assert.equal(Number(version), DATABASE_SCHEMA_VERSION)
    assert.equal(DATABASE_SCHEMA_VERSION, 19)
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
    assert.ok(tables.includes('plugin_state'))
    assert.ok(tables.includes('plugin_run'))
    assert.ok(tables.includes('plugin_audit'))
    db.prepare(`
      INSERT INTO repositories(id, name, path, path_key, position, created_at, updated_at)
      VALUES ('repo', 'Repo', ?, ?, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run(workspace.repositoryPath, workspace.repositoryPath)
    assert.equal(db.prepare('SELECT id FROM repositories').get().id, 'repo')
  } finally {
    db.close()
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('schema v17 重复打开幂等且版本保持 17', () => {
  const workspace = makeWorkspace()
  const db = openPluginDatabase(workspace)
  db.close()
  const again = openDatabase({
    databaseFile: workspace.databaseFile,
    legacyFiles: workspace.legacyFiles,
    fallbackRepositories: [],
    logger: { warn() {} },
    legacyJsonImport: false,
  })
  try {
    const value = again
      .prepare("SELECT value FROM app_meta WHERE key = 'schema_version'")
      .get().value
    assert.equal(value, String(DATABASE_SCHEMA_VERSION))
    assert.equal(value, '19')
    assert.equal(path.basename(workspace.databaseFile), 'board.sqlite')
  } finally {
    again.close()
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('startRun 生成带 attempt 的 runId，并保证单任务单活动 run', () => {
  const fixture = workspaceDb()
  try {
    const { store } = fixture
    const first = store.startRun({
      pluginId: 'acp-dispatch',
      pluginVersion: '1.0.0',
      taskKey: 'repo::11-04-a',
    })
    assert.equal(first.started, true)
    assert.equal(first.run.runId, 'acp-dispatch:repo::11-04-a:1')
    assert.equal(first.run.status, 'running')

    const second = store.startRun({
      pluginId: 'acp-dispatch',
      pluginVersion: '1.0.0',
      taskKey: 'repo::11-04-a',
    })
    assert.equal(second.started, false)
    assert.equal(second.run.runId, first.run.runId)

    store.finishRun(first.run.runId, { status: 'succeeded', result: { ok: true } })
    const third = store.startRun({
      pluginId: 'acp-dispatch',
      pluginVersion: '1.0.0',
      taskKey: 'repo::11-04-a',
    })
    assert.equal(third.started, true)
    assert.equal(third.run.runId, 'acp-dispatch:repo::11-04-a:2')
  } finally {
    fixture.close()
  }
})

test('数据库唯一索引拒绝同一任务并行活动 run', () => {
  const fixture = workspaceDb()
  try {
    fixture.store.createRun({
      runId: 'acp-dispatch:repo::11-04-b:1',
      pluginId: 'acp-dispatch',
      taskKey: 'repo::11-04-b',
      status: 'running',
    })
    assert.throws(() => {
      fixture.store.createRun({
        runId: 'acp-dispatch:repo::11-04-b:2',
        pluginId: 'acp-dispatch',
        taskKey: 'repo::11-04-b',
        status: 'queued',
      })
    }, /UNIQUE constraint failed/)
  } finally {
    fixture.close()
  }
})

test('failActiveRuns 只收敛本插件的活动 run', () => {
  const fixture = workspaceDb()
  try {
    const { store } = fixture
    store.startRun({ pluginId: 'acp-dispatch', taskKey: 'repo::a' })
    store.startRun({ pluginId: 'demo-intake', taskKey: 'repo::b' })
    assert.equal(store.failActiveRuns('acp-dispatch', '插件已停止'), 1)
    const [acp] = store.listRuns({ pluginId: 'acp-dispatch' })
    assert.equal(acp.status, 'failed')
    assert.equal(acp.result.error, '插件已停止')
    const [demo] = store.listRuns({ pluginId: 'demo-intake' })
    assert.equal(demo.status, 'running')
  } finally {
    fixture.close()
  }
})
