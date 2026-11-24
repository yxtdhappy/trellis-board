import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHarness, startHttpServer } from '@trellis-board/test-support/plugin-runtime.js'
import { readExecutionMap } from '../../../packages/server/execution-store.js'
import {
  createTaskRepository,
  createWitopsFixture,
  pluginConfig,
  SAMPLE_DETAIL,
} from './fixtures/witops-fixture.js'
import { htmlToMarkdown, safeHtmlToMarkdown, validateMarkdown } from '../html-to-markdown.js'
import { buildTaskDraft, resolveAssignee } from '../mapper.js'
import { createWitopsClient } from '../witops-client.js'

const PLUGIN_ID = 'witops-core'
const PLUGIN_MODULE = fileURLToPath(new URL('../index.js', import.meta.url))

async function setup({
  fixtureOptions,
  config: configOverrides,
  secrets = null,
  userProvider = null,
} = {}) {
  const fixture = await createWitopsFixture(fixtureOptions)
  const repo = createTaskRepository()
  const harness = await createHarness({
    plugins: [
      {
        id: PLUGIN_ID,
        module: PLUGIN_MODULE,
        enabled: true,
        config: pluginConfig({ baseUrl: fixture.baseUrl, ...configOverrides }),
      },
    ],
    repositories: repo.repositories,
    secrets,
    userProvider,
    hostVersion: '0.2.0',
  })
  const http = await startHttpServer(harness.runtime)
  return {
    fixture,
    repo,
    harness,
    http,
    secretsFile: harness.workspace.secretsFile,
    async cleanup() {
      await http.close()
      await harness.cleanup()
      fs.rmSync(repo.root, { recursive: true, force: true })
      await fixture.close()
    },
  }
}

