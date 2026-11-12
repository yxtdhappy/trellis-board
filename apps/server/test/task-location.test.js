import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from '../database.js'
import { clearScanCaches } from '../loader.js'
import { resolveTaskLocation } from '../task-location.js'

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-task-location-'))
  const repoPath = path.join(root, 'repo')
  fs.mkdirSync(path.join(repoPath, '.trellis', 'tasks', '10-30-one'), { recursive: true })
  fs.mkdirSync(path.join(repoPath, '.trellis', 'workspace', 'dev'), { recursive: true })
  fs.writeFileSync(path.join(repoPath, '.trellis', '.developer'), 'name=dev\n')
  fs.writeFileSync(
    path.join(repoPath, '.trellis', 'tasks', '10-30-one', 'task.json'),
    JSON.stringify({
      id: 'one',
      title: '任务一',
      status: 'planning',
      assignee: 'dev',
      creator: 'dev',
    }),
  )
  const dataDir = path.join(root, 'data')
  const db = openDatabase({
    databaseFile: path.join(dataDir, 'board.sqlite'),
    legacyFiles: {
      repositoriesFile: path.join(dataDir, 'repos.json'),
      metadataFile: path.join(dataDir, 'task-metadata.json'),
      scanCacheFile: path.join(dataDir, 'scan-cache.json'),
      stateFile: path.join(dataDir, 'board-state.json'),
    },
    fallbackRepositories: [],
    logger: { warn() {} },
  })
  return { root, repoPath, db }
}

function closeWorkspace(workspace) {
  clearScanCaches()
  try {
    workspace.db?.close()
  } catch {
    // 忽略已关闭连接。
  }
  fs.rmSync(workspace.root, { recursive: true, force: true })
}

test('任务定位只接受白名单仓库内的相对任务路径', () => {
  const workspace = makeWorkspace()
  try {
    const options = {
      repositories: [{ id: 'demo', name: 'Demo', path: workspace.repoPath }],
      db: workspace.db,
    }
    const resolved = resolveTaskLocation(
      {
        projectId: 'demo',
        taskPath: '.trellis/tasks/10-30-one',
      },
      options,
    )
    assert.equal(resolved.project.id, 'demo')
    assert.equal(resolved.task.title, '任务一')
    assert.equal(resolved.task.executionTaskKey, 'demo::one')
    assert.equal(resolved.task.executionIdentityValid, true)
    assert.equal(resolved.actor, 'dev')

    assert.throws(
      () =>
        resolveTaskLocation(
          {
            projectId: 'missing',
            taskPath: '.trellis/tasks/10-30-one',
          },
          options,
        ),
      /仓库不在白名单中/,
    )
    assert.throws(
      () =>
        resolveTaskLocation(
          {
            projectId: 'demo',
            taskPath: '../outside',
          },
          options,
        ),
      /\.trellis\/tasks/,
    )
    assert.throws(
      () =>
        resolveTaskLocation(
          {
            projectId: 'demo',
            taskPath: path.join(workspace.repoPath, '.trellis', 'tasks', '10-30-one'),
          },
          options,
        ),
      /相对路径/,
    )
  } finally {
    closeWorkspace(workspace)
  }
})

test('没有 board 快照时回退项目扫描并发现重复 id 冲突', () => {
  const workspace = makeWorkspace()
  try {
    const duplicateDir = path.join(workspace.repoPath, '.trellis', 'tasks', '10-31-copy')
    fs.mkdirSync(duplicateDir)
    fs.writeFileSync(
      path.join(duplicateDir, 'task.json'),
      JSON.stringify({ id: 'one', title: '重复任务', status: 'planning' }),
    )
    const resolved = resolveTaskLocation(
      {
        projectId: 'demo',
        taskPath: '.trellis/tasks/10-30-one',
      },
      {
        repositories: [{ id: 'demo', name: 'Demo', path: workspace.repoPath }],
        db: workspace.db,
      },
    )
    assert.equal(resolved.identityConflict, true)
    assert.equal(resolved.task.executionIdentityValid, false)
  } finally {
    closeWorkspace(workspace)
  }
})

