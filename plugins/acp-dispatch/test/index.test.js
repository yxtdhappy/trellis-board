import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHarness, startHttpServer, waitFor } from '../../../packages/test-support/plugin-runtime.js'
import { createWatchRuntime } from '../../../apps/server/watcher.js'
import { clearScanCaches, scanRepository } from '../../../apps/server/loader.js'
import { createTaskRepository } from '../../../packages/test-support/task-repository.js'

const PLUGIN_MODULE = fileURLToPath(new URL('../index.js', import.meta.url))
const FAKE_AGENT = fileURLToPath(new URL('./fixtures/fake-agent.js', import.meta.url))

function writeTask(
  repo,
  { dir = '11-04-run1', title = '示例任务', status = 'in_progress', agent = 'opencode' } = {},
) {
  const full = path.join(repo.repositoryPath, '.trellis', 'tasks', dir)
  fs.mkdirSync(full, { recursive: true })
  fs.writeFileSync(
    path.join(full, 'task.json'),
    JSON.stringify(
      { title, status, assignee: 'bob', priority: 'P1', meta: agent ? { agent } : {} },
      null,
      2,
    ),
  )
  fs.writeFileSync(path.join(full, 'prd.md'), '# 示例\n\n验收：测试通过\n')
  return `repo::${dir}`
}