async function call(http, pathname, options = {}) {
  const response = await fetch(`${http.baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers: { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, text, json }
}

function dispatch(context, body) {
  return call(context.http, `/api/plugins/${PLUGIN_ID}/dispatch`, { method: 'POST', body })
}

function findTaskDirectory(repoRoot) {
  const tasksRoot = path.join(repoRoot, '.trellis', 'tasks')
  const names = fs.readdirSync(tasksRoot).filter((name) => /^\d{2}-\d{2}-/.test(name))
  assert.equal(names.length, 1, `应只创建一个任务目录，实际: ${names.join(',')}`)
  return path.join(tasksRoot, names[0])
}

function findTaskDirectories(repoRoot) {
  const tasksRoot = path.join(repoRoot, '.trellis', 'tasks')
  return fs
    .readdirSync(tasksRoot)
    .filter((name) => /^\d{2}-\d{2}-/.test(name))
    .map((name) => path.join(tasksRoot, name))
}

function readTaskJson(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, 'task.json'), 'utf8'))
}

test('HTML 转换：标题、列表、表格表头、围栏与实体', () => {
  const html = [
    '<h2>背景</h2>',
    '<p>需要<strong>重构</strong>，参考<a href="https://example.test/doc" target="_blank">文档</a>。</p>',
    '<ul><li>第一项</li><li>第二项<ul><li>子项</li></ul></li></ul>',
    '<table style="width:100%"><colgroup><col width="10"></colgroup>',
    '<tr><th>字段</th><th>说明</th></tr><tr><td>a</td><td>b|c</td></tr></table>',
    '<pre><code>npm test\nnode index.js</code></pre>',
    '<p>结束&nbsp;行<br>换行</p>',
  ].join('')
  const markdown = htmlToMarkdown(html)
  assert.match(markdown, /^## 背景$/m)
  assert.match(markdown, /\*\*重构\*\*/)
  assert.match(markdown, /\[文档\]\(https:\/\/example\.test\/doc\)/)
  assert.match(markdown, /^- 第一项$/m)
  assert.match(markdown, /^  - 子项$/m)
  assert.match(markdown, /^\| 字段 \| 说明 \|$/m)
  assert.match(markdown, /^\| --- \| --- \|$/m)
  assert.match(markdown, /b\\\|c/)
  assert.match(markdown, /```text\nnpm test\nnode index\.js\n```/)
  assert.doesNotMatch(markdown, /style=|colgroup|\[object Object\]/)
  assert.equal(validateMarkdown(markdown).ok, true)
})

test('HTML 转换：结构校验失败时回退纯文本', () => {
  const broken = '<p>段落</p><pre>```js\nconst a = 1;</pre>'
  const { markdown, validation } = safeHtmlToMarkdown(broken)
  assert.equal(validation.ok, false)
  assert.match(markdown, /段落/)
  assert.match(markdown, /const a = 1/)
  assert.doesNotMatch(markdown, /```text/)
})

test('负责人解析：developerMap[assignedToUserId] 优先，其次默认 assignee', () => {
  assert.equal(resolveAssignee(900, { developerMap: { 900: 'bob' } }), 'bob')
  assert.equal(resolveAssignee('901', {}), '')
  assert.equal(resolveAssignee(900, { assignee: 'bob' }), 'bob')
  assert.equal(resolveAssignee(null, { assignee: 'carol' }), 'carol')
  assert.equal(resolveAssignee(null, {}), '')
})

test('buildTaskDraft 生成标题、PRD、meta 与 HTML 原文', () => {
  const draft = buildTaskDraft({
    detail: {
      businessId: '10001',
      code: 'T10001',
      name: '列表页重构',
      status: 3,
      priority: 2,
      categoryDicConfigCode: 2,
      developerName: 'bob',
      assignedToUserId: 900,
      storyId: 3001,
      parentType: 'STORY',
      parentId: 3001,
      parentCode: 'R3001',
      parentName: '需求 A',
      mentionTime: '2026-11-01 08:00:00',
      expectCompleteTime: '2026-11-20 18:00:00',
      description: '<table><tr><th>字段</th></tr><tr><td>a</td></tr></table>',
    },
    type: 4,
    businessId: '10001',
    config: { assignee: 'bob', keepRaw: true, agentId: 'opencode' },
    baseUrl: 'https://platform.example',
    webRoot: 'web',
  })
  assert.equal(draft.slug, 'T10001')
  assert.match(draft.title, /T10001/)
  assert.match(draft.taskMarkdown, /^\| 字段 \| 值 \|$/m)
  assert.match(draft.prd, /prd\.md 尚未生成/)
  assert.match(draft.prd, /trellis-brainstorm/)
  assert.equal(draft.meta.witops.businessId, '10001')
  assert.equal(draft.meta.agent, 'opencode')
  assert.match(draft.meta.witops.url, /nodeTaskDetail\/4\/10001$/)
  assert.equal(draft.meta.witops.storyId, '3001')
  assert.equal(draft.meta.witops.storyCode, 'R3001')
  assert.equal(draft.meta.witops.storyName, '需求 A')
  assert.match(draft.taskMarkdown, /\| 需求 \| R3001 需求 A \|/)
  assert.match(draft.description, /所属需求 R3001（需求 A），需求 id 3001/)
  assert.match(draft.taskMarkdown, /提出时间/)
  assert.equal(draft.extraFiles['task.md'], draft.taskMarkdown)
  assert.match(draft.extraFiles['prd.witops.html'], /<table>/)
  assert.match(
    draft.description,
    /https:\/\/platform\.example\/#\/web\/commonDetail\/nodeTaskDetail\/4\/10001/,
  )
})

test('平台 code 作为目录标识，缺失时回退通用标识', () => {
  const coded = buildTaskDraft({
    detail: { businessId: '20002', code: 'T20002', name: '测试任务' },
    type: 4,
    businessId: '20002',
    config: { assignee: 'bob' },
  })
  assert.equal(coded.slug, 'T20002')

  const fallback = buildTaskDraft({
    detail: { businessId: '20003', name: '无编号任务' },
    type: 4,
    businessId: '20003',
    config: { assignee: 'bob' },
  })
  assert.equal(fallback.slug, 'witops-4-20003')
})

test('GET /mine 登录后拉取并映射列表', async () => {
  const context = await setup()
  try {
    const response = await call(context.http, `/api/plugins/${PLUGIN_ID}/mine`)
    assert.equal(response.status, 200)
    const byId = new Map(response.json.items.map((item) => [item.id, item]))
    assert.equal(byId.size, 5)
    const item = byId.get('10001')
    assert.equal(item.kind, 'task')
    assert.equal(item.kindLabel, '任务')
    assert.equal(item.code, 'T10001')
    assert.equal(item.status, '进行中')
    assert.equal(item.dueDate, '2026-11-20')
    assert.equal(item.storyId, '3001')
    assert.equal(item.storyCode, 'R3001')
    assert.equal(item.storyName, '需求 A')
    assert.match(item.storyUrl, /nodeTaskDetail\/3\/3001$/)
    assert.deepEqual(item.trellisTasks, [])
    assert.equal(byId.get('3001').kind, 'requirement')
    assert.equal(byId.get('40001').kind, 'bug')
    assert.equal(byId.get('50001').kind, 'workOrder')
    assert.equal(byId.get('10004').kind, 'task')
    assert.equal(context.fixture.state.logins, 1)
  } finally {
    await context.cleanup()
  }
})

test('POST /dispatch 创建任务、写 PRD 与 meta，并保证幂等', async () => {
  const context = await setup()
  try {
    const first = await dispatch(context, { items: [{ businessId: '10001', type: 4 }] })
    assert.equal(first.status, 200)
    assert.equal(first.json.summary.imported, 1)
    const taskKey = first.json.results[0].taskKey
    assert.match(taskKey, /^repo::\d{2}-\d{2}-T10001$/)

    const directory = findTaskDirectory(context.repo.repositoryPath)
    const taskMarkdown = fs.readFileSync(path.join(directory, 'task.md'), 'utf8')
    assert.match(taskMarkdown, /^\| 字段 \| 值 \|$/m)
    assert.match(taskMarkdown, /```text\nnpm test/)
    assert.match(taskMarkdown, /- 拆分组件/)
    assert.match(taskMarkdown, /https:\/\/example\.test\/doc/)
    assert.doesNotMatch(taskMarkdown, /\[object Object\]/)
    assert.equal(validateMarkdown(taskMarkdown).ok, true)

    const prd = fs.readFileSync(path.join(directory, 'prd.md'), 'utf8')
    assert.match(prd, /prd\.md 尚未生成/)
    assert.match(prd, /trellis-brainstorm/)

    const taskJson = JSON.parse(fs.readFileSync(path.join(directory, 'task.json'), 'utf8'))
    assert.equal(taskJson.meta.witops.businessId, '10001')
    assert.equal(taskJson.meta.witops.storyId, '3001')
    assert.equal(taskJson.meta.witops.storyCode, 'R3001')
    assert.equal(taskJson.meta.witops.storyName, '需求 A')
    assert.match(taskMarkdown, /\| 需求链接 \| .*nodeTaskDetail\/3\/3001 \|/)
    assert.equal(taskJson.assignee, 'bob')

    const second = await dispatch(context, { items: [{ businessId: '10001', type: 4 }] })
    assert.equal(second.status, 200)
    assert.equal(second.json.summary.duplicated, 1)
    assert.equal(second.json.results[0].taskKey, taskKey)
    assert.equal(
      fs
        .readdirSync(path.join(context.repo.repositoryPath, '.trellis', 'tasks'))
        .filter((name) => name.includes('T10001')).length,
      1,
    )
  } finally {
    await context.cleanup()
  }
})

