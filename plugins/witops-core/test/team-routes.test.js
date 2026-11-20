/**
 * team 面板路由的端到端测试。
 *
 * 宿主的插件 harness 只有 standalone 模式，team 路由永远跑不到；
 * 这里用一个最小的 team ctx 直接驱动 onStart 注册出来的处理器，
 * 覆盖"项目多选 + 筛选参数 + 需求分组 + 偏好存储"这条面板主链路。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import plugin from '../index.js'
import { createWitopsFixture, pluginConfig } from './fixtures/witops-fixture.js'

async function createTeamContext(fixture, { credential = { token: 'fixture-token' } } = {}) {
  const routes = new Map()
  const store = new Map()
  const ctx = {
    mode: 'team',
    config: pluginConfig({ baseUrl: fixture.baseUrl }),
    currentCredential: () => credential,
    log: { info() {}, warn() {}, error() {} },
    error: (code, message, detail) => Object.assign(new Error(message), { code, detail }),
    events: { on() {} },
    capabilities: {
      register() {},
      call: async () => {
        throw new Error('capability 不可用')
      },
      client: () => ({
        call: async () => {
          throw new Error('capability 不可用')
        },
      }),
    },
    runs: {
      start: async () => ({}),
      progress: async () => ({}),
      finish: async () => ({}),
      list: async () => [],
    },
    effect() {},
    schedule: { every: () => 'timer-1', cancel() {} },
    store: {
      get: async (key) => store.get(key) ?? null,
      set: async (key, value) => {
        store.set(key, value)
        return value
      },
      delete: async (key) => store.delete(key),
      list: async () => [],
    },
    http: {
      route(method, routePath, handler) {
        routes.set(`${method.toUpperCase()} ${routePath}`, handler)
      },
    },
  }
  await plugin.onStart(ctx)

  async function call(method, target, { body } = {}) {
    const [pathname, search = ''] = target.split('?')
    const handler = routes.get(`${method} ${pathname}`)
    assert.ok(handler, `插件没有注册路由 ${method} ${pathname}`)
    const request = {
      method,
      path: pathname,
      query: Object.fromEntries(new URLSearchParams(search)),
      headers: {},
      body: body === undefined ? '' : JSON.stringify(body),
      json: () => JSON.parse(body === undefined ? '{}' : JSON.stringify(body)),
    }
    return handler(request)
  }

  return { call, routes, store }
}

async function withFixture(options, run) {
  const fixture = await createWitopsFixture(options)
  try {
    const context = await createTeamContext(fixture)
    await run({ fixture, ...context })
  } finally {
    await fixture.close()
  }
}

test('GET /project-tasks 支持多项目并返回按需求分组的 groups', async () => {
  await withFixture({}, async ({ call }) => {
    const result = await call('GET', '/project-tasks?projectIds=p1,p2&size=50')
    assert.equal(result.status, 200)
    assert.equal(result.body.total, 4)
    assert.equal(result.body.items.length, 4)

    const [group] = result.body.groups
    assert.equal(group.key, 'req:3001')
    assert.equal(group.requirement.code, 'R3001')
    assert.deepEqual(
      group.children.map((item) => item.code),
      ['T10001', 'B40001'],
    )
    // 子行要带跳转链接，面板点标题能直接开详情
    assert.match(group.children[0].url, /commonDetail\/nodeTaskDetail\/4\/10001$/)
    // p2 的任务没有需求归属，落到「未关联需求」
    assert.equal(result.body.groups.at(-1).key, 'orphans')
  })
})

test('GET /project-tasks 把面板筛选翻译成平台参数', async () => {
  await withFixture({}, async ({ call, fixture }) => {
    const result = await call(
      'GET',
      '/project-tasks?projectIds=p1&status=1&priority=1&assignee=901&iteration=45&code=B4',
    )
    assert.equal(result.status, 200)
    assert.deepEqual(
      result.body.items.map((item) => item.code),
      ['B40001'],
    )
    // 需求表头的补全请求（/story/page）不带筛选，只看任务列表那一条
    const sent = fixture.state.requests
      .filter((request) => request.url.endsWith('/task/task/page'))
      .at(-1).body
    assert.equal(sent.sourceStatus, '1')
    assert.equal(sent.priorityDicConfigCodes, '1')
    assert.equal(sent.assignedToUserIds, '901')
    assert.equal(sent.iterationId, 45)
    // 只选一个项目时仍走 projectId，多项目才升级成 projectIds
    assert.equal(sent.projectId, 'p1')
  })
})

test('GET /project-tasks 用 /story/page 给需求表头补优先级/状态/负责人/截止', async () => {
  await withFixture({}, async ({ call, fixture }) => {
    const result = await call('GET', '/project-tasks?projectIds=p1&size=50')
    assert.equal(result.status, 200)
    const group = result.body.groups.find((entry) => entry.key === 'req:3001')
    assert.ok(group, '应该有一个挂在需求 3001 下的分组')
    assert.equal(group.requirement.priority, 'P1')
    assert.equal(group.requirement.status, '进行中')
    assert.equal(group.requirement.assignee, 'bob')
    assert.equal(group.requirement.dueDate, '2026-11-30')

    const storyCall = fixture.state.requests.find((request) => request.url.endsWith('/story/page'))
    assert.ok(storyCall, '应该查过一次需求列表')
    assert.equal(storyCall.body.projectId, 'p1')
    assert.equal(storyCall.body.types, undefined)
  })
})

test('GET /project-tasks 缺少项目参数时返回 400', async () => {
  await withFixture({}, async ({ call }) => {
    const result = await call('GET', '/project-tasks?types=3,4')
    assert.equal(result.status, 400)
    assert.match(result.body.error, /projectId/)
  })
})

test('GET /project-tasks 按空间类型拆成 productId / projectIds 两路查询', async () => {
  await withFixture({}, async ({ call, fixture }) => {
    const result = await call('GET', '/project-tasks?projectIds=p1,p3&size=50')
    assert.equal(result.status, 200)
    // p1（项目空间）3 条 + p3（产品空间）1 条
    assert.equal(result.body.total, 4)
    assert.deepEqual(result.body.items.map((item) => item.code).sort(), [
      'B40001',
      'R3001',
      'T10001',
      'T10003',
    ])

    const pageRequests = fixture.state.requests
      .filter((request) => request.url.endsWith('/task/task/page'))
      .map((request) => request.body)
    assert.equal(pageRequests.length, 2)
    assert.equal(pageRequests.find((body) => body.productId)?.productId, 'p3')
    assert.equal(pageRequests.find((body) => body.projectId)?.projectId, 'p1')
    // types 在 PageTaskReq 里是业务类型，传 3/4/2 只会把结果筛成 0
    assert.ok(pageRequests.every((body) => body.types === undefined))
  })
})

test('GET /project-tasks 拿不到空间清单时两个键都试一遍', async () => {
  await withFixture({ projectListFails: true }, async ({ call, fixture }) => {
    const result = await call('GET', '/project-tasks?projectIds=p1,p3&size=50')
    assert.equal(result.status, 200)
    assert.equal(result.body.total, 4)
    assert.deepEqual(result.body.items.map((item) => item.code).sort(), [
      'B40001',
      'R3001',
      'T10001',
      'T10003',
    ])
    // 探测请求也是 /task/task/page（size=1），只看真正的分页请求
    const pageRequests = fixture.state.requests
      .filter((request) => request.url.endsWith('/task/task/page'))
      .map((request) => request.body)
      .filter((body) => body.size !== 1)
    assert.equal(pageRequests.length, 2)
    assert.equal(pageRequests.find((body) => body.productId)?.productId, 'p3')
    assert.equal(pageRequests.find((body) => body.projectId)?.projectId, 'p1')
    // 分类失败时不该把 types 或 priority 之类不存在的字段带下去
    assert.ok(pageRequests.every((body) => body.types === undefined))
  })
})

test('GET /children 返回拍平的子项（带 level）', async () => {
  await withFixture({}, async ({ call }) => {
    const result = await call('GET', '/children?id=3001&type=3')
    assert.equal(result.status, 200)
    assert.deepEqual(
      result.body.items.map((item) => item.code),
      ['T10001', 'T10004'],
    )
    assert.equal(result.body.items[0].level, 0)
    assert.match(result.body.items[0].url, /nodeTaskDetail\/4\/10001$/)
  })
})

test('GET /prefs 首次为空，PUT 后按白名单落库并能读回', async () => {
  await withFixture({}, async ({ call, store }) => {
    const empty = await call('GET', '/prefs')
    assert.deepEqual(empty.body.prefs, {})

    const saved = await call('PUT', '/prefs', {
      body: {
        projectIds: ['p1', 'p2'],
        filters: { status: ['1', '3'], priority: ['2'], code: 'T1', bogus: 'x' },
        pageSize: 100,
        expanded: ['req:1'],
      },
    })
    assert.equal(saved.status, 200)
    assert.deepEqual(saved.body.prefs.projectIds, ['p1', 'p2'])
    assert.deepEqual(saved.body.prefs.filters, { status: ['1', '3'], priority: ['2'], code: 'T1' })
    assert.equal(saved.body.prefs.pageSize, 100)
    assert.equal('expanded' in saved.body.prefs, false)
    assert.ok(store.has('panel:preferences'))

    // 再存一次是合并而不是覆盖：只传 projectIds 不会把 filters 清掉
    const merged = await call('PUT', '/prefs', { body: { projectIds: ['p2'] } })
    assert.deepEqual(merged.body.prefs.projectIds, ['p2'])
    assert.deepEqual(merged.body.prefs.filters, {
      status: ['1', '3'],
      priority: ['2'],
      code: 'T1',
    })
  })
})

test('GET /users 与 GET /iterations 返回下拉选项', async () => {
  await withFixture({}, async ({ call }) => {
    const users = await call('GET', '/users')
    assert.deepEqual(users.body.items, [
      { id: '900', name: 'alice' },
      { id: '901', name: 'bob' },
    ])
    const iterations = await call('GET', '/iterations?projectId=p1')
    assert.deepEqual(iterations.body.items, [{ id: '45', name: '迭代 45' }])
  })
})

test('没有 WitOps 凭据时面板路由返回 401 而不是 500', async () => {
  const fixture = await createWitopsFixture()
  try {
    const { call } = await createTeamContext(fixture, { credential: null })
    const result = await call('GET', '/project-tasks?projectIds=p1')
    assert.equal(result.status, 401)
    assert.match(result.body.error, /先登录/)
    const prefs = await call('GET', '/prefs')
    assert.equal(prefs.status, 200)
  } finally {
    await fixture.close()
  }
})