async function setup({ env = {}, config = {}, tasks = [{}], writeCheckReport = false } = {}) {
  const repo = createTaskRepository()
  const traceFile = path.join(repo.root, 'acp-trace.jsonl')
  const taskKeys = tasks.map((task) => writeTask(repo, task))
  const checkReportEnv = writeCheckReport
    ? {
        FAKE_ACP_WRITE_FILE: path.join(
          repo.repositoryPath,
          '.trellis',
          'tasks',
          tasks[0].dir || '11-04-run1',
          'check-report.md',
        ),
        FAKE_ACP_WRITE_CONTENT: '# 检查\n\n- npm test: 263 pass\n',
      }
    : {}
  const harness = await createHarness({
    plugins: [
      {
        id: 'acp-dispatch',
        module: PLUGIN_MODULE,
        enabled: true,
        config: {
          agent: 'opencode',
          command: process.execPath,
          args: [FAKE_AGENT],
          cwd: repo.repositoryPath,
          permission: { default: 'allow' },
          runTimeoutMs: 5000,
          env: { FAKE_ACP_TRACE: traceFile, ...checkReportEnv, ...env },
          ...config,
        },
      },
    ],
    repositories: repo.repositories,
    hostVersion: '0.2.0',
  })
  const http = await startHttpServer(harness.runtime)
  return {
    repo,
    harness,
    http,
    taskKeys,
    traceFile,
    trace() {
      if (!fs.existsSync(traceFile)) return []
      return fs
        .readFileSync(traceFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    },
    runs(taskKey, limit = 20) {
      return harness.store.listRuns({ pluginId: 'acp-dispatch', taskKey, limit })
    },
    async waitForRun(taskKey, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const [run] = harness.store.listRuns({ pluginId: 'acp-dispatch', taskKey, limit: 1 })
        if (run && !['queued', 'starting', 'running'].includes(run.status)) return run
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
      throw new Error(`等待运行结束超时: ${taskKey}`)
    },
    async cleanup() {
      await http.close()
      await harness.cleanup()
      fs.rmSync(repo.root, { recursive: true, force: true })
    },
  }
}

test('派发 in_progress 任务：握手、建会话、提示词、allow_once 决策', async () => {
  const context = await setup()
  try {
    context.harness.runtime.publish('scan.completed', {})
    const state = await context.waitForRun(context.taskKeys[0])
    assert.equal(state.status, 'succeeded')

    const trace = context.trace()
    const methods = trace.filter((entry) => entry.dir === 'in').map((entry) => entry.message.method)
    assert.ok(methods.includes('initialize'))
    assert.ok(methods.includes('session/new'))
    assert.ok(methods.includes('session/prompt'))

    const prompt = trace.find((entry) => entry.message.method === 'session/prompt')
    assert.match(prompt.message.params.prompt[0].text, /11-04-run1/)
    assert.equal(prompt.message.params.sessionId, 'sess-1')

    const decision = trace.find((entry) => entry.dir === 'decision')
    assert.equal(decision.result.outcome.outcome, 'selected')
    assert.equal(decision.result.outcome.optionId, 'opt-allow')

    assert.equal(state.runId, `acp-dispatch:${context.taskKeys[0]}:1`)
    assert.equal(state.result.outcome.stopReason, 'end_turn')
    assert.ok(state.result.stats.permissions.allow >= 1)
    assert.ok(state.result.stats.updates >= 1)
    assert.match(state.result.summary.text, /完成/)
  } finally {
    await context.cleanup()
  }
})

test('byKind=deny 时选择 reject_once', async () => {
  const context = await setup({
    config: { permission: { default: 'allow', byKind: { edit: 'deny' } } },
  })
  try {
    context.harness.runtime.publish('scan.completed', {})
    await context.waitForRun(context.taskKeys[0])
    const decision = context.trace().find((entry) => entry.dir === 'decision')
    assert.equal(decision.result.outcome.optionId, 'opt-reject')
  } finally {
    await context.cleanup()
  }
})

test('toolCall 缺 kind 时回退到缓存，缓存也没有则按 other 处理', async () => {
  const context = await setup({
    env: { FAKE_ACP_KIND: 'switch_mode' },
    config: { permission: { default: 'allow', byKind: { switch_mode: 'deny', other: 'deny' } } },
  })
  try {
    context.harness.runtime.publish('scan.completed', {})
    await context.waitForRun(context.taskKeys[0])
    const decision = context.trace().find((entry) => entry.dir === 'decision')
    assert.equal(decision.result.outcome.optionId, 'opt-reject')
  } finally {
    await context.cleanup()
  }
})

test('没有对应极性的选项时回 cancelled 并记录 permission-unavailable', async () => {
  const context = await setup({ env: { FAKE_ACP_REJECT_ONLY: '1' } })
  try {
    context.harness.runtime.publish('scan.completed', {})
    const state = await context.waitForRun(context.taskKeys[0])
    const decision = context.trace().find((entry) => entry.dir === 'decision')
    assert.equal(decision.result.outcome.outcome, 'cancelled')
    assert.equal(state.result.stats.permissions.allow, 0)
  } finally {
    await context.cleanup()
  }
})

test('运行超时触发 session/cancel 并标记 timeout', async () => {
  const context = await setup({
    env: { FAKE_ACP_HANG: '1' },
    config: { runTimeoutMs: 700 },
  })
  try {
    context.harness.runtime.publish('scan.completed', {})
    const state = await context.waitForRun(context.taskKeys[0])
    assert.equal(state.status, 'timeout')
    const methods = context
      .trace()
      .filter((entry) => entry.dir === 'in')
      .map((entry) => entry.message.method)
    assert.ok(methods.includes('session/cancel'))
    assert.match(state.result.outcome.error, /运行超时/)
  } finally {
    await context.cleanup()
  }
})

test('agent 提前退出时运行标记 failed', async () => {
  const context = await setup({ env: { FAKE_ACP_EXIT_ON_PROMPT: '1' } })
  try {
    context.harness.runtime.publish('scan.completed', {})
    const state = await context.waitForRun(context.taskKeys[0])
    assert.equal(state.status, 'failed')
    assert.match(state.result.outcome.error, /已退出/)
  } finally {
    await context.cleanup()
  }
})

test('只派发 meta.agent 匹配且 in_progress 的任务', async () => {
  const context = await setup({
    tasks: [
      { dir: '11-04-a', agent: 'opencode' },
      { dir: '11-04-b', agent: 'claude' },
      { dir: '11-04-c', agent: 'opencode', status: 'planning' },
    ],
  })
  try {
    context.harness.runtime.publish('scan.completed', {})
    const done = await context.waitForRun('repo::11-04-a')
    assert.equal(done.status, 'succeeded')
    assert.deepEqual(context.runs('repo::11-04-b'), [])
    assert.deepEqual(context.runs('repo::11-04-c'), [])
  } finally {
    await context.cleanup()
  }
})

test('POST /dispatch 拒绝非 in_progress 任务', async () => {
  const context = await setup({ tasks: [{ dir: '11-04-plan', status: 'planning' }] })
  try {
    const response = await fetch(`${context.http.baseUrl}/api/plugins/acp-dispatch/dispatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskKey: context.taskKeys[0] }),
    })
    assert.equal(response.status, 409)
  } finally {
    await context.cleanup()
  }
})

test('同一任务不会重复派发', async () => {
  const context = await setup()
  try {
    context.harness.runtime.publish('scan.completed', {})
    await context.waitForRun(context.taskKeys[0])
    context.harness.runtime.publish('scan.completed', {})
    await new Promise((resolve) => setTimeout(resolve, 300))
    const prompts = context.trace().filter((entry) => entry.message?.method === 'session/prompt')
    assert.equal(prompts.length, 1)
  } finally {
    await context.cleanup()
  }
})

test('GET /status 与 GET /executions 可见运行记录', async () => {
  const context = await setup()
  try {
    context.harness.runtime.publish('scan.completed', {})
    await context.waitForRun(context.taskKeys[0])
    const status = await fetch(`${context.http.baseUrl}/api/plugins/acp-dispatch/status`).then(
      (response) => response.json(),
    )
    assert.equal(status.configured, true)
    assert.equal(status.agent, 'opencode')
    const executions = await fetch(
      `${context.http.baseUrl}/api/plugins/acp-dispatch/executions?limit=5`,
    ).then((response) => response.json())
    assert.equal(executions.runs.length, 1)
    assert.equal(executions.runs[0].status, 'succeeded')

    const hostRuns = await fetch(
      `${context.http.baseUrl}/api/plugins/acp-dispatch/runs?limit=5`,
    ).then((response) => response.json())
    assert.equal(hostRuns.runs.length, 1)
    assert.equal(hostRuns.runs[0].runId, `acp-dispatch:${context.taskKeys[0]}:1`)
    assert.equal(hostRuns.runs[0].status, 'succeeded')
    assert.equal(hostRuns.runs[0].pluginVersion, '1.1.0')
  } finally {
    await context.cleanup()
  }
})

test('同一任务复用常驻 ACP 会话，不再重复 session/new', async () => {
  const context = await setup({
    env: { FAKE_ACP_LOAD_SESSION: '1' },
    config: { rerunSucceeded: true },
  })
  try {
    context.harness.runtime.publish('scan.completed', {})
    const first = await context.waitForRun(context.taskKeys[0])
    assert.equal(first.status, 'succeeded')
    assert.equal(first.runId, `acp-dispatch:${context.taskKeys[0]}:1`)

    context.harness.runtime.publish('scan.completed', {})
    const deadline = Date.now() + 5000
    let second = null
    while (Date.now() < deadline) {
      const runs = context.runs(context.taskKeys[0])
      second = runs.find((run) => run.runId.endsWith(':2'))
      if (second && !['queued', 'starting', 'running'].includes(second.status)) break
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    assert.ok(second, '应产生第二次 run')
    assert.equal(second.status, 'succeeded')
    assert.equal(second.result.session.id, first.result.session.id)
    assert.equal(second.result.session.resumed, true)

    const methods = context
      .trace()
      .filter((entry) => entry.dir === 'in')
      .map((entry) => entry.message.method)
    assert.equal(methods.filter((method) => method === 'session/new').length, 1)
    assert.equal(methods.filter((method) => method === 'session/prompt').length, 2)
  } finally {
    await context.cleanup()
  }
})

test('idle 超时先 session/cancel，run 标记 timeout', async () => {
  const context = await setup({
    env: { FAKE_ACP_SILENT: '1' },
    config: { idleTimeoutMs: 300, runTimeoutMs: 10_000 },
  })
  try {
    context.harness.runtime.publish('scan.completed', {})
    const state = await context.waitForRun(context.taskKeys[0])
    assert.equal(state.status, 'timeout')
    assert.match(String(state.result.outcome.error), /idle 超时/)
    const methods = context
      .trace()
      .filter((entry) => entry.dir === 'in')
      .map((entry) => entry.message.method)
    assert.ok(methods.includes('session/cancel'))
  } finally {
    await context.cleanup()
  }
})

test('POST /api/plugins/acp-dispatch/runs 手动触发一次派发', async () => {
  const context = await setup()
  try {
    const response = await fetch(`${context.http.baseUrl}/api/plugins/acp-dispatch/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskKey: context.taskKeys[0] }),
    })
    assert.equal(response.status, 202)
    const body = await response.json()
    assert.equal(body.queued, true)
    const state = await context.waitForRun(context.taskKeys[0])
    assert.equal(state.status, 'succeeded')
  } finally {
    await context.cleanup()
  }
})