test('有 board 快照时不扫描整仓，磁盘重复 id 不影响快照身份', () => {
  const workspace = makeWorkspace()
  try {
    const duplicateDir = path.join(workspace.repoPath, '.trellis', 'tasks', '10-31-copy')
    fs.mkdirSync(duplicateDir)
    fs.writeFileSync(
      path.join(duplicateDir, 'task.json'),
      JSON.stringify({ id: 'one', title: '重复任务', status: 'planning' }),
    )
    const resolved = resolveTaskLocation(
      {
        projectId: 'demo',
        taskPath: '.trellis/tasks/10-30-one',
      },
      {
        repositories: [{ id: 'demo', name: 'Demo', path: workspace.repoPath }],
        currentBoard: {
          projects: [{ id: 'demo', developer: 'dev' }],
          tasks: [
            {
              projectId: 'demo',
              taskKey: 'demo::.trellis/tasks/10-30-one',
              executionTaskKey: 'demo::one',
              executionIdentityValid: true,
            },
          ],
        },
        db: workspace.db,
      },
    )
    assert.equal(resolved.identityConflict, false)
    assert.equal(resolved.task.executionIdentityValid, true)
    assert.equal(resolved.task.executionTaskKey, 'demo::one')
  } finally {
    closeWorkspace(workspace)
  }
})

test('board 快照内重复执行身份会标记任务冲突', () => {
  const workspace = makeWorkspace()
  try {
    const resolved = resolveTaskLocation(
      {
        projectId: 'demo',
        taskPath: '.trellis/tasks/10-30-one',
      },
      {
        repositories: [{ id: 'demo', name: 'Demo', path: workspace.repoPath }],
        currentBoard: {
          tasks: [
            {
              projectId: 'demo',
              taskKey: 'demo::.trellis/tasks/10-30-one',
              executionTaskKey: 'demo::one',
              executionIdentityValid: true,
            },
            {
              projectId: 'demo',
              taskKey: 'demo::.trellis/tasks/10-31-copy',
              executionTaskKey: 'demo::one',
              executionIdentityValid: true,
            },
          ],
        },
        db: workspace.db,
      },
    )
    assert.equal(resolved.identityConflict, true)
    assert.equal(resolved.task.executionIdentityValid, false)
  } finally {
    closeWorkspace(workspace)
  }
})

test('快照后任务 id 漂移到另一任务身份时拒绝共享写入', () => {
  const workspace = makeWorkspace()
  try {
    fs.writeFileSync(
      path.join(workspace.repoPath, '.trellis', 'tasks', '10-30-one', 'task.json'),
      JSON.stringify({
        id: 'two',
        title: '任务一',
        status: 'planning',
        assignee: 'dev',
        creator: 'dev',
      }),
    )
    const resolved = resolveTaskLocation(
      {
        projectId: 'demo',
        taskPath: '.trellis/tasks/10-30-one',
      },
      {
        repositories: [{ id: 'demo', name: 'Demo', path: workspace.repoPath }],
        currentBoard: {
          tasks: [
            {
              projectId: 'demo',
              taskKey: 'demo::.trellis/tasks/10-30-one',
              executionTaskKey: 'demo::one',
              executionIdentityValid: true,
            },
            {
              projectId: 'demo',
              taskKey: 'demo::.trellis/tasks/10-31-two',
              executionTaskKey: 'demo::two',
              executionIdentityValid: true,
            },
          ],
        },
        db: workspace.db,
      },
    )
    assert.equal(resolved.identityConflict, true)
    assert.equal(resolved.task.executionIdentityValid, false)
  } finally {
    closeWorkspace(workspace)
  }
})

test('快照外新路径复用已有任务身份时拒绝共享写入', () => {
  const workspace = makeWorkspace()
  try {
    fs.writeFileSync(
      path.join(workspace.repoPath, '.trellis', 'tasks', '10-30-one', 'task.json'),
      JSON.stringify({
        id: 'two',
        title: '任务一',
        status: 'planning',
        assignee: 'dev',
        creator: 'dev',
      }),
    )
    const resolved = resolveTaskLocation(
      {
        projectId: 'demo',
        taskPath: '.trellis/tasks/10-30-one',
      },
      {
        repositories: [{ id: 'demo', name: 'Demo', path: workspace.repoPath }],
        currentBoard: {
          tasks: [
            {
              projectId: 'demo',
              taskKey: 'demo::.trellis/tasks/10-31-two',
              executionTaskKey: 'demo::two',
              executionIdentityValid: true,
            },
          ],
        },
        db: workspace.db,
      },
    )
    assert.equal(resolved.identityConflict, true)
    assert.equal(resolved.task.executionIdentityValid, false)
  } finally {
    closeWorkspace(workspace)
  }
})
