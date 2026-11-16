import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createHarness, startHttpServer } from '@trellis-board/test-support/plugin-runtime.js'
import { startFakeJenkins } from './fake-jenkins.js'

const ID = 'jenkins-ops'
const MODULE = fileURLToPath(new URL('../index.js', import.meta.url))
const CALLER_MODULE = fileURLToPath(new URL('./fixtures/jenkins-caller/index.js', import.meta.url))

async function setup({
  username = 'Z0328',
  password = 'secret',
  withCaller = false,
  missingPermission = null,
} = {}) {
  // fake 侧固定用 secret 作为正确密码，便于传错密码的用例
  const jenkins = await startFakeJenkins({
    missingPermission,
    formLogin: { username, password: 'secret' },
  })
  const plugins = [
    {
      id: ID,
      module: MODULE,
      enabled: true,
      config: {
        baseUrl: jenkins.baseUrl,
        username,
        password,
        timeoutMs: 5000,
        retries: 0,
      },
    },
  ]
  if (withCaller) {
    plugins.push({
      id: 'jenkins-caller',
      module: CALLER_MODULE,
      enabled: true,
      config: {},
    })
  }
  const harness = await createHarness({ plugins, hostVersion: '0.4.24' })
  const http = await startHttpServer(harness.runtime)
  return {
    jenkins,
    harness,
    http,
    async api(path, init) {
      const response = await fetch(`${http.baseUrl}/api/plugins/${ID}${path}`, init)
      const contentType = response.headers.get('content-type') || ''
      const data = contentType.includes('json') ? await response.json() : await response.text()
      return { status: response.status, data }
    },
    async post(path, body) {
      return this.api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
    },
    async cleanup() {
      await http.close()
      await harness.cleanup()
      await jenkins.close()
    },
  }
}

test('花括号 job 名（{dev}xxx）能正确编码并访问', async () => {
  const context = await setup()
  try {
    const JOB = '{dev}luban_mdp-backend-web'
    context.jenkins.addJob(JOB, { description: '带花括号的 job' })

    const detail = await context.api(`/job?name=${encodeURIComponent(JOB)}`)
    assert.equal(detail.status, 200)
    assert.equal(detail.data.name, JOB)

    const built = await context.post('/build', { job: JOB, wait: true })
    assert.equal(built.status, 200)
    assert.equal(built.data.buildNumber, 1)

    const paths = context.jenkins.state.requests.map((entry) => entry.path)
    assert.ok(
      paths.includes('/job/%7Bdev%7Dluban_mdp-backend-web/build'),
      `期望花括号被编码: ${paths.join(' | ')}`,
    )
  } finally {
    await context.cleanup()
  }
})

test('动态参数 Branch：返回 dynamicChoices 并可取候选分支', async () => {
  const context = await setup()
  try {
    const CLASS =
      'com.syhuang.hudson.plugins.listgitbranchesparameter.ListGitBranchesParameterDefinition'
    context.jenkins.addJob('branch-job', {
      parameters: [
        { name: 'Branch', type: 'PT_BRANCH', className: CLASS, defaultValue: 'refs/heads/main' },
      ],
      dynamicValues: { Branch: ['refs/heads/main', 'refs/heads/dev', 'refs/heads/feat/x'] },
    })

    const detail = await context.api('/job?name=branch-job')
    assert.equal(detail.status, 200)
    const branch = detail.data.parameters.find((item) => item.name === 'Branch')
    assert.equal(branch.dynamicChoices, true)
    assert.equal(branch.className, CLASS)

    const values = await context.api(
      `/param-values?job=branch-job&name=Branch&class=${encodeURIComponent(CLASS)}`,
    )
    assert.equal(values.status, 200)
    assert.deepEqual(values.data.values, ['refs/heads/main', 'refs/heads/dev', 'refs/heads/feat/x'])
  } finally {
    await context.cleanup()
  }
})

test('连接测试返回 Jenkins 版本', async () => {
  const context = await setup()
  try {
    const { data } = await context.api('/status')
    assert.equal(data.configured, true)
    assert.equal(data.connection.jenkinsVersion, '2.479.1')
    assert.equal(data.connection.mode, 'NORMAL')
    assert.equal(data.error, null)
    assert.equal(data.hasPassword, true)
    assert.equal(data.authMode, 'password')
  } finally {
    await context.cleanup()
  }
})

test('GET /jobs 返回 job 列表并按状态映射颜色', async () => {
  const context = await setup()
  try {
    const { status, data } = await context.api('/jobs')
    assert.equal(status, 200)
    const names = data.jobs.map((job) => job.name).sort()
    assert.deepEqual(names, ['demo', 'deploy-api'])
    const demo = data.jobs.find((job) => job.name === 'demo')
    assert.equal(demo.status, 'success')
    assert.equal(demo.isFolder, false)
  } finally {
    await context.cleanup()
  }
})