test('agent 写入 check-report 后 watcher 把 derivedStage 从 implement 推进到 spec', async () => {
  const context = await setup({ writeCheckReport: true })
  try {
    const taskDir = path.join(context.repo.repositoryPath, '.trellis', 'tasks', '11-04-run1')
    fs.writeFileSync(
      path.join(taskDir, 'prd.md'),
      '# 示例\n\n## Requirements\n\n实现功能。\n\n## Acceptance Criteria\n\n- [ ] 测试通过\n',
    )
    fs.mkdirSync(path.join(taskDir, 'research'), { recursive: true })
    fs.writeFileSync(path.join(taskDir, 'research', 'note.md'), '# 调研\n')
    fs.writeFileSync(path.join(taskDir, 'design.md'), '# 设计\n')
    fs.writeFileSync(path.join(taskDir, 'implement.md'), '# 实施\n')
    fs.writeFileSync(path.join(taskDir, 'implement.jsonl'), '{"file":"a.js"}\n')
    fs.writeFileSync(path.join(taskDir, 'check.jsonl'), '{"file":"a.js"}\n')

    clearScanCaches()
    const project = context.repo.repositories[0]
    const before = scanRepository(project).tasks.find(
      (task) => task.executionTaskKey === context.taskKeys[0],
    )
    assert.equal(before.derivedStage, 'implement', JSON.stringify(before.stages))

    let watchedStage = null
    const watcher = createWatchRuntime({
      repositories: context.repo.repositories,
      onChange: () => {
        clearScanCaches()
        const task = scanRepository(project).tasks.find(
          (item) => item.executionTaskKey === context.taskKeys[0],
        )
        watchedStage = task?.derivedStage || watchedStage
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 100))

    context.harness.runtime.publish('scan.completed', {})
    const run = await context.waitForRun(context.taskKeys[0])
    assert.equal(run.status, 'succeeded')
    assert.ok(
      await waitFor(() => watchedStage === 'spec', { timeoutMs: 5000 }),
      `watchedStage=${watchedStage}`,
    )
    watcher.close()
  } finally {
    await context.cleanup()
  }
})

test('没有 meta.agent 绑定的 in_progress 任务默认也参与派发', async () => {
  const context = await setup({ tasks: [{ dir: '11-04-unbound', agent: null }] })
  try {
    context.harness.runtime.publish('scan.completed', {})
    const run = await context.waitForRun('repo::11-04-unbound')
    assert.equal(run.status, 'succeeded')
    const status = await fetch(`${context.http.baseUrl}/api/plugins/acp-dispatch/status`).then(
      (response) => response.json(),
    )
    assert.equal(status.dispatchUnbound, true)
    assert.equal(status.lastDiscovery.dispatched, 1)
    assert.equal(status.lastDiscovery.skippedUnbound, 0)
  } finally {
    await context.cleanup()
  }
})

test('dispatchUnbound=false 时跳过未绑定任务并在 /status 计数', async () => {
  const context = await setup({
    tasks: [{ dir: '11-04-unbound-off', agent: null }],
    config: { dispatchUnbound: false },
  })
  try {
    context.harness.runtime.publish('scan.completed', {})
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.deepEqual(context.runs('repo::11-04-unbound-off'), [])
    const status = await fetch(`${context.http.baseUrl}/api/plugins/acp-dispatch/status`).then(
      (response) => response.json(),
    )
    assert.equal(status.dispatchUnbound, false)
    assert.equal(status.lastDiscovery.skippedUnbound, 1)
  } finally {
    await context.cleanup()
  }
})

test('手动派发接受看板风格的 taskKey（含 .trellis/tasks 前缀）', async () => {
  const context = await setup()
  try {
    const boardStyleKey = context.taskKeys[0].replace('::', '::.trellis/tasks/')
    const response = await fetch(`${context.http.baseUrl}/api/plugins/acp-dispatch/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskKey: boardStyleKey }),
    })
    assert.equal(response.status, 202)
    const state = await context.waitForRun(context.taskKeys[0])
    assert.equal(state.status, 'succeeded')
  } finally {
    await context.cleanup()
  }
})

test('流式 chunk 不写 session/update 日志', async () => {
  const context = await setup()
  try {
    context.harness.runtime.publish('scan.completed', {})
    await context.waitForRun(context.taskKeys[0])
    const logs = context.harness.supervisor.getLogs('acp-dispatch', 500).entries
    const chunkLogs = logs.filter(
      (entry) =>
        entry.message === 'session/update' &&
        String(entry.fields?.sessionUpdate || '').endsWith('_chunk'),
    )
    assert.deepEqual(chunkLogs, [])
  } finally {
    await context.cleanup()
  }
})

test('tool call 执行中不按 idle 超时误杀长命令', async () => {
  const context = await setup({
    env: { FAKE_ACP_HANG: '1', FAKE_ACP_TOOL_STATUS: 'in_progress' },
    config: { idleTimeoutMs: 400, runTimeoutMs: 10_000 },
  })
  try {
    context.harness.runtime.publish('scan.completed', {})
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const [before] = context.runs(context.taskKeys[0])
    assert.equal(before.status, 'running')
    const cancelled = await fetch(`${context.http.baseUrl}/api/plugins/acp-dispatch/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskKey: context.taskKeys[0] }),
    })
    assert.equal(cancelled.status, 200)
    const done = await context.waitForRun(context.taskKeys[0])
    assert.equal(done.status, 'cancelled')
  } finally {
    await context.cleanup()
  }
})