test('父节点是任务时不算需求，任务 meta 不带 story', () => {
  const draft = buildTaskDraft({
    detail: {
      businessId: '30003',
      code: 'T30003',
      name: '子任务',
      parentType: 'TASK',
      parentId: 29999,
      parentCode: 'T29999',
      parentName: '父任务',
    },
    type: 4,
    businessId: '30003',
    config: { assignee: 'bob' },
  })
  assert.equal(draft.meta.witops.storyId, null)
  assert.equal(draft.meta.witops.storyCode, null)
  assert.equal(draft.meta.witops.storyName, null)
  assert.doesNotMatch(draft.taskMarkdown, /需求链接/)
  assert.doesNotMatch(draft.description, /所属需求/)
})

test('下发时把 WitOps 截止日期写到任务 meta 与看板计划', async () => {
  const context = await setup()
  try {
    const result = await dispatch(context, { businessId: '10001' })
    assert.equal(result.status, 200)
    assert.equal(result.json.summary.imported, 1)
    assert.equal(result.json.results[0].dueDate, '2026-11-20')

    const directory = findTaskDirectory(context.repo.repositoryPath)
    const taskJson = JSON.parse(fs.readFileSync(path.join(directory, 'task.json'), 'utf8'))
    assert.equal(taskJson.meta.witops.dueDate, '2026-11-20')

    const executionKey = `repo::${taskJson.id}`
    const plan = readExecutionMap(context.harness.db, [executionKey]).get(executionKey)
    assert.equal(plan.dueDate, '2026-11-20')
  } finally {
    await context.cleanup()
  }
})

test('GET /projects 返回可选项目，下发时按指定项目创建', async () => {
  const context = await setup()
  try {
    const projects = await call(context.http, `/api/plugins/${PLUGIN_ID}/projects`)
    assert.equal(projects.status, 200)
    assert.deepEqual(
      projects.json.projects.map((item) => item.repositoryId),
      ['repo'],
    )
    assert.equal(projects.json.defaultRepositoryId, 'repo')

    const result = await dispatch(context, { businessId: '10001', repositoryId: 'repo' })
    assert.equal(result.status, 200)
    assert.equal(result.json.summary.imported, 1)
    assert.match(result.json.results[0].taskKey, /^repo::/)
  } finally {
    await context.cleanup()
  }
})

test('插件 store 里有旧记录但任务已删除时，可以重新下发', async () => {
  const context = await setup()
  try {
    context.harness.store.setState(PLUGIN_ID, 'task:4:10001', {
      taskKey: 'repo::01-01-T10001',
      title: '早已删除的任务',
    })
    const result = await dispatch(context, { businessId: '10001' })
    assert.equal(result.status, 200)
    assert.equal(result.json.summary.imported, 1)
    assert.match(result.json.results[0].taskKey, /T10001$/)
  } finally {
    await context.cleanup()
  }
})

