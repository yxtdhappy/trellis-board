import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createHarness,
  fixtureModule,
  startHttpServer,
} from '@trellis-board/test-support/plugin-runtime.js'
import { createTaskRepository } from '@trellis-board/test-support/task-repository.js'

const PLUGIN_MODULE = fileURLToPath(new URL('../index.js', import.meta.url))

async function setup(config = {}, extraPlugins = []) {
  const repo = createTaskRepository()
  const harness = await createHarness({
    plugins: [
      {
        id: 'a2a-intake',
        module: PLUGIN_MODULE,
        enabled: true,
        config: {
          token: 'a2a-token',
          repositoryId: 'repo',
          defaultAssignee: 'bob',
          defaultPriority: 'P2',
          publicBaseUrl: 'https://board.example',
          ...config,
        },
      },
      ...extraPlugins,
    ],
    repositories: repo.repositories,
    hostVersion: '0.2.0',
  })
  const http = await startHttpServer(harness.runtime)
  return {
    repo,
    harness,
    http,
    async rpc(method, params, { token = 'a2a-token', path: rpcPath = '/a2a' } = {}) {
      const response = await fetch(`${http.baseUrl}${rpcPath}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      const text = await response.text()
      return { status: response.status, json: text ? JSON.parse(text) : null }
    },
    taskDirs() {
      return fs
        .readdirSync(path.join(repo.repositoryPath, '.trellis', 'tasks'))
        .filter((name) => name !== 'archive')
    },
    async cleanup() {
      await http.close()
      await harness.cleanup()
      fs.rmSync(repo.root, { recursive: true, force: true })
    },
  }
}

function sendParams(messageId, payload) {
  return {
    message: {
      role: 'user',
      messageId,
      parts: [
        { kind: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) },
      ],
    },
  }
}

test('Agent Card 公开可读', async () => {
  const context = await setup()
  try {
    const response = await fetch(`${context.http.baseUrl}/.well-known/agent-card.json`)
    assert.equal(response.status, 200)
    const card = await response.json()
    assert.equal(card.protocolVersion, '0.3.0')
    assert.equal(card.url, 'https://board.example/a2a')
    assert.deepEqual(
      card.skills.map((skill) => skill.id),
      ['create-task', 'manage-repositories', 'query-tasks', 'invoke-capability'],
    )
    assert.equal(
      card.skills.some((skill) => skill.id === 'board-control'),
      false,
    )
  } finally {
    await context.cleanup()
  }
})

test('旧客户端探测别名 /.well-known/agent.json 可用', async () => {
  const context = await setup()
  try {
    const response = await fetch(`${context.http.baseUrl}/.well-known/agent.json`)
    assert.equal(response.status, 200)
    const card = await response.json()
    assert.equal(card.name, 'a2a-intake')
    assert.equal(card.skills[0].id, 'create-task')
  } finally {
    await context.cleanup()
  }
})

test('无 token 返回 401，错误 token 返回 403', async () => {
  const context = await setup()
  try {
    const missing = await context.rpc('message/send', sendParams('m0', { title: 'x' }), {
      token: '',
    })
    assert.equal(missing.status, 401)
    const wrong = await context.rpc('message/send', sendParams('m0', { title: 'x' }), {
      token: 'nope',
    })
    assert.equal(wrong.status, 403)
  } finally {
    await context.cleanup()
  }
})

test('message/send 创建 planning 任务并写入 meta.agent', async () => {
  const context = await setup()
  try {
    const response = await context.rpc(
      'message/send',
      sendParams('msg-1', {
        title: '来自 A2A',
        description: '正文',
        priority: 'P1',
        agent: 'claude',
      }),
    )
    assert.equal(response.status, 200)
    const task = response.json.result
    assert.equal(task.kind, 'task')
    // 规划阶段且 DoR 未齐备时，对端需要补充信息，因此映射为 input-required。
    assert.equal(task.status.state, 'input-required')
    assert.match(task.metadata.trellisTaskKey, /^repo::\d{2}-\d{2}-a2a-/)
    const artifact = JSON.parse(task.artifacts[0].parts[0].text)
    assert.equal(artifact.title, '来自 A2A')
    assert.equal(context.taskDirs().length, 1)
    const taskJson = JSON.parse(
      fs.readFileSync(
        path.join(
          context.repo.repositoryPath,
          '.trellis',
          'tasks',
          context.taskDirs()[0],
          'task.json',
        ),
        'utf8',
      ),
    )
    assert.equal(taskJson.meta.agent, 'claude')
    assert.equal(taskJson.status, 'planning')
  } finally {
    await context.cleanup()
  }
})

test('tasks/get 跟随看板状态：in_progress→working、completed→completed', async () => {
  const context = await setup()
  try {
    const sent = await context.rpc('message/send', sendParams('msg-live', { title: '状态推进' }))
    const taskId = sent.json.result.id
    assert.equal(sent.json.result.status.state, 'input-required')
    const taskJsonPath = path.join(
      context.repo.repositoryPath,
      '.trellis',
      'tasks',
      context.taskDirs()[0],
      'task.json',
    )

    const taskJson = JSON.parse(fs.readFileSync(taskJsonPath, 'utf8'))
    taskJson.status = 'in_progress'
    fs.writeFileSync(taskJsonPath, JSON.stringify(taskJson, null, 2))
    const working = await context.rpc('GetTask', { taskId })
    assert.equal(working.json.result.status.state, 'working')

    taskJson.status = 'completed'
    fs.writeFileSync(taskJsonPath, JSON.stringify(taskJson, null, 2))
    const completed = await context.rpc('tasks/get', { id: taskId })
    assert.equal(completed.json.result.status.state, 'completed')
  } finally {
    await context.cleanup()
  }
})

test('blocked 状态映射为 input-required，archived 映射为 canceled', async () => {
  const context = await setup()
  try {
    const sent = await context.rpc('message/send', sendParams('msg-state', { title: '状态映射' }))
    const taskId = sent.json.result.id
    const taskJsonPath = path.join(
      context.repo.repositoryPath,
      '.trellis',
      'tasks',
      context.taskDirs()[0],
      'task.json',
    )
    const taskJson = JSON.parse(fs.readFileSync(taskJsonPath, 'utf8'))

    taskJson.status = 'blocked'
    fs.writeFileSync(taskJsonPath, JSON.stringify(taskJson, null, 2))
    const blocked = await context.rpc('tasks/get', { id: taskId })
    assert.equal(blocked.json.result.status.state, 'input-required')

    taskJson.status = 'planning'
    taskJson.archived = true
    fs.writeFileSync(taskJsonPath, JSON.stringify(taskJson, null, 2))
    const archived = await context.rpc('tasks/get', { id: taskId })
    assert.equal(archived.json.result.status.state, 'canceled')
  } finally {
    await context.cleanup()
  }
})

test('相同 messageId 重复投递返回同一任务', async () => {
  const context = await setup()
  try {
    const first = await context.rpc('message/send', sendParams('msg-dup', { title: '幂等任务' }))
    const second = await context.rpc('message/send', sendParams('msg-dup', { title: '幂等任务' }))
    assert.equal(second.json.result.id, first.json.result.id)
    assert.equal(context.taskDirs().length, 1)
  } finally {
    await context.cleanup()
  }
})

test('v1.0 方法名 SendMessage/GetTask/CancelTask 可用', async () => {
  const context = await setup()
  try {
    const sent = await context.rpc('SendMessage', {
      message: {
        messageId: 'v1-1',
        parts: [{ type: 'text', text: '{"title":"v1 任务"}' }],
      },
    })
    assert.equal(sent.json.result.status.state, 'input-required')
    const taskId = sent.json.result.id

    const got = await context.rpc('GetTask', { taskId })
    assert.equal(got.json.result.id, taskId)

    const canceled = await context.rpc('CancelTask', { taskId })
    assert.equal(canceled.json.result.status.state, 'canceled')

    const legacyGet = await context.rpc('tasks/get', { id: taskId })
    assert.equal(legacyGet.json.result.status.state, 'canceled')
  } finally {
    await context.cleanup()
  }
})

test('查询不存在的任务返回 -32001', async () => {
  const context = await setup()
  try {
    const response = await context.rpc('tasks/get', { id: 'missing' })
    assert.equal(response.json.error.code, -32001)
  } finally {
    await context.cleanup()
  }
})

test('缺少文本或未知方法返回 JSON-RPC 错误', async () => {
  const context = await setup()
  try {
    const noText = await context.rpc('message/send', {
      message: { messageId: 'm-x', parts: [{ kind: 'data', data: {} }] },
    })
    assert.equal(noText.json.error.code, -32602)

    const unknown = await context.rpc('tasks/list', {})
    assert.equal(unknown.json.error.code, -32601)
    assert.ok(unknown.json.error.data.supported.includes('SendMessage'))
  } finally {
    await context.cleanup()
  }
})

test('纯文本消息使用首行作为标题', async () => {
  const context = await setup()
  try {
    const response = await context.rpc(
      'message/send',
      sendParams('txt-1', '第一行标题\n第二行正文'),
    )
    const artifact = JSON.parse(response.json.result.artifacts[0].parts[0].text)
    assert.equal(artifact.title, '第一行标题')
  } finally {
    await context.cleanup()
  }
})

test('缺少 assignee 时返回 -32602 且不建任务', async () => {
  const context = await setup({ defaultAssignee: '' })
  try {
    const response = await context.rpc(
      'message/send',
      sendParams('no-owner', { title: '无负责人' }),
    )
    assert.equal(response.json.error.code, -32602)
    assert.equal(context.taskDirs().length, 0)
  } finally {
    await context.cleanup()
  }
})

test('board/action 通过通用 capability 桥调用其他插件', async () => {
  const context = await setup({}, [
    { id: 'cap-provider', module: fixtureModule('cap-provider'), enabled: true },
  ])
  try {
    const listed = await context.rpc('board/action', {
      action: 'capabilities.list',
      input: {},
    })
    assert.equal(listed.status, 200, JSON.stringify(listed.json))
    const demo = listed.json.result.capabilities.find((item) => item.name === 'demo.echo')
    assert.ok(demo, '能力目录缺少 demo.echo')
    assert.equal(demo.provider, 'cap-provider')

    const called = await context.rpc('board/action', {
      action: 'capabilities.call',
      input: { name: 'demo.echo', method: 'echo', params: { text: 'hello' } },
    })
    assert.equal(called.status, 200, JSON.stringify(called.json))
    assert.deepEqual(called.json.result, { text: 'hello', caller: 'a2a-intake' })
  } finally {
    await context.cleanup()
  }
})