test('面板路由提供资源、会话与运行结果', async () => {
  const context = await setup()
  try {
    context.harness.runtime.publish('scan.completed', {})
    const run = await context.waitForRun(context.taskKeys[0])
    assert.equal(run.status, 'succeeded')

    const html = await fetch(`${context.http.baseUrl}/api/plugins/acp-dispatch/panel`).then(
      (response) => response.text(),
    )
    assert.match(html, /Agent 派发/)
    const css = await fetch(`${context.http.baseUrl}/api/plugins/acp-dispatch/panel/app.css`).then(
      (response) => response.text(),
    )
    assert.match(css, /--accent/)
    const script = await fetch(
      `${context.http.baseUrl}/api/plugins/acp-dispatch/panel/app.js`,
    ).then((response) => response.text())
    assert.match(script, /trellis:ready/)

    const data = await fetch(`${context.http.baseUrl}/api/plugins/acp-dispatch/panel/data`).then(
      (response) => response.json(),
    )
    assert.equal(data.configured, true)
    assert.equal(data.runs.length, 1)
    assert.equal(data.runs[0].result.outcome.status, 'succeeded')
    assert.equal(data.runs[0].result.session.id, 'sess-1')
    assert.equal(data.sessions.length, 1)
    assert.equal(data.sessions[0].sessionId, 'sess-1')
    assert.equal(data.active.length, 0)
  } finally {
    await context.cleanup()
  }
})