test('去重以 task.json meta 为准：清掉插件 store 后仍不重复创建', async () => {
  const context = await setup()
  try {
    const first = await dispatch(context, { businessId: '10001' })
    assert.equal(first.json.summary.imported, 1)
    const taskKey = first.json.results[0].taskKey

    context.harness.store.setState(PLUGIN_ID, 'task:4:10001', null)
    const second = await dispatch(context, { businessId: '10001' })
    assert.equal(second.json.summary.duplicated, 1)
    assert.equal(second.json.results[0].taskKey, taskKey)
    assert.equal(context.fixture.state.detailCalls, 1, '重复下发不应再拉详情')
  } finally {
    await context.cleanup()
  }
})

test('POST /dispatch/preview 返回 draft 或 duplicated', async () => {
  const context = await setup()
  try {
    const before = await call(context.http, `/api/plugins/${PLUGIN_ID}/dispatch/preview`, {
      method: 'POST',
      body: { businessId: '10001' },
    })
    assert.equal(before.status, 200)
    assert.equal(before.json.results[0].status, 'ready')
    assert.match(before.json.results[0].draft.title, /T10001/)
    assert.equal(before.json.results[0].draft.assignee, 'bob')
    assert.match(before.json.results[0].draft.taskMarkdown, /^\| 字段 \| 值 \|$/m)
    assert.match(before.json.results[0].draft.prd, /prd\.md 尚未生成/)

    await dispatch(context, { businessId: '10001' })
    const after = await call(context.http, `/api/plugins/${PLUGIN_ID}/dispatch/preview`, {
      method: 'POST',
      body: { businessId: '10001' },
    })
    assert.equal(after.json.results[0].status, 'duplicated')
    assert.ok(after.json.results[0].taskKey)
    // 已存在任务也要能预览现有 task.md，而不是只给 duplicated 提示。
    assert.match(after.json.results[0].draft?.taskMarkdown ?? '', /T10001/)
    assert.equal(after.json.results[0].draft?.code, 'T10001')
  } finally {
    await context.cleanup()
  }
})

test('已存在任务没有 task.md 时回退预览 prd.md', async () => {
  const context = await setup()
  try {
    await dispatch(context, { businessId: '10001' })
    const directory = findTaskDirectory(context.repo.repositoryPath)
    fs.rmSync(path.join(directory, 'task.md'))
    fs.writeFileSync(path.join(directory, 'prd.md'), '# 历史 PRD\n\n旧任务内容')
    const preview = await call(context.http, `/api/plugins/${PLUGIN_ID}/dispatch/preview`, {
      method: 'POST',
      body: { businessId: '10001' },
    })
    const result = preview.json.results[0]
    assert.equal(result.status, 'duplicated')
    assert.equal(result.draft?.sourceName, 'prd.md')
    assert.match(result.draft?.taskMarkdown ?? '', /历史 PRD/)
  } finally {
    await context.cleanup()
  }
})

test('POST /sync 在 plugin_run 留下可查询的成功记录', async () => {
  const context = await setup()
  try {
    const result = await call(context.http, `/api/plugins/${PLUGIN_ID}/sync`, {
      method: 'POST',
      body: { size: 2 },
    })
    assert.equal(result.status, 200)
    assert.ok(Array.isArray(result.json.results))

    const runs = context.harness.store.listRuns({ pluginId: PLUGIN_ID, limit: 5 })
    assert.equal(runs.length, 1)
    assert.equal(runs[0].runId, `${PLUGIN_ID}:sync:1`)
    assert.equal(runs[0].status, 'succeeded')
    assert.ok(runs[0].result.summary)

    const viaApi = await call(context.http, `/api/plugins/${PLUGIN_ID}/executions?limit=5`)
    assert.equal(viaApi.status, 200)
    assert.equal(viaApi.json.runs.length, 1)
    assert.equal(viaApi.json.runs[0].status, 'succeeded')
  } finally {
    await context.cleanup()
  }
})

test('加载四份字典并映射 env / priority', async () => {
  const context = await setup({
    fixtureOptions: {
      tasks: [{ ...SAMPLE_DETAIL, envDicConfigCode: 3, priority: 4 }],
    },
  })
  try {
    const response = await dispatch(context, { businessId: '10001' })
    assert.equal(response.status, 200)
    assert.equal(response.json.summary.imported, 1)
    const dictionaryTypes = context.fixture.state.requests
      .filter((entry) => entry.url.endsWith('/sysDicConfig/getListByKey'))
      .map((entry) => entry.body.type)
      .sort()
    assert.deepEqual(dictionaryTypes, ['priority', 'systemEnv', 'taskCategory', 'taskStatus'])
    const directory = findTaskDirectory(context.repo.repositoryPath)
    const taskJson = JSON.parse(fs.readFileSync(path.join(directory, 'task.json'), 'utf8'))
    assert.equal(taskJson.meta.witops.env, 'PRO')
    assert.equal(taskJson.meta.witops.priority, 'P3')
    assert.equal(taskJson.priority, 'P3')
  } finally {
    await context.cleanup()
  }
})

