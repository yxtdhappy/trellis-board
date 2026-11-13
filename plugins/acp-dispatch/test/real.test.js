import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHarness } from '@trellis-board/test-support/plugin-runtime.js'
import { createTaskRepository } from '@trellis-board/test-support/task-repository.js'

// 默认跳过：需要本机已安装并登录 ACP agent，且会真实调用模型。
// 运行：TRELLIS_REAL_ACP=1 node --test plugins/acp-dispatch/test/real.test.js
const ENABLED = process.env.TRELLIS_REAL_ACP === '1'
const AGENT = process.env.TRELLIS_REAL_ACP_AGENT || 'opencode'

function writeTask(repo) {
  const dir = '11-04-real-acp'
  const full = path.join(repo.repositoryPath, '.trellis', 'tasks', dir)
  fs.mkdirSync(full, { recursive: true })
  fs.writeFileSync(
    path.join(full, 'task.json'),
    JSON.stringify(
      {
        title: '真实 ACP 端到端',
        status: 'in_progress',
        assignee: 'alice',
        priority: 'P1',
        meta: { agent: AGENT },
      },
      null,
      2,
    ),
  )
  fs.writeFileSync(
    path.join(full, 'prd.md'),
    '# 真实 ACP 端到端\n\n验收：当前目录出现 REAL_ACP_OK 文件。\n',
  )
  return `repo::${dir}`
}

test('真实 ACP agent 端到端：opencode acp 完成一次任务', { skip: !ENABLED }, async () => {
  const repo = createTaskRepository()
  const taskKey = writeTask(repo)
  const harness = await createHarness({
    plugins: [
      {
        id: 'acp-dispatch',
        module: fileURLToPath(new URL('../index.js', import.meta.url)),
        enabled: true,
        config: {
          agent: AGENT,
          command: AGENT,
          args: ['acp'],
          cwd: repo.repositoryPath,
          permission: { default: 'allow' },
          runTimeoutMs: 180_000,
          idleTimeoutMs: 120_000,
          promptTemplate:
            'Create a file named REAL_ACP_OK in the current directory containing exactly OK. Do not modify anything else.',
        },
      },
    ],
    repositories: repo.repositories,
    hostVersion: '0.2.0',
  })

  try {
    harness.runtime.publish('scan.completed', {})
    const deadline = Date.now() + 180_000
    let run = null
    while (Date.now() < deadline) {
      ;[run] = harness.store.listRuns({ pluginId: 'acp-dispatch', taskKey, limit: 1 })
      if (run && !['queued', 'starting', 'running'].includes(run.status)) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    assert.ok(run, '没有产生 plugin_run 记录')
    assert.equal(run.status, 'succeeded', `run 失败: ${run.error || 'unknown'}`)
    assert.equal(
      fs.readFileSync(path.join(repo.repositoryPath, 'REAL_ACP_OK'), 'utf8').trim(),
      'OK',
    )
  } finally {
    await harness.cleanup()
    fs.rmSync(repo.root, { recursive: true, force: true })
  }
})
