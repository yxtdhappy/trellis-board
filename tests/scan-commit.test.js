import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from '../server/database.js'
import { createExecutionStore } from '../server/execution-store.js'
import { createPersistenceStore } from '../server/persistence.js'

const SCAN_SCHEMA_VERSION = 11

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-scan-commit-'))
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

function createStores(db) {
  return {
    persistence: createPersistenceStore({ db }),
    executionStore: createExecutionStore({
      db,
      stageIds: ['prd', 'design', 'implement', 'check'],
    }),
  }
}

function closeQuietly(db) {
  try {
    db?.close()
  } catch {
    // 数据库可能已在失败路径关闭。
  }
}

function boardWithStage(derivedStage) {
  return {
    generatedAt: `2026-10-30T0${derivedStage === 'design' ? 0 : 1}:00:00.000Z`,
    tasks: [
      {
        executionTaskKey: 'demo::active',
        executionIdentityValid: true,
        executionIdentityConflict: false,
        archived: false,
        derivedStage,
      },
    ],
  }
}

test('扫描事件与缓存同事务提交，缓存失败整体回滚且重启不重复观察', () => {
  const workspace = makeWorkspace()
  let db
  try {
    db = openTestDatabase(workspace)
    let { persistence, executionStore } = createStores(db)
    const baselineBoard = boardWithStage('design')
    const changedBoard = boardWithStage('implement')

    const baseline = persistence.writeScanCache(baselineBoard, SCAN_SCHEMA_VERSION, {
      beforeCommit: () =>
        executionStore.recordScanObservationsInTransaction({
          tasks: baselineBoard.tasks,
          previousTasks: [],
          occurredAt: '2026-10-30T00:00:00.000Z',
        }),
    })
    assert.deepEqual(baseline.beforeCommitResult, { baselines: 1, observations: 0 })
    assert.equal(executionStore.getExecutionDetail('demo::active').eventTotal, 1)

    db.exec(`
      CREATE TRIGGER reject_scan_cache_insert
      BEFORE INSERT ON scan_cache
      BEGIN
        SELECT RAISE(ABORT, 'forced cache failure');
      END;
      CREATE TRIGGER reject_scan_cache_update
      BEFORE UPDATE ON scan_cache
      BEGIN
        SELECT RAISE(ABORT, 'forced cache failure');
      END;
    `)
    assert.throws(
      () =>
        persistence.writeScanCache(changedBoard, SCAN_SCHEMA_VERSION, {
          beforeCommit: () =>
            executionStore.recordScanObservationsInTransaction({
              tasks: changedBoard.tasks,
              previousTasks: baselineBoard.tasks,
              occurredAt: '2026-10-30T01:00:00.000Z',
            }),
        }),
      /forced cache failure/,
    )
    assert.deepEqual(persistence.readScanCache(SCAN_SCHEMA_VERSION), baselineBoard)
    assert.equal(executionStore.getExecutionDetail('demo::active').eventTotal, 1)

    db.exec(`
      DROP TRIGGER reject_scan_cache_insert;
      DROP TRIGGER reject_scan_cache_update;
    `)
    const committed = persistence.writeScanCache(changedBoard, SCAN_SCHEMA_VERSION, {
      beforeCommit: () =>
        executionStore.recordScanObservationsInTransaction({
          tasks: changedBoard.tasks,
          previousTasks: baselineBoard.tasks,
          occurredAt: '2026-10-30T01:00:00.000Z',
        }),
    })
    assert.deepEqual(committed.beforeCommitResult, { baselines: 0, observations: 1 })
    assert.deepEqual(persistence.readScanCache(SCAN_SCHEMA_VERSION), changedBoard)
    const detail = executionStore.getExecutionDetail('demo::active')
    assert.equal(detail.eventTotal, 2)
    assert.equal(detail.events[0].type, 'stage_observed')

    db.close()
    db = null
    db = openTestDatabase(workspace)
    ;({ persistence, executionStore } = createStores(db))
    const reopenedBoard = persistence.readScanCache(SCAN_SCHEMA_VERSION)
    assert.deepEqual(reopenedBoard, changedBoard)
    const unchanged = persistence.writeScanCache(reopenedBoard, SCAN_SCHEMA_VERSION, {
      beforeCommit: () =>
        executionStore.recordScanObservationsInTransaction({
          tasks: reopenedBoard.tasks,
          previousTasks: reopenedBoard.tasks,
          occurredAt: '2026-10-30T02:00:00.000Z',
        }),
    })
    assert.deepEqual(unchanged.beforeCommitResult, { baselines: 0, observations: 0 })
    assert.equal(executionStore.getExecutionDetail('demo::active').eventTotal, 2)
  } finally {
    closeQuietly(db)
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})