test('按 views 列 job：多视图合并、标记来源、去重', async () => {
  const context = await setup()
  try {
    const saved = await context.post('/settings', {
      views: ['标品MOM3-DEV', '标品MOM3-FAT'],
    })
    assert.deepEqual(saved.data.status.views, ['标品MOM3-DEV', '标品MOM3-FAT'])

    const { status, data } = await context.api('/jobs')
    assert.equal(status, 200)
    assert.deepEqual(data.views, ['标品MOM3-DEV', '标品MOM3-FAT'])
    assert.deepEqual(data.jobs.map((job) => job.name).sort(), ['demo', 'deploy-api'])
    assert.equal(data.jobs.find((job) => job.name === 'demo').view, '标品MOM3-DEV')
    assert.equal(data.jobs.find((job) => job.name === 'deploy-api').view, '标品MOM3-FAT')
  } finally {
    await context.cleanup()
  }
})

test('all=1 时忽略 views 回到全站列表，空 view 不报错', async () => {
  const context = await setup()
  try {
    await context.post('/settings', { views: ['empty-view'] })
    const empty = await context.api('/jobs')
    assert.equal(empty.status, 200)
    assert.deepEqual(empty.data.jobs, [])

    const all = await context.api('/jobs?all=1')
    assert.equal(all.data.views, undefined)
    assert.equal(all.data.jobs.length, 2)
  } finally {
    await context.cleanup()
  }
})

test('GET /job 返回参数定义', async () => {
  const context = await setup()
  try {
    const { status, data } = await context.api('/job?name=deploy-api')
    assert.equal(status, 200)
    assert.equal(data.name, 'deploy-api')
    const names = data.parameters.map((parameter) => parameter.name)
    assert.deepEqual(names, ['TARGET', 'MODE', 'DRY_RUN'])
    const mode = data.parameters.find((parameter) => parameter.name === 'MODE')
    assert.deepEqual(mode.choices, ['rolling', 'blue-green'])
    assert.equal(
      data.parameters.find((parameter) => parameter.name === 'DRY_RUN').type,
      'BooleanParameterDefinition',
    )
  } finally {
    await context.cleanup()
  }
})

test('参数化构建：带 crumb 触发并等待构建号', async () => {
  const context = await setup()
  try {
    const { status, data } = await context.post('/build', {
      job: 'deploy-api',
      parameters: { TARGET: 'prod', MODE: 'blue-green', DRY_RUN: true },
      wait: true,
    })
    assert.equal(status, 200)
    assert.equal(data.triggered, true)
    assert.equal(data.parameterized, true)
    assert.equal(data.buildNumber, 1)
    assert.equal(data.queueId, 100)

    const build = context.jenkins.state.jobs.get('deploy-api').builds[0]
    assert.deepEqual(build.parameters, { TARGET: 'prod', MODE: 'blue-green', DRY_RUN: 'true' })

    const posted = context.jenkins.state.requests.filter(
      (entry) => entry.method === 'POST' && entry.path !== '/j_spring_security_check',
    )
    assert.ok(posted.length > 0)
    assert.ok(
      posted.every((entry) => entry.crumb === 'fake-crumb-value'),
      'POST 未带 crumb',
    )
    const crumbCalls = context.jenkins.state.requests.filter(
      (entry) => entry.path === '/crumbIssuer/api/json',
    )
    assert.equal(crumbCalls.length, 1, 'crumb 应被缓存复用')
  } finally {
    await context.cleanup()
  }
})

test('无参数构建走 /build 而不是 buildWithParameters', async () => {
  const context = await setup()
  try {
    const { data } = await context.post('/build', { job: 'demo', wait: true })
    assert.equal(data.parameterized, false)
    assert.equal(data.buildNumber, 1)
    const paths = context.jenkins.state.requests.map((entry) => entry.path)
    assert.ok(paths.includes('/job/demo/build'))
    assert.ok(!paths.includes('/job/demo/buildWithParameters'))
  } finally {
    await context.cleanup()
  }
})

test('构建状态、日志、中止、产物', async () => {
  const context = await setup()
  try {
    await context.post('/build', { job: 'demo', wait: true })

    const build = await context.api('/build?job=demo&number=1')
    assert.equal(build.status, 200)
    assert.equal(build.data.number, 1)
    assert.equal(build.data.result, 'SUCCESS')

    const log = await context.api('/log?job=demo&number=1&tail=2')
    assert.equal(log.status, 200)
    assert.match(log.data.text, /Finished: SUCCESS/)
    assert.equal(log.data.truncated, true)

    const stopped = await context.post('/build/stop', { job: 'demo', number: 1 })
    assert.equal(stopped.status, 200)
    assert.equal(stopped.data.stopped, true)
    const after = await context.api('/build?job=demo&number=1')
    assert.equal(after.data.result, 'ABORTED')
  } finally {
    await context.cleanup()
  }
})

