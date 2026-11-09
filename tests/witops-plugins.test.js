import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createHarness, startHttpServer } from './helpers/plugin-runtime.js'

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

async function startWitopsMock() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const body = request.method === 'POST' ? await readBody(request) : {}
    const send = (data) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ code: 20000, message: 'ok', data }))
    }
    if (url.pathname === '/prototype/req/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><body><a href="./REQ-0001-demo/">REQ-0001 demo</a></body></html>')
      return
    }
    if (url.pathname.endsWith('/story/page')) {
      return send({
        records: [
          {
            businessId: 'S-1',
            code: 'REQ-0001',
            name: '模型发布',
            sourceStatusName: '处理中',
            priorityDicConfigCode: 'P1',
            assignedToUserName: '张三',
          },
        ],
        total: 1,
        pages: 1,
        current: 1,
        size: 50,
      })
    }
    if (url.pathname.endsWith('/nodeTask/page')) {
      assert.equal(body.assignedToUserId, 7)
      const record =
        body.type === 3
          ? {
              businessId: 'REQ-1',
              type: 3,
              code: 'REQ-1',
              name: '模型发布',
              sourceStatusName: '处理中',
              priorityDicConfigCode: 'P1',
              assignedToUserName: '张三',
            }
          : {
              businessId: 'T-1',
              type: 4,
              code: 'TASK-1',
              name: '前端改造',
              sourceStatusName: '进行中',
              priorityDicConfigCode: 'P2',
              assignedToUserName: '李四',
            }
      return send({
        records: [record],
        total: 1,
        pages: 1,
        current: 1,
        size: 50,
      })
    }
    if (url.pathname.endsWith('/story/detail')) {
      return send({
        businessId: body.id,
        code: body.id,
        name: '模型发布',
        sourceStatusName: '处理中',
        priorityDicConfigCode: 'P1',
        assignedToUserName: '张三',
        description: '需求描述',
      })
    }
    if (url.pathname.endsWith('/task/update')) {
      assert.deepEqual(body, { id: 'T-1', sourceStatus: 'done', status: 'done' })
      return send({ ok: true })
    }
    if (url.pathname.endsWith('/task/removeAllSiblings')) {
      return send({
        businessId: body.id,
        code: body.id,
        name: '模型发布',
        type: 3,
        sourceStatusName: '处理中',
        assignedToUserName: '张三',
        childrenTotalWorkHour: 5,
        children: [
          {
            businessId: 'T-1',
            type: 4,
            code: 'TASK-1',
            name: '前端改造',
            sourceStatusName: '进行中',
            assignedToUserName: '李四',
            inputWorkHour: 2,
            children: [],
          },
          {
            businessId: 'T-2',
            type: 4,
            code: 'TASK-2',
            name: '后端接口',
            sourceStatusName: '待开始',
            assignedToUserName: '王五',
            inputWorkHour: 3,
            children: [],
          },
        ],
      })
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ code: 404, message: `unknown ${url.pathname}` }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { server, baseUrl: `http://127.0.0.1:${port}` }
}

function writeTrellisTask(repositoryPath) {
  const dir = path.join(repositoryPath, '.trellis', 'tasks', '11-01-demo')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'task.json'),
    JSON.stringify(
      {
        id: '11-01-demo',
        title: 'Trellis 关联任务',
        status: 'in_progress',
        assignee: 'alice',
        meta: {
          witops: {
            businessId: 'T-1',
            storyId: 'REQ-1',
            type: 4,
            code: 'TASK-1',
            status: '进行中',
          },
        },
      },
      null,
      2,
    ),
  )
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method ?? 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, json, text }
}

function corePlugin(baseUrl) {
  return {
    id: 'witops-core',
    module: path.resolve('plugins/witops-core/index.js'),
    enabled: true,
    config: {
      baseUrl,
      userId: 7,
      credentials: { mode: 'token', token: 'test-token' },
      requestIntervalMs: 0,
      retries: 0,
      cacheTtlMs: 0,
    },
  }
}

function workbenchPlugin() {
  return {
    id: 'witops-workbench',
    module: path.resolve('plugins/witops-workbench/index.js'),
    enabled: true,
    config: { maxRequirements: 20, prototypeHosts: ['127.0.0.1'] },
  }
}

test('witops-core 拉取当前用户任务并关联 Trellis 任务', async () => {
  const mock = await startWitopsMock()
  const harness = await createHarness({ plugins: [corePlugin(mock.baseUrl)], withRepository: true })
  const http = await startHttpServer(harness.runtime)
  try {
    writeTrellisTask(harness.workspace.repositoryPath)
    const response = await request(http.baseUrl, '/api/plugins/witops-core/mine')
    assert.equal(response.status, 200)
    assert.equal(response.json.userId, 7)
    assert.equal(response.json.items.length, 2)
    const requirement = response.json.items.find((item) => item.id === 'REQ-1')
    assert.equal(requirement.kind, 'requirement')
    assert.equal(requirement.trellisTasks.length, 1)
    assert.match(requirement.trellisTasks[0].taskKey, /11-01-demo$/)
    const task = response.json.items.find((item) => item.id === 'T-1')
    assert.equal(task.kind, 'task')
    assert.equal(task.trellisTasks[0].status, 'in_progress')
  } finally {
    await http.close()
    await harness.cleanup()
    await new Promise((resolve) => mock.server.close(resolve))
  }
})