test('任务描述为空时回退父需求并标注来源', async () => {
  const context = await setup({
    fixtureOptions: {
      tasks: [
        {
          ...SAMPLE_DETAIL,
          businessId: '10003',
          code: 'T10003',
          description: '',
          parentStoryId: 3001,
        },
      ],
    },
  })
  try {
    const response = await dispatch(context, { businessId: '10003' })
    assert.equal(response.status, 200)
    assert.equal(response.json.summary.imported, 1)
    const directory = findTaskDirectory(context.repo.repositoryPath)
    const taskMarkdown = fs.readFileSync(path.join(directory, 'task.md'), 'utf8')
    assert.match(taskMarkdown, /需求描述/)
    assert.match(taskMarkdown, /来自父需求/)
    assert.match(taskMarkdown, /\| 描述来源 \| 父需求 \|/)
  } finally {
    await context.cleanup()
  }
})

test('sync 按 pages 翻页直到 maxPerSync', async () => {
  const tasks = [1, 2, 3].map((index) => ({
    ...SAMPLE_DETAIL,
    businessId: String(20000 + index),
    code: `T${20000 + index}`,
    name: `分页任务 ${index}`,
  }))
  const context = await setup({
    fixtureOptions: { tasks },
    config: { pageSize: 1, maxPerSync: 3 },
  })
  try {
    const response = await call(context.http, `/api/plugins/${PLUGIN_ID}/sync`, {
      method: 'POST',
      body: { size: 3 },
    })
    assert.equal(response.status, 200)
    assert.equal(response.json.summary.imported, 3)
    const pageCalls = context.fixture.state.requests.filter((entry) =>
      entry.url.endsWith('/nodeTask/page'),
    )
    assert.ok(pageCalls.length >= 3, `应至少翻 3 页，实际 ${pageCalls.length}`)
  } finally {
    await context.cleanup()
  }
})

test('keepRaw 时写入 HTML 原文', async () => {
  const context = await setup({ config: { keepRaw: true, agentId: 'opencode' } })
  try {
    const response = await dispatch(context, { businessId: '10001' })
    assert.equal(response.json.summary.imported, 1)
    const directory = findTaskDirectory(context.repo.repositoryPath)
    const raw = fs.readFileSync(path.join(directory, 'prd.witops.html'), 'utf8')
    assert.match(raw, /<h2>背景<\/h2>/)
    const taskJson = JSON.parse(fs.readFileSync(path.join(directory, 'task.json'), 'utf8'))
    assert.equal(taskJson.meta.agent, 'opencode')
  } finally {
    await context.cleanup()
  }
})

test('密码模式遇到 40300 自动重登一次', async () => {
  const context = await setup()
  try {
    const listed = await call(context.http, `/api/plugins/${PLUGIN_ID}/mine`)
    assert.equal(listed.status, 200)
    context.fixture.expireTokens()
    const dispatched = await dispatch(context, { businessId: '10001' })
    assert.equal(dispatched.status, 200)
    assert.equal(dispatched.json.summary.imported, 1)
    assert.equal(context.fixture.state.logins, 2)
  } finally {
    await context.cleanup()
  }
})

test('token 模式不重试，直接返回 token 失效', async () => {
  const context = await setup({
    config: { credentials: { mode: 'token', token: 'bad-token' } },
  })
  try {
    const response = await dispatch(context, { businessId: '10001' })
    assert.equal(response.status, 401)
    assert.match(response.text, /token 已失效/)
    assert.equal(context.fixture.state.logins, 0)
    const status = await call(context.http, `/api/plugins/${PLUGIN_ID}/status`)
    assert.equal(status.json.auth.mode, 'token')
  } finally {
    await context.cleanup()
  }
})

test('缺少负责人时跳过而不创建任务', async () => {
  const noOwner = {
    businessId: '10002',
    code: 'T10002',
    name: '无负责人任务',
    type: 4,
    status: 1,
    developerName: '',
    assignedToUserId: null,
  }
  const context = await setup({ fixtureOptions: { tasks: [noOwner] } })
  try {
    const response = await dispatch(context, { businessId: '10002' })
    assert.equal(response.status, 200)
    assert.equal(response.json.summary.skipped, 1)
    assert.equal(response.json.results[0].reason, 'missing-assignee')
    const taskDirs = fs.readdirSync(path.join(context.repo.repositoryPath, '.trellis', 'tasks'))
    assert.equal(taskDirs.length, 0)
  } finally {
    await context.cleanup()
  }
})

