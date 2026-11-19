import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHarness, startHttpServer } from '@trellis-board/test-support/plugin-runtime.js'

const ID = 'scenario-copilot'
const MODULE = fileURLToPath(new URL('../index.js', import.meta.url))

async function post(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}/api/plugins/${ID}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

test('大纲关联、解析与回归预检按 manifest 工作', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'scenario-outline-'))
  await writeFile(path.join(dir, 'outline-a.md'), '# 大纲 A\n\n- 用例一\n', 'utf8')
  const repoRoot = path.join(dir, 'repo')
  const taskDir = path.join(repoRoot, '.trellis', 'tasks', '11-19-task-1')
  await mkdir(taskDir, { recursive: true })
  await writeFile(
    path.join(taskDir, 'task.json'),
    JSON.stringify(
      {
        title: '独立任务',
        status: 'in_progress',
        assignee: 'alice',
        priority: 'P1',
        relativeDir: '11-19-task-1',
        meta: {},
      },
      null,
      2,
    ),
    'utf8',
  )
  await writeFile(path.join(taskDir, 'prd.md'), '# 独立任务\n\n## 验收\n\n- 可运行\n', 'utf8')
  const harness = await createHarness({
    plugins: [
      {
        id: ID,
        module: MODULE,
        enabled: true,
        config: {
          outlinesDir: dir,
          defaultOutline: 'outline-a.md',
          targetUrl: 'https://example.test/app',
          scenarioRoot: dir,
        },
      },
    ],
    hostVersion: '0.2.0',
    repositories: [{ id: 'repo', name: 'Repo', path: repoRoot }],
  })
  const http = await startHttpServer(harness.runtime)
  try {
    const state = harness.supervisor.plugins.get(ID)
    assert.equal(state.status, 'running', `${ID} 未运行: ${state.lastError}`)

    const associated = await post(http.baseUrl, '/outlines/associate', {
      name: 'outline-a.md',
      scope: 'requirement',
      requirementIds: ['101'],
      requirementCodes: ['R101'],
      route: '/app',
    })
    assert.equal(associated.status, 200)
    assert.deepEqual(associated.body.outline.requirementIds, ['101'])
    assert.deepEqual(associated.body.outline.requirementCodes, ['R101'])

    const resolved = await post(http.baseUrl, '/outlines/resolve', {
      subjects: [
        {
          kind: 'requirement',
          key: 'requirement:101',
          requirementId: '101',
          requirementCode: 'R101',
          title: '测试需求',
        },
      ],
    })
    assert.equal(resolved.status, 200)
    const resolution = resolved.body.results['requirement:101']
    assert.equal(resolution.outline, 'outline-a.md')
    assert.equal(resolution.outlineSource, 'manifest-requirement')
    assert.equal(resolution.outlineConfidence, 'high')
    assert.equal(resolution.targetUrl, 'https://example.test/app')
    assert.equal(resolution.targetUrlSource, 'config')

    const ready = await post(http.baseUrl, '/regressions/preflight', {
      subjects: [
        {
          kind: 'requirement',
          key: 'requirement:101',
          requirementId: '101',
          requirementCode: 'R101',
          title: '测试需求',
        },
      ],
    })
    assert.equal(ready.status, 200)
    assert.equal(ready.body.ready, true)
    assert.deepEqual(ready.body.missing, [])

    const missing = await post(http.baseUrl, '/regressions/preflight', {
      subjects: [
        {
          kind: 'requirement',
          key: 'requirement:999',
          requirementId: '999',
          requirementCode: 'R999',
          title: '没有大纲的需求',
        },
      ],
    })
    assert.equal(missing.status, 200)
    assert.equal(missing.body.ready, false)
    assert.equal(missing.body.missing[0].reasons[0], 'outline-missing')

    const saved = await post(http.baseUrl, '/outlines/save', {
      name: 'outline-b.md',
      content: '# 大纲 B\n\n- 新用例\n',
      scope: 'task',
      taskKeys: ['repo::11-19-task-1'],
      route: '/task',
      source: 'generated',
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.body.outline.scope, 'task')
    assert.deepEqual(saved.body.outline.taskKeys, ['repo::11-19-task-1'])

    const defaults = await fetch(`${http.baseUrl}/api/plugins/${ID}/defaults`).then((response) =>
      response.json(),
    )
    const meta = defaults.outlines.find((outline) => outline.name === 'outline-b.md')
    assert.equal(meta.scope, 'task')
    assert.deepEqual(meta.taskKeys, ['repo::11-19-task-1'])

    const taskResolved = await post(http.baseUrl, '/outlines/resolve', {
      subjects: [
        {
          kind: 'trellis',
          key: 'trellis:repo::11-19-task-1',
          taskKey: 'repo::11-19-task-1',
          title: '独立任务',
        },
      ],
    })
    assert.equal(taskResolved.status, 200)
    const taskResolution = taskResolved.body.results['trellis:repo::11-19-task-1']
    assert.equal(taskResolution.outline, 'outline-b.md')
    assert.equal(taskResolution.outlineSource, 'manifest-task')
    assert.equal(taskResolution.outlineConfidence, 'high')
    assert.equal(taskResolution.targetUrl, 'https://example.test/app')
    assert.equal(taskResolution.targetUrlSource, 'config')
  } finally {
    await http.close()
    await harness.cleanup()
    await rm(dir, { recursive: true, force: true })
  }
})