test('产物列表给出可直接访问的下载路径，并能取回内容', async () => {
  const context = await setup()
  try {
    const job = context.jenkins.state.jobs.get('demo')
    job.artifacts = [
      { fileName: 'report.txt', relativePath: 'out/report.txt', content: 'hello artifact' },
    ]
    await context.post('/build', { job: 'demo', wait: true })

    const listed = await context.api('/artifacts?job=demo&number=1')
    assert.equal(listed.status, 200)
    assert.equal(listed.data.artifacts.length, 1)
    assert.equal(listed.data.artifacts[0].fileName, 'report.txt')
    assert.equal(listed.data.artifacts[0].downloadPath, '/job/demo/1/artifact/out/report.txt')

    const fetched = await context.api('/artifact?job=demo&number=1&path=out%2Freport.txt')
    assert.equal(fetched.status, 200)
    assert.equal(Buffer.from(fetched.data.base64, 'base64').toString('utf8'), 'hello artifact')
    assert.match(fetched.data.contentType, /text\/plain/)
  } finally {
    await context.cleanup()
  }
})

test('队列列表与取消', async () => {
  const context = await setup()
  try {
    context.jenkins.state.queue.push({
      id: 7,
      job: 'demo',
      since: Date.now(),
      why: '等待可用执行器',
    })
    const queue = await context.api('/queue')
    assert.equal(queue.status, 200)
    assert.equal(queue.data.items.length, 1)
    assert.equal(queue.data.items[0].job, 'demo')

    const cancelled = await context.post('/queue/cancel', { id: 7 })
    assert.equal(cancelled.status, 200)
    assert.equal(cancelled.data.cancelled, true)
    assert.equal(context.jenkins.state.queue.length, 0)
  } finally {
    await context.cleanup()
  }
})

test('密码错误时把登录失败映射成可读错误', async () => {
  const context = await setup({ password: 'wrong-password' })
  try {
    const { status, data } = await context.api('/jobs')
    assert.equal(status, 401)
    assert.match(data.error, /登录失败：账号或密码不正确/)
    assert.equal(data.code, 1001)
  } finally {
    await context.cleanup()
  }
})

test('403 页面里缺失的权限名被解析成可读提示', async () => {
  const context = await setup({ missingPermission: 'Overall/Read' })
  try {
    const { status, data } = await context.api('/jobs')
    assert.equal(status, 403, '应保留 Jenkins 的 403，而不是笼统映射成 401')
    assert.match(data.error, /账号 \S+ 缺少 Overall\/Read 权限/)
    assert.equal(data.code, 1001)
  } finally {
    await context.cleanup()
  }
})

test('面板写入的 baseUrl 覆盖 plugins.json 配置', async () => {
  const context = await setup()
  try {
    const missing = await context.post('/settings', { baseUrl: 'http://127.0.0.1:1' })
    assert.equal(missing.status, 200)
    assert.equal(missing.data.status.baseUrl, 'http://127.0.0.1:1')
    assert.ok(missing.data.status.error, '错误地址应连接失败')

    const restored = await context.post('/settings', { baseUrl: context.jenkins.baseUrl })
    assert.equal(restored.data.status.connection.jenkinsVersion, '2.479.1')

    const stored = await context.harness.store.getState(ID, 'settings')
    assert.equal(stored.baseUrl, context.jenkins.baseUrl)
  } finally {
    await context.cleanup()
  }
})

test('非法 baseUrl 被拒绝', async () => {
  const context = await setup()
  try {
    const { status, data } = await context.post('/settings', { baseUrl: 'jenkins.local' })
    assert.equal(status, 400)
    assert.match(data.error, /http:\/\/ 或 https:\/\//)
  } finally {
    await context.cleanup()
  }
})

test('jenkins.ops capability 可被其他插件调用，未声明的方法被拒绝', async () => {
  const context = await setup({ withCaller: true })
  try {
    const jobs = await fetch(`${context.http.baseUrl}/api/plugins/jenkins-caller/jobs`).then(
      (response) => response.json(),
    )
    assert.ok(jobs.result.jobs.length >= 2)

    const trigger = await fetch(
      `${context.http.baseUrl}/api/plugins/jenkins-caller/trigger?job=deploy-api&target=prod`,
    ).then((response) => response.json())
    assert.equal(trigger.result.buildNumber, 1)

    const undeclared = await fetch(`${context.http.baseUrl}/api/plugins/jenkins-caller/undeclared`)
    assert.equal(undeclared.status, 403)
  } finally {
    await context.cleanup()
  }
})