test('5xx 按退避重试后成功', async () => {
  const context = await setup({
    config: {
      credentials: { mode: 'token', token: 'fixture-token' },
      retries: 2,
      retryBackoffMs: 5,
    },
  })
  try {
    context.fixture.failNext(2)
    const response = await dispatch(context, { businessId: '10001' })
    assert.equal(response.status, 200)
    assert.equal(response.json.summary.imported, 1)
    const detailCalls = context.fixture.state.requests.filter((item) =>
      item.url.endsWith('/nodeTask/detail'),
    )
    assert.equal(detailCalls.length, 3)
  } finally {
    await context.cleanup()
  }
})

test('请求之间保持最小间隔', async () => {
  const timestamps = []
  const client = createWitopsClient(
    {
      baseUrl: 'http://fixture',
      gatewayPrefix: '/gateway',
      taskServicePrefix: '/task-service',
      adminServicePrefix: '/admin-service',
      requestIntervalMs: 60,
      retries: 0,
    },
    {
      fetchImpl: async () => {
        timestamps.push(Date.now())
        return new Response(JSON.stringify({ code: 20000, data: [] }), { status: 200 })
      },
    },
  )
  for (const type of ['taskStatus', 'taskCategory', 'priority']) {
    await client.dictionary({ type, status: 1, size: 100 }, { token: 'fixture-token' })
  }
  assert.equal(timestamps.length, 3)
  for (let index = 1; index < timestamps.length; index += 1) {
    assert.ok(
      timestamps[index] - timestamps[index - 1] >= 50,
      `间隔过小: ${timestamps[index] - timestamps[index - 1]}ms`,
    )
  }
})

test('客户端鉴权头与路径前缀正确', async () => {
  const fixture = await createWitopsFixture()
  try {
    const client = createWitopsClient({
      baseUrl: fixture.baseUrl,
      gatewayPrefix: '/gateway',
      taskServicePrefix: '/task-service',
      adminServicePrefix: '/admin-service',
      requestIntervalMs: 0,
      retries: 0,
    })
    await client.page({ current: 1, size: 10, status: '1,3', type: 4 }, { token: 'fixture-token' })
    const request = fixture.state.requests.at(-1)
    assert.equal(request.url, '/gateway/task-service/nodeTask/page')
    assert.equal(request.token, 'fixture-token')
    await assert.rejects(
      () => client.page({ current: 1, size: 10 }, { token: 'nope' }),
      (error) => error.code === 40300 && error.authExpired === true,
    )
  } finally {
    await fixture.close()
  }
})

test('未配置密码时提示登录，面板登录后可以下发', async () => {
  const context = await setup({
    config: { credentials: { mode: 'password', account: 'alice' } },
  })
  try {
    const before = await call(context.http, `/api/plugins/${PLUGIN_ID}/mine`)
    assert.equal(before.status, 401)
    assert.match(before.text, /未登录/)

    const auth = await call(context.http, `/api/plugins/${PLUGIN_ID}/auth`)
    assert.equal(auth.json.status, 'anonymous')
    assert.equal(auth.json.hasStoredPassword, false)

    const login = await call(context.http, `/api/plugins/${PLUGIN_ID}/login`, {
      method: 'POST',
      body: { account: 'alice', password: 'secret' },
    })
    assert.equal(login.status, 200)
    assert.equal(login.json.auth.status, 'authenticated')
    assert.equal(login.json.auth.account, 'a***e')

    const dispatched = await dispatch(context, { businessId: '10001' })
    assert.equal(dispatched.json.summary.imported, 1)

    const logout = await call(context.http, `/api/plugins/${PLUGIN_ID}/logout`, { method: 'POST' })
    assert.equal(logout.json.auth.status, 'anonymous')
    assert.equal(context.fixture.state.logins, 1)
  } finally {
    await context.cleanup()
  }
})

test('记住密码：加密写入 secrets，可再次读取', async () => {
  const context = await setup({
    config: { credentials: { mode: 'password', account: 'alice' } },
  })
  try {
    const login = await call(context.http, `/api/plugins/${PLUGIN_ID}/login`, {
      method: 'POST',
      body: { account: 'alice', password: 'secret', remember: true },
    })
    assert.equal(login.status, 200)
    assert.equal(login.json.auth.hasStoredPassword, true)

    const raw = fs.readFileSync(context.secretsFile, 'utf8')
    assert.doesNotMatch(raw, /"secret"/)
    assert.match(raw, /"witops-core\/password": "enc:v1:/)
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(context.secretsFile).mode & 0o777, 0o600)
    }
  } finally {
    await context.cleanup()
  }
})

test('配置里带密码时首个请求自动登录，无需面板操作', async () => {
  const context = await setup()
  try {
    const response = await dispatch(context, { businessId: '10001' })
    assert.equal(response.status, 200)
    assert.equal(response.json.summary.imported, 1)
    assert.equal(context.fixture.state.logins, 1)
  } finally {
    await context.cleanup()
  }
})

