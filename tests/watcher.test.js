import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createWatchRuntime,
  isRelevantTrellisChange,
  normalizeWatchPath,
} from '../server/watcher.js'
import { createTrellisWatcher } from '../shared/trellis-watcher.js'

test('只把 Trellis 任务、工作区与开发者变更视为看板相关事件', () => {
  assert.equal(isRelevantTrellisChange('tasks/10-27-demo/task.json'), true)
  assert.equal(isRelevantTrellisChange('tasks\\10-27-demo\\task.json'), true)
  assert.equal(isRelevantTrellisChange('workspace/dev/journal-1.md'), true)
  assert.equal(isRelevantTrellisChange('.developer'), true)
  assert.equal(isRelevantTrellisChange('scripts/task.py'), false)
  assert.equal(isRelevantTrellisChange('config.yaml'), false)
  assert.equal(isRelevantTrellisChange(''), false)
  assert.equal(isRelevantTrellisChange('tasks/a/task.json', ['tasks']), true)
  assert.equal(isRelevantTrellisChange('workspace/dev/journal-1.md', ['tasks']), false)
  assert.equal(isRelevantTrellisChange('.developer', ['tasks']), false)
  assert.equal(normalizeWatchPath('./tasks/demo/'), 'tasks/demo')
})

test('任务文件变更会触发监听回调', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-watch-'))
  const tasksDir = path.join(root, '.trellis', 'tasks')
  fs.mkdirSync(tasksDir, { recursive: true })
  fs.writeFileSync(path.join(root, '.trellis', '.developer'), 'name=dev\n')

  let finish
  let settled = false
  let timer
  const runtime = createWatchRuntime({
    repositories: [{ id: 'demo', name: 'Demo', path: root }],
    onChange: (event) => {
      if (event.relativePath === 'tasks/10-27-live/task.json') finish(event)
    },
    onError: (error) => finish(null, new Error(error.message)),
  })

  const changed = new Promise((resolve, reject) => {
    finish = (event, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(event)
    }
  })
  timer = setTimeout(() => finish(null, new Error('等待文件变更超时')), 5000)

  try {
    await new Promise((resolve) => setTimeout(resolve, 100))
    fs.mkdirSync(path.join(tasksDir, '10-27-live'), { recursive: true })
    fs.writeFileSync(
      path.join(tasksDir, '10-27-live', 'task.json'),
      JSON.stringify({ id: 'live', title: 'Live', status: 'planning' }),
    )
    const event = await changed
    assert.equal(event.repositoryId, 'demo')
    assert.match(event.relativePath, /tasks\/10-27-live\/task\.json/)
  } finally {
    runtime.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('共享 watcher 支持防抖批次与动态重建', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-shared-watch-'))
  fs.mkdirSync(path.join(root, '.trellis'), { recursive: true })
  let callback
  let closed = 0
  const batches = []
  const runtime = createTrellisWatcher({
    repositories: [{ id: 'demo', name: 'Demo', path: root }],
    debounceMs: 10,
    watch: (_root, _options, handler) => {
      callback = handler
      return {
        on() {},
        close() {
          closed += 1
        },
      }
    },
    onChange: (events) => batches.push(events),
  })
  try {
    callback('change', 'tasks/a/task.json')
    callback('change', 'workspace/dev/journal-1.md')
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(batches.length, 1)
    assert.equal(batches[0].length, 2)
    assert.equal(batches[0][0].trellisPath, '.trellis/tasks/a/task.json')

    runtime.rebuild([])
    assert.equal(closed, 1)
    assert.deepEqual(runtime.status().watchedRepositories, [])
    assert.deepEqual(runtime.status().watchedRoots, ['tasks', 'workspace', '.developer'])
  } finally {
    runtime.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