test('witops-workbench 保存关注列表并汇总拆分、负责人、状态和工时', async () => {
  const mock = await startWitopsMock()
  const harness = await createHarness({ plugins: [corePlugin(mock.baseUrl), workbenchPlugin()] })
  const http = await startHttpServer(harness.runtime)
  try {
    const saved = await request(http.baseUrl, '/api/plugins/witops-workbench/watchlist', {
      method: 'POST',
      body: { text: 'REQ-1, REQ-1' },
    })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.json.ids, ['REQ-1'])

    const response = await request(http.baseUrl, '/api/plugins/witops-workbench/summary')
    assert.equal(response.status, 200)
    assert.equal(response.json.items.length, 1)
    const item = response.json.items[0]
    assert.equal(item.id, 'REQ-1')
    assert.equal(item.split, true)
    assert.equal(item.taskCount, 2)
    assert.deepEqual(item.assignees, ['李四', '王五'])
    assert.equal(item.totalHours, 5)
    assert.deepEqual(
      item.tasks.map((task) => ({ code: task.code, hours: task.hours })),
      [
        { code: 'TASK-1', hours: 2 },
        { code: 'TASK-2', hours: 3 },
      ],
    )
    assert.deepEqual(item.taskStatuses, [
      { status: '进行中', count: 1 },
      { status: '待开始', count: 1 },
    ])
  } finally {
    await http.close()
    await harness.cleanup()
    await new Promise((resolve) => mock.server.close(resolve))
  }
})

test('workbench 从原型链接解析 REQ 编号并查询 需求', async () => {
  const mock = await startWitopsMock()
  const harness = await createHarness({ plugins: [corePlugin(mock.baseUrl), workbenchPlugin()] })
  const http = await startHttpServer(harness.runtime)
  try {
    const response = await request(http.baseUrl, '/api/plugins/witops-workbench/resolve', {
      method: 'POST',
      body: { url: `${mock.baseUrl}/prototype/req/` },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(response.json.refs, [{ code: 'REQ-0001', title: 'demo' }])
    assert.deepEqual(response.json.ids, ['S-1'])
    assert.equal(response.json.items[0].code, 'REQ-0001')

    const summary = await request(http.baseUrl, '/api/plugins/witops-workbench/summary')
    assert.equal(summary.status, 200)
    assert.equal(summary.json.items[0].id, 'S-1')
    assert.equal(summary.json.items[0].taskCount, 2)
  } finally {
    await http.close()
    await harness.cleanup()
    await new Promise((resolve) => mock.server.close(resolve))
  }
})

test('workbench 拒绝非白名单域名的原型链接', async () => {
  const mock = await startWitopsMock()
  const harness = await createHarness({ plugins: [corePlugin(mock.baseUrl), workbenchPlugin()] })
  const http = await startHttpServer(harness.runtime)
  try {
    const response = await request(http.baseUrl, '/api/plugins/witops-workbench/resolve', {
      method: 'POST',
      body: { url: 'http://example.com/REQ-0001-demo/' },
    })
    assert.equal(response.status, 502)
    assert.match(response.json.error, /不允许访问/)
  } finally {
    await http.close()
    await harness.cleanup()
    await new Promise((resolve) => mock.server.close(resolve))
  }
})

test('workbench 只申请读能力，不能调用写能力', async () => {
  const mock = await startWitopsMock()
  const harness = await createHarness({ plugins: [corePlugin(mock.baseUrl), workbenchPlugin()] })
  try {
    const workbench = harness.supervisor.plugins.get('witops-workbench')
    await assert.rejects(
      harness.supervisor.callCapability(workbench, {
        name: 'witops.actions',
        method: 'task.updateStatus',
        params: { id: 'T-1', status: 'done' },
      }),
      /未声明 capability 依赖/,
    )
  } finally {
    await harness.cleanup()
    await new Promise((resolve) => mock.server.close(resolve))
  }
})

test('core 的写能力通过 broker 转发到业务系统', async () => {
  const mock = await startWitopsMock()
  const harness = await createHarness({ plugins: [corePlugin(mock.baseUrl)] })
  try {
    const caller = {
      id: 'write-caller',
      manifest: {
        requires: [{ name: 'witops.actions', version: '^1.0.0', methods: ['task.updateStatus'] }],
      },
    }
    const result = await harness.supervisor.callCapability(caller, {
      name: 'witops.actions',
      method: 'task.updateStatus',
      params: { id: 'T-1', status: 'done' },
    })
    assert.deepEqual(result.value, { id: 'T-1', status: 'done', result: { ok: true } })
  } finally {
    await harness.cleanup()
    await new Promise((resolve) => mock.server.close(resolve))
  }
})

test('core 面板和 workbench 面板资源可加载', async () => {
  const mock = await startWitopsMock()
  const harness = await createHarness({ plugins: [corePlugin(mock.baseUrl), workbenchPlugin()] })
  const http = await startHttpServer(harness.runtime)
  try {
    const panels = await request(http.baseUrl, '/api/panels')
    assert.equal(panels.status, 200)
    assert.deepEqual(
      panels.json.panels.map((panel) => panel.title),
      ['任务', '工作台'],
    )
    for (const plugin of ['witops-core', 'witops-workbench']) {
      const page = await request(http.baseUrl, `/api/plugins/${plugin}/panel`)
      assert.equal(page.status, 200)
      assert.match(page.text, /<title>/)
      const script = await request(http.baseUrl, `/api/plugins/${plugin}/panel/app.js`)
      assert.equal(script.status, 200)
      assert.match(script.text, /trellis:request/)
    }
  } finally {
    await http.close()
    await harness.cleanup()
    await new Promise((resolve) => mock.server.close(resolve))
  }
})