test('GET /filters 返回四类数据源与筛选项', async () => {
  const context = await setup()
  try {
    const response = await call(context.http, `/api/plugins/${PLUGIN_ID}/filters`)
    assert.equal(response.status, 200)
    assert.deepEqual(
      response.json.types.map((item) => item.type),
      [3, 4, 2, 0],
    )
    assert.deepEqual(
      response.json.types.map((item) => item.name),
      ['需求', '任务', '缺陷', '工单'],
    )
    assert.ok(response.json.priorities.some((item) => item.code === '1' && item.name === 'P0'))
    assert.ok(response.json.statuses.some((item) => item.code === '3' && item.name === '进行中'))
    assert.deepEqual(
      response.json.categories.map((item) => item.code),
      ['1', '2'],
    )
  } finally {
    await context.cleanup()
  }
})

test('GET /mine 支持类型、编号、优先级、分类与负责人筛选', async () => {
  const context = await setup()
  try {
    const filtered = await call(
      context.http,
      `/api/plugins/${PLUGIN_ID}/mine?types=0,2&code=B40001&priority=1&categories=2`,
    )
    assert.equal(filtered.status, 200)
    assert.equal(filtered.json.items.length, 1)
    assert.equal(filtered.json.items[0].id, '40001')
    assert.equal(filtered.json.items[0].kind, 'bug')
    assert.equal(filtered.json.items[0].category, '前端开发')
    assert.equal(filtered.json.items[0].categoryCode, '2')

    const pageCalls = context.fixture.state.requests.filter((entry) =>
      entry.url.endsWith('/nodeTask/page'),
    )
    assert.ok(pageCalls.length >= 2)
    assert.ok(pageCalls.every((entry) => entry.body.assignedToUserId === 900))
    assert.ok(pageCalls.every((entry) => entry.body.categories === undefined))

    const none = await call(context.http, `/api/plugins/${PLUGIN_ID}/mine?types=2&categories=1`)
    assert.equal(none.status, 200)
    assert.equal(none.json.items.length, 0)

    const allUsers = await call(
      context.http,
      `/api/plugins/${PLUGIN_ID}/mine?types=2&allUsers=1&refresh=1`,
    )
    assert.equal(allUsers.status, 200)
    const lastPage = context.fixture.state.requests
      .filter((entry) => entry.url.endsWith('/nodeTask/page'))
      .at(-1)
    assert.equal(lastPage.body.assignedToUserId, undefined)
  } finally {
    await context.cleanup()
  }
})

test('需求下发创建父子任务，写入 base_branch 与 parentBusinessId', async () => {
  const context = await setup()
  try {
    const result = await dispatch(context, {
      businessId: '3001',
      type: 3,
      baseBranch: 'feature/witops',
      includeChildren: true,
    })
    assert.equal(result.status, 200)
    assert.equal(result.json.summary.imported, 1)
    assert.equal(result.json.results[0].childSummary.imported, 2)

    const directories = findTaskDirectories(context.repo.repositoryPath)
    assert.equal(directories.length, 3)
    const parent = directories.find((directory) => directory.endsWith('R3001'))
    const child = directories.find((directory) => directory.endsWith('T10004'))
    assert.ok(parent, `缺少父任务目录: ${directories.join(', ')}`)
    assert.ok(child, `缺少子任务目录: ${directories.join(', ')}`)

    const parentJson = readTaskJson(parent)
    assert.equal(parentJson.base_branch, 'feature/witops')
    assert.deepEqual(
      [...parentJson.children].sort(),
      directories
        .filter((directory) => directory !== parent)
        .map((directory) => path.basename(directory))
        .sort(),
    )

    const childJson = readTaskJson(child)
    assert.equal(childJson.base_branch, 'feature/witops')
    assert.equal(childJson.parent, path.basename(parent))
    assert.equal(childJson.meta.witops.parentBusinessId, '3001')
    assert.equal(childJson.meta.witops.storyId, '3001')
  } finally {
    await context.cleanup()
  }
})

test('重复下发需求时只补建缺失的子任务', async () => {
  const context = await setup()
  try {
    const first = await dispatch(context, {
      businessId: '3001',
      type: 3,
      includeChildren: false,
    })
    assert.equal(first.json.summary.imported, 1)
    assert.equal(findTaskDirectories(context.repo.repositoryPath).length, 1)

    const second = await dispatch(context, {
      businessId: '3001',
      type: 3,
      includeChildren: true,
    })
    assert.equal(second.json.summary.duplicated, 1)
    assert.equal(second.json.results[0].childSummary.imported, 2)
    assert.equal(findTaskDirectories(context.repo.repositoryPath).length, 3)
  } finally {
    await context.cleanup()
  }
})

