import http from 'node:http'

export { createTaskRepository } from '@trellis-board/test-support/task-repository.js'

function json(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

export const FIXTURE_PREFIXES = {
  gateway: '/gateway',
  taskService: '/task-service',
  adminService: '/admin-service',
}

export const SAMPLE_DETAIL = {
  businessId: '10001',
  code: 'T10001',
  name: '列表页重构',
  type: 4,
  status: 3,
  priority: 2,
  categoryDicConfigCode: 2,
  categoryDicConfigName: '前端开发',
  developerName: 'bob',
  assignedToUserId: 900,
  storyId: 3001,
  parentType: 'STORY',
  parentId: 3001,
  parentCode: 'R3001',
  parentName: '需求 A',
  parentTypeName: '需求',
  mentionTime: '2026-11-01 08:00:00',
  productAbbreviation: '示例产品',
  projectModuleName: '看板',
  iterationName: '迭代 7',
  storyName: '需求 A',
  expectHour: 12,
  expectCompleteTime: '2026-11-20 18:00:00',
  createTime: '2026-11-01 09:30:00',
  description: [
    '<h2>背景</h2>',
    '<p>需要<strong>重构</strong>列表页，参考<a href="https://example.test/doc" target="_blank">文档</a>。</p>',
    '<ul><li>拆分组件</li><li>补测试</li></ul>',
    '<table style="width:100%"><colgroup><col width="10"></colgroup>',
    '<tr><th>字段</th><th>说明</th></tr><tr><td>status</td><td>1,3</td></tr></table>',
    '<pre><code>npm test</code></pre>',
  ].join(''),
}

export const SAMPLE_REQUIREMENT = {
  businessId: '3001',
  code: 'R3001',
  name: '需求 A',
  type: 3,
  status: 3,
  priority: 2,
  categoryDicConfigName: '产品设计',
  assignedToUserId: 900,
  expectCompleteTime: '2026-11-30 18:00:00',
  description: '<p>需求整体目标</p>',
}

export const SAMPLE_BUG = {
  businessId: '40001',
  code: 'B40001',
  name: '登录失败',
  type: 2,
  status: 1,
  priority: 1,
  categoryDicConfigCode: 2,
  categoryDicConfigName: '前端开发',
  assignedToUserId: 900,
  expectCompleteTime: '2026-11-18 18:00:00',
  description: '<p>复现步骤</p>',
}

export const SAMPLE_WORK_ORDER = {
  businessId: '50001',
  code: 'W50001',
  name: '现场工单',
  type: 0,
  status: 1,
  priority: 3,
  assignedToUserId: 900,
  expectCompleteTime: '2026-11-22 18:00:00',
  description: '<p>客户反馈</p>',
}

export const SAMPLE_CHILD = {
  businessId: '10004',
  code: 'T10004',
  name: '需求子任务',
  type: 4,
  status: 1,
  priority: 2,
  assignedToUserId: 900,
  parentType: 'STORY',
  parentId: 3001,
  parentCode: 'R3001',
  parentName: '需求 A',
  description: '<p>子任务内容</p>',
}

export async function createWitopsFixture({
  tasks = [SAMPLE_DETAIL, SAMPLE_REQUIREMENT, SAMPLE_BUG, SAMPLE_WORK_ORDER, SAMPLE_CHILD],
  accounts = [{ account: 'alice', password: 'secret' }],
  token = 'fixture-token',
  failuresRemaining = 0,
} = {}) {
  const state = {
    requests: [],
    issuedTokens: new Set([token]),
    validTokens: new Set([token]),
    failuresRemaining,
    logins: 0,
    detailCalls: 0,
  }
  const byKey = new Map(tasks.map((task) => [`${task.type}:${task.businessId}`, task]))
  let tokenSequence = 0

  const server = http.createServer(async (request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    await new Promise((resolve) => request.on('end', resolve))
    const raw = Buffer.concat(chunks).toString('utf8')
    const body = raw ? JSON.parse(raw) : {}
    const pathname = new URL(request.url, 'http://fixture').pathname
    state.requests.push({
      url: pathname,
      at: Date.now(),
      token: request.headers['weareint-token'] || null,
      body,
    })

    if (state.failuresRemaining > 0) {
      state.failuresRemaining -= 1
      json(response, 500, { message: 'upstream error' })
      return
    }

    const { gateway, taskService, adminService } = FIXTURE_PREFIXES
    const loginPath = `${gateway}${adminService}/api/sysUser/login`
    const findUserPath = `${gateway}${adminService}/api/sysUser/findUser`
    const pagePath = `${gateway}${taskService}/nodeTask/page`
    const detailPath = `${gateway}${taskService}/task/detail`
    const nodeDetailPath = `${gateway}${taskService}/nodeTask/detail`
    const childPath = `${gateway}${taskService}/task/childTask`
    const storyPath = `${gateway}${taskService}/story/detail`
    const storyPagePath = `${gateway}${taskService}/story/page`
    const dictPath = `${gateway}${adminService}/api/sysDicConfig/getListByKey`

    if (pathname === loginPath) {
      state.logins += 1
      const matched = accounts.find(
        (item) => item.account === body.account && item.password === body.password,
      )
      if (!matched) {
        json(response, 200, { code: 20001, message: '账号或密码错误' })
        return
      }
      tokenSequence += 1
      const issued = `token-${tokenSequence}`
      state.validTokens.add(issued)
      state.issuedTokens.add(issued)
      json(response, 200, { code: 20000, data: { token: issued, user: { id: 900 } } })
      return
    }

    const valid = state.validTokens.has(request.headers['weareint-token'])
    if (!valid) {
      json(response, 200, { code: 40300, message: '登录状态已过期' })
      return
    }

    if (pathname === findUserPath) {
      json(response, 200, { code: 20000, data: { id: 900, account: 'alice' } })
      return
    }

    if (pathname === pagePath) {
      if (body.categories) {
        json(response, 500, {
          code: 50000,
          error:
            "### Error querying database.  Cause: java.sql.SQLSyntaxErrorException: Unknown column 'business.category' in 'where clause'",
        })
        return
      }
      const wanted = String(body.status ?? '')
        .split(',')
        .map((part) => Number(part.trim()))
      const records = [...byKey.values()]
        .filter((task) =>
          body.type !== undefined && body.type !== null && body.type !== ''
            ? Number(task.type) === Number(body.type)
            : true,
        )
        .filter((task) =>
          wanted.length && wanted.some((code) => Number.isFinite(code))
            ? wanted.includes(Number(task.status))
            : true,
        )
        .filter((task) => (body.code ? String(task.code ?? '').includes(String(body.code)) : true))
        .filter((task) => (body.name ? String(task.name ?? '').includes(String(body.name)) : true))
        .filter((task) =>
          body.priority ? String(task.priority ?? '') === String(body.priority) : true,
        )
        .map((task) => ({
          businessId: task.businessId,
          code: task.code,
          name: task.name,
          type: task.type,
          status: task.status,
          priority: task.priority,
          developerName: task.developerName,
          expectCompleteTime: task.expectCompleteTime,
          parentType: task.parentType,
          parentId: task.parentId,
          parentCode: task.parentCode,
          parentName: task.parentName,
          categoryDicConfigCode: task.categoryDicConfigCode,
          categoryDicConfigName: task.categoryDicConfigName,
        }))
      const current = Number(body.current ?? 1)
      const size = Number(body.size ?? 20)
      const start = (current - 1) * size
      json(response, 200, {
        code: 20000,
        data: {
          records: records.slice(start, start + size),
          total: records.length,
          pages: Math.max(1, Math.ceil(records.length / size)),
          current,
          size,
        },
      })
      return
    }

    if (pathname === nodeDetailPath) {
      state.detailCalls += 1
      const task = byKey.get(`${body.type}:${body.id}`)
      json(response, 200, { code: 20000, data: task ?? null })
      return
    }

    if (pathname === childPath) {
      const parentId = String(body.id ?? '')
      const children = [...byKey.values()]
        .filter((task) => String(task.parentId ?? task.parentStoryId ?? '') === parentId)
        .filter((task) => [0, 2, 4].includes(Number(task.type)))
        .map((task) => ({
          businessId: task.businessId,
          code: task.code,
          name: task.name,
          type: task.type,
          status: task.status,
          assignedToUserName: task.developerName ?? task.assignedToUserName ?? '',
        }))
      json(response, 200, { code: 20000, data: { children } })
      return
    }

    if (pathname === detailPath) {
      state.detailCalls += 1
      const task = byKey.get(`${body.type}:${body.id}`)
      json(response, 200, { code: 20000, data: task ?? null })
      return
    }

    if (pathname === storyPath) {
      json(response, 200, { code: 20000, data: { description: '<p>需求描述</p>' } })
      return
    }

    if (pathname === storyPagePath) {
      json(response, 200, {
        code: 20000,
        data: {
          records: [{ businessId: '3001', code: 'REQ-3001', name: '需求 A' }],
          total: 1,
          pages: 1,
        },
      })
      return
    }

    if (pathname === dictPath) {
      const dicts = {
        taskStatus: [
          { code: 1, name: '待处理' },
          { code: 2, name: '已完成' },
          { code: 3, name: '进行中' },
        ],
        taskCategory: [
          { code: 2, name: '前端开发' },
          { code: 1, name: '后端开发' },
        ],
        priority: [
          { code: 1, name: 'P0' },
          { code: 2, name: 'P1' },
          { code: 3, name: 'P2' },
          { code: 4, name: 'P3' },
        ],
        systemEnv: [
          { code: 0, name: 'DEV' },
          { code: 1, name: 'FAT' },
          { code: 2, name: 'UAT' },
          { code: 3, name: 'PRO' },
          { code: 4, name: 'SIT' },
        ],
        bugCategory: [
          { code: 1, name: '界面' },
          { code: 2, name: '逻辑' },
        ],
      }
      json(response, 200, { code: 20000, data: dicts[body.type] ?? [] })
      return
    }

    json(response, 404, { code: 40400, message: 'not found' })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    state,
    expireTokens() {
      state.validTokens.clear()
    },
    failNext(count) {
      state.failuresRemaining = count
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

export function pluginConfig({ baseUrl, repositoryId = 'repo', credentials, ...overrides } = {}) {
  return {
    baseUrl,
    gatewayPrefix: FIXTURE_PREFIXES.gateway,
    taskServicePrefix: FIXTURE_PREFIXES.taskService,
    adminServicePrefix: FIXTURE_PREFIXES.adminService,
    webRoot: 'web',
    repositoryId,
    assignedToUserId: 900,
    developerMap: { 900: 'bob' },
    status: '1,3',
    type: 4,
    requestIntervalMs: 5,
    retryBackoffMs: 5,
    credentials: credentials ?? { mode: 'password', account: 'alice', password: 'secret' },
    ...overrides,
  }
}
