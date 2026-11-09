import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from '../server/database.js'
import { createPersistenceStore } from '../server/persistence.js'

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-persistence-'))
  const dataDir = path.join(root, 'data')
  return {
    root,
    databaseFile: path.join(dataDir, 'board.sqlite'),
    legacyFiles: {
      repositoriesFile: path.join(dataDir, 'repos.json'),
      metadataFile: path.join(dataDir, 'task-metadata.json'),
      scanCacheFile: path.join(dataDir, 'scan-cache.json'),
      stateFile: path.join(dataDir, 'board-state.json'),
    },
  }
}

function openTestDatabase(workspace) {
  return openDatabase({
    databaseFile: workspace.databaseFile,
    legacyFiles: workspace.legacyFiles,
    fallbackRepositories: [],
    logger: { warn() {} },
  })
}

test('看板状态按字段原子写入并在重开后保留', () => {
  const workspace = makeWorkspace()
  let db
  try {
    db = openTestDatabase(workspace)
    const persistence = createPersistenceStore({ db })
    persistence.writeBoardState({
      refreshQueued: false,
      refreshQueuedReason: null,
      refreshReason: 'watcher',
      lastWatchEvent: {
        repositoryId: 'demo',
        relativePath: 'tasks/10-30-demo',
      },
    })
    assert.deepEqual(persistence.readBoardState(), {
      refreshQueued: false,
      refreshQueuedReason: null,
      refreshReason: 'watcher',
      lastWatchEvent: {
        repositoryId: 'demo',
        relativePath: 'tasks/10-30-demo',
      },
    })
    assert.equal(fs.existsSync(workspace.legacyFiles.stateFile), false)
    db.close()
    db = null

    db = openTestDatabase(workspace)
    const reopened = createPersistenceStore({ db })
    assert.equal(reopened.readBoardState().lastWatchEvent.repositoryId, 'demo')
    assert.equal(reopened.readBoardState().refreshQueued, false)
  } finally {
    try {
      db?.close()
    } catch {
      // 忽略已关闭连接。
    }
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('扫描缓存保留 schema 版本并拒绝不匹配或损坏内容', () => {
  const workspace = makeWorkspace()
  let db
  try {
    db = openTestDatabase(workspace)
    const persistence = createPersistenceStore({ db })
    const board = {
      generatedAt: '2026-10-30T02:00:00.000Z',
      projects: [{ id: 'demo' }],
      tasks: [{ taskKey: 'demo::.trellis/tasks/10-30-demo' }],
      stages: [],
    }
    const saved = persistence.writeScanCache(board, 8)
    assert.equal(saved.schemaVersion, 8)
    assert.deepEqual(persistence.readScanCache(8), board)
    assert.equal(persistence.readScanCache(9), null)
    assert.equal(fs.existsSync(workspace.legacyFiles.scanCacheFile), false)

    db.prepare('UPDATE scan_cache SET board_json = ? WHERE id = 1').run('{broken')
    assert.equal(persistence.readScanCache(8), null)
    db.prepare('UPDATE scan_cache SET board_json = ? WHERE id = 1').run('[]')
    assert.equal(persistence.readScanCache(8), null)
  } finally {
    try {
      db?.close()
    } catch {
      // 忽略已关闭连接。
    }
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('实现中 WIP 软上限默认 2、限制 1 到 9 并写入 board_state', () => {
  const workspace = makeWorkspace()
  let db
  try {
    db = openTestDatabase(workspace)
    const persistence = createPersistenceStore({ db })
    assert.equal(persistence.readExecutionWipLimit(), 2)
    assert.throws(() => persistence.writeExecutionWipLimit(0), /1 到 9/)
    assert.throws(() => persistence.writeExecutionWipLimit(10), /1 到 9/)
    assert.throws(() => persistence.writeExecutionWipLimit(2.5), /1 到 9/)
    assert.equal(persistence.writeExecutionWipLimit(4), 4)
    assert.equal(persistence.readExecutionWipLimit(), 4)
    db.close()
    db = null

    db = openTestDatabase(workspace)
    const reopened = createPersistenceStore({ db })
    assert.equal(reopened.readExecutionWipLimit(), 4)
  } finally {
    try {
      db?.close()
    } catch {
      // 忽略已关闭连接。
    }
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('看板状态多字段写入失败时整体回滚', () => {
  const workspace = makeWorkspace()
  let db
  try {
    db = openTestDatabase(workspace)
    const persistence = createPersistenceStore({ db })
    db.exec(`
      CREATE TRIGGER reject_board_state
      BEFORE INSERT ON board_state
      WHEN NEW.key = 'reject'
      BEGIN
        SELECT RAISE(ABORT, 'forced board state failure');
      END;
    `)
    assert.throws(
      () => persistence.writeBoardState({ accepted: true, reject: true }),
      /forced board state failure/,
    )
    assert.deepEqual(persistence.readBoardState(), {})
  } finally {
    try {
      db?.close()
    } catch {
      // 忽略已关闭连接。
    }
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})