test('需求预览返回 task.md 与已拆分子任务', async () => {
  const context = await setup()
  try {
    const preview = await call(context.http, `/api/plugins/${PLUGIN_ID}/dispatch/preview`, {
      method: 'POST',
      body: { businessId: '3001', type: 3 },
    })
    assert.equal(preview.status, 200)
    assert.equal(preview.json.results[0].status, 'ready')
    assert.match(preview.json.results[0].draft.taskMarkdown, /需求整体目标/)
    assert.equal(preview.json.results[0].children.length, 2)
    assert.deepEqual(preview.json.results[0].children.map((child) => child.code).sort(), [
      'T10001',
      'T10004',
    ])
  } finally {
    await context.cleanup()
  }
})

test('零配置自动关联：WitOps 登录用户匹配 .trellis/.developer 并写入 store 绑定', async () => {
  const context = await setup({ config: { developerMap: {}, assignee: '' } })
  try {
    fs.writeFileSync(
      path.join(context.repo.repositoryPath, '.trellis', '.developer'),
      'name=yuhaojie\ninitialized_at=2026-11-24T00:00:00Z\n',
    )
    fs.mkdirSync(path.join(context.repo.repositoryPath, '.trellis', 'workspace', 'yuhaojie'), {
      recursive: true,
    })

    const dispatched = await dispatch(context, { businessId: '10001' })
    assert.equal(dispatched.status, 200)
    assert.equal(dispatched.json.summary.imported, 1)

    const [taskDir] = findTaskDirectories(context.repo.repositoryPath)
    const taskJson = readTaskJson(taskDir)
    assert.equal(taskJson.assignee, 'yuhaojie')

    const devs = await call(
      context.http,
      `/api/plugins/${PLUGIN_ID}/developers?repositoryId=repo`,
    )
    assert.equal(devs.status, 200)
    assert.equal(devs.json.currentDeveloper, 'yuhaojie')
    assert.equal(devs.json.bindings['900'], 'yuhaojie')
  } finally {
    await context.cleanup()
  }
})

test('零配置回退：trellis.user.current 用户名匹配 .trellis/workspace 成员', async () => {
  const context = await setup({
    config: { developerMap: {}, assignee: '' },
    userProvider: () => ({
      userId: 'user-alice',
      username: 'alice',
      displayName: 'Alice',
    }),
  })
  try {
    fs.mkdirSync(path.join(context.repo.repositoryPath, '.trellis', 'workspace', 'alice'), {
      recursive: true,
    })

    const dispatched = await dispatch(context, { businessId: '10001' })
    assert.equal(dispatched.status, 200)
    assert.equal(dispatched.json.summary.imported, 1)

    const [taskDir] = findTaskDirectories(context.repo.repositoryPath)
    const taskJson = readTaskJson(taskDir)
    assert.equal(taskJson.assignee, 'alice')
  } finally {
    await context.cleanup()
  }
})

test('缺少负责人返回结构化诊断，并支持弹窗手动选择与记住映射', async () => {
  const unknownOwner = {
    businessId: '72411',
    code: 'T72411',
    name: '跨人任务',
    type: 4,
    status: 1,
    developerName: '',
    assignedToUserId: 161,
  }
  const context = await setup({
    fixtureOptions: { tasks: [unknownOwner] },
    config: { developerMap: {}, assignee: '' },
  })
  try {
    const skipped = await dispatch(context, { businessId: '72411' })
    assert.equal(skipped.status, 200)
    assert.equal(skipped.json.summary.skipped, 1)
    const entry = skipped.json.results[0]
    assert.equal(entry.reason, 'missing-assignee')
    assert.equal(entry.details.witopsUserId, '161')
    assert.ok(Array.isArray(entry.details.availableDevelopers))
    assert.ok(entry.details.availableDevelopers.includes('bob'))
    assert.match(entry.message, /可选 Trellis 成员/)

    const explicit = await dispatch(context, {
      businessId: '72411',
      assignee: 'bob',
      rememberBinding: true,
    })
    assert.equal(explicit.status, 200)
    assert.equal(explicit.json.summary.imported, 1)
    const [taskDir] = findTaskDirectories(context.repo.repositoryPath)
    assert.equal(readTaskJson(taskDir).assignee, 'bob')

    const devs = await call(
      context.http,
      `/api/plugins/${PLUGIN_ID}/developers?repositoryId=repo`,
    )
    assert.equal(devs.status, 200)
    assert.equal(devs.json.bindings['161'], 'bob')

    const putBind = await call(
      context.http,
      `/api/plugins/${PLUGIN_ID}/developer-bindings`,
      {
        method: 'PUT',
        body: { repositoryId: 'repo', witopsUserId: '162', assignee: 'bob' },
      },
    )
    assert.equal(putBind.status, 200)
    assert.equal(putBind.json.bindings['162'], 'bob')
  } finally {
    await context.cleanup()
  }
})