test('面板下发命令复用会话并回写结果', async () => {
  const context = await setup()
  try {
    context.harness.runtime.publish('scan.completed', {})
    const first = await context.waitForRun(context.taskKeys[0])
    assert.equal(first.status, 'succeeded')

    const response = await fetch(`${context.http.baseUrl}/api/plugins/acp-dispatch/panel/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskKey: context.taskKeys[0], text: '继续修复剩余测试' }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.result.outcome.status, 'succeeded')
    assert.equal(body.result.session.id, first.result.session.id)
    assert.match(body.result.summary.text, /完成/)

    const prompts = context.trace().filter((entry) => entry.message?.method === 'session/prompt')
    assert.equal(prompts.length, 2)
    assert.equal(prompts[1].message.params.prompt[0].text, '继续修复剩余测试')
    assert.equal(context.runs(context.taskKeys[0]).length, 2)
  } finally {
    await context.cleanup()
  }
})

test('运行事件以公开事件发布', async () => {
  const context = await setup()
  try {
    context.harness.runtime.publish('scan.completed', {})
    await context.waitForRun(context.taskKeys[0])
    const events = context.harness.supervisor.eventRing
    const started = events.find((event) => event.name === 'acp-dispatch/session.started')
    const finished = events.find((event) => event.name === 'acp-dispatch/session.finished')
    assert.ok(started)
    assert.ok(finished)
    assert.equal(finished.public, true)
    assert.equal(finished.source, 'acp-dispatch')
    assert.equal(finished.payload.outcome.status, 'succeeded')
  } finally {
    await context.cleanup()
  }
})
