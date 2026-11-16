/**
 * 最小 Jenkins 假服务器：只实现 jenkins-client.js 用到的那几个端点。
 *
 * 造它而不是 mock fetch，是因为客户端里最容易出错的部分恰好是协议细节：
 * Basic 认证头、crumb 头、build 触发的 201 + Location、队列项的 executable.number。
 */
import http from 'node:http'

function json(response, status, payload, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  response.end(JSON.stringify(payload))
}

function text(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers })
  response.end(body)
}

function splitJobPath(segments) {
  const names = []
  let index = 0
  while (segments[index] === 'job' && segments[index + 1] !== undefined) {
    names.push(decodeURIComponent(segments[index + 1]))
    index += 2
  }
  return { job: names.join('/'), rest: segments.slice(index) }
}

export function createFakeJenkins({
  username = 'bot',
  token = 'token',
  crumb = true,
  missingPermission = null,
  formLogin = null,
} = {}) {
  const sessions = new Set() // 仅表单登录成功的会话（seed 会话是匿名）
  const state = {
    jobs: new Map(),
    queue: [],
    requests: [],
    nextQueueId: 100,
    auth: username && token ? `${username}:${token}` : null,
    formLogin,
    crumbEnabled: crumb,
    views: new Map([
      ['标品MOM3-DEV', ['demo']],
      ['标品MOM3-FAT', ['deploy-api']],
      ['empty-view', []],
    ]),
  }

  function addJob(
    name,
    {
      color = 'blue',
      description = '',
      parameters = [],
      builds = [],
      artifacts = [],
      dynamicValues = {},
    } = {},
  ) {
    state.jobs.set(name, { name, color, description, parameters, builds, artifacts, dynamicValues })
    return state.jobs.get(name)
  }

  addJob('demo', { description: '演示 job' })
  addJob('deploy-api', {
    description: '部署 API',
    parameters: [
      { name: 'TARGET', type: 'StringParameterDefinition', defaultValue: 'staging' },
      {
        name: 'MODE',
        type: 'ChoiceParameterDefinition',
        defaultValue: 'rolling',
        choices: ['rolling', 'blue-green'],
      },
      { name: 'DRY_RUN', type: 'BooleanParameterDefinition', defaultValue: false },
    ],
  })

  function jobSummary(job) {
    return {
      name: job.name.split('/').pop(),
      fullName: job.name,
      url: `http://jenkins.invalid/job/${job.name}/`,
      color: job.color,
      description: job.description,
      _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob',
    }
  }

  function buildSummary(build) {
    return build
      ? {
          number: build.number,
          result: build.result,
          building: build.building,
          duration: build.duration,
          timestamp: build.timestamp,
          displayName: `#${build.number}`,
          url: `http://jenkins.invalid/job/x/${build.number}/`,
        }
      : null
  }

  function jobDetail(job) {
    const last = job.builds[job.builds.length - 1] ?? null
    return {
      name: job.name.split('/').pop(),
      fullName: job.name,
      url: `http://jenkins.invalid/job/${job.name}/`,
      color: job.color,
      description: job.description,
      buildable: true,
      inQueue: false,
      nextBuildNumber: (last?.number ?? 0) + 1,
      property: [
        {
          parameterDefinitions: job.parameters.map((parameter) => ({
            _class: parameter.className,
            name: parameter.name,
            type: parameter.type,
            description: parameter.description ?? '',
            defaultParameterValue: { value: parameter.defaultValue },
            ...(parameter.choices ? { choices: parameter.choices } : {}),
          })),
        },
      ],
      lastBuild: buildSummary(last),
      lastSuccessfulBuild: buildSummary(
        job.builds.filter((build) => build.result === 'SUCCESS').pop() ?? null,
      ),
      lastFailedBuild: buildSummary(
        job.builds.filter((build) => build.result === 'FAILURE').pop() ?? null,
      ),
    }
  }

  function startBuild(job, parameters) {
    const number = (job.builds[job.builds.length - 1]?.number ?? 0) + 1
    const build = {
      number,
      result: 'SUCCESS',
      building: false,
      duration: 1_500,
      timestamp: Date.now(),
      parameters,
      log: `Started by user bot\n参数: ${JSON.stringify(parameters)}\nFinished: SUCCESS\n`,
      artifacts: job.artifacts,
    }
    job.builds.push(build)
    job.color = 'blue'
    return build
  }

  function sessionOf(request) {
    const raw = String(request.headers.cookie ?? '')
    for (const pair of raw.split(';')) {
      const [name, value] = pair.split('=').map((part) => part.trim())
      if (name && name.startsWith('JSESSIONID') && value && sessions.has(value)) return value
    }
    return null
  }

  function handle(request, response, url) {
    const segments = url.pathname.split('/').filter(Boolean)
    const method = request.method ?? 'GET'
    state.requests.push({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization: request.headers.authorization ?? null,
      crumb: request.headers['jenkins-crumb'] ?? null,
    })

    const sessionId = sessionOf(request)

    // 表单登录：Jenkins 必须先 GET /login 拿初始会话，再 POST 表单
    if (url.pathname === '/login' && method === 'GET') {
      const sid = `seed-${sessions.size + 1}`
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'set-cookie': `JSESSIONID.a=${sid}; Path=/; HttpOnly`,
      })
      response.end('<html><body>login</body></html>')
      return
    }
    if (url.pathname === '/j_spring_security_check' && method === 'POST') {
      let raw = ''
      request.on('data', (chunk) => {
        raw += chunk
      })
      request.on('end', () => {
        const form = Object.fromEntries(new URLSearchParams(raw))
        const expected = state.formLogin
        if (
          !expected ||
          form.j_username !== expected.username ||
          form.j_password !== expected.password
        ) {
          text(response, 403, '登录失败')
          return
        }
        const sid = `auth-${sessions.size + 1}`
        sessions.add(sid)
        response.writeHead(302, {
          location: 'http://127.0.0.1/',
          'set-cookie': `JSESSIONID.a=${sid}; Path=/; HttpOnly`,
        })
        response.end()
      })
      return
    }
    if (url.pathname === '/whoAmI/api/json') {
      const basicOk =
        state.auth &&
        request.headers.authorization ===
          `Basic ${Buffer.from(state.auth, 'utf8').toString('base64')}`
      if (!sessionId && !basicOk) {
        json(response, 200, { authenticated: false, anonymous: true, name: 'anonymous' })
        return
      }
      json(response, 200, {
        authenticated: true,
        anonymous: false,
        name: state.formLogin?.username ?? username,
      })
      return
    }

    if (state.auth && !sessionId) {
      const expected = `Basic ${Buffer.from(state.auth, 'utf8').toString('base64')}`
      if (request.headers.authorization !== expected) {
        text(response, 401, 'Unauthorized')
        return
      }
    }

    if (missingPermission) {
      response.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        `<html><head><title>Jenkins</title></head><body><h1>Access Denied</h1>` +
          `<p>${username.toLowerCase()} is missing the ${missingPermission} permission</p></body></html>`,
      )
      return
    }

    if (method === 'POST' && state.crumbEnabled && !request.headers['jenkins-crumb']) {
      text(response, 403, 'No valid crumb was included in the request')
      return
    }

    // 动态参数候选值：/job/<job>/descriptorByName/<class>/fillValueItems?param=X
    if (url.pathname.endsWith('/fillValueItems') && url.pathname.includes('/descriptorByName/')) {
      const marker = '/descriptorByName/'
      const head = url.pathname.slice(0, url.pathname.indexOf(marker))
      const jobName = decodeURIComponent(head.replace(/^\/job\//, ''))
      const job = state.jobs.get(jobName)
      const param = url.searchParams.get('param') ?? ''
      const values = job?.dynamicValues?.[param] ?? []
      json(response, 200, {
        _class: 'hudson.util.ListBoxModel',
        values: values.map((value) => ({ name: value, value, selected: false })),
      })
      return
    }

    if (url.pathname === '/crumbIssuer/api/json') {
      json(response, 200, {
        crumbRequestField: 'Jenkins-Crumb',
        crumb: 'fake-crumb-value',
      })
      return
    }

    if (segments[0] === 'view' && segments[1] && segments[2] === 'api') {
      const view = decodeURIComponent(segments[1])
      if (!state.views.has(view)) {
        text(response, 404, `No such view: ${view}`)
        return
      }
      json(response, 200, {
        name: view,
        jobs: state.views
          .get(view)
          .map((name) => state.jobs.get(name))
          .filter(Boolean)
          .map(jobSummary),
      })
      return
    }

    if (url.pathname === '/api/json') {
      const topLevel = [...state.jobs.values()].filter((job) => !job.name.includes('/'))
      json(
        response,
        200,
        {
          mode: 'NORMAL',
          nodeDescription: 'fake',
          useSecurity: true,
          jobs: topLevel.map(jobSummary),
        },
        { 'x-jenkins': '2.479.1' },
      )
      return
    }

    if (url.pathname === '/queue/api/json') {
      json(response, 200, {
        items: state.queue.map((item) => ({
          id: item.id,
          task: { name: item.job, url: `http://jenkins.invalid/job/${item.job}/` },
          why: item.why ?? '等待可用执行器',
          inQueueSince: item.since,
          stuck: false,
          blocked: false,
          buildable: true,
          cancelable: true,
          ...(item.number ? { executable: { number: item.number } } : {}),
        })),
      })
      return
    }

    if (segments[0] === 'queue' && segments[1] === 'item' && segments[3] === 'api') {
      const id = Number(segments[2])
      const item = state.queue.find((entry) => entry.id === id)
      if (!item) {
        text(response, 404, 'Not Found')
        return
      }
      json(response, 200, {
        id: item.id,
        cancelled: item.cancelled === true,
        why: item.why ?? null,
        ...(Number.isInteger(item.number) ? { executable: { number: item.number } } : {}),
      })
      return
    }

    if (url.pathname === '/queue/cancelItem' && method === 'POST') {
      const id = Number(url.searchParams.get('id'))
      const index = state.queue.findIndex((item) => item.id === id)
      if (index < 0) {
        text(response, 404, 'Not Found')
        return
      }
      state.queue.splice(index, 1)
      response.writeHead(204)
      response.end()
      return
    }

    const { job: jobName, rest } = splitJobPath(segments)
    if (!jobName) {
      text(response, 404, 'Not Found')
      return
    }
    const job = state.jobs.get(jobName)
    if (!job) {
      text(response, 404, `No such job: ${jobName}`)
      return
    }

    if (rest.length === 2 && rest[0] === 'api' && rest[1] === 'json') {
      json(response, 200, jobDetail(job))
      return
    }

    if (method === 'POST' && rest.length === 1 && rest[0] === 'build') {
      const build = startBuild(job, {})
      state.queue.push({
        id: state.nextQueueId++,
        job: jobName,
        number: build.number,
        since: Date.now(),
      })
      text(response, 201, '', {
        location: `http://jenkins.invalid/queue/item/${state.nextQueueId - 1}/`,
      })
      return
    }

    if (method === 'POST' && rest.length === 1 && rest[0] === 'buildWithParameters') {
      let body = ''
      request.on('data', (chunk) => {
        body += chunk
      })
      request.on('end', () => {
        const parameters = Object.fromEntries(new URLSearchParams(body))
        const build = startBuild(job, parameters)
        state.queue.push({
          id: state.nextQueueId++,
          job: jobName,
          number: build.number,
          since: Date.now(),
        })
        text(response, 201, '', {
          location: `http://jenkins.invalid/queue/item/${state.nextQueueId - 1}/`,
        })
      })
      return
    }

    if (rest[0] === 'lastBuild') rest[0] = String(job.builds[job.builds.length - 1]?.number ?? 0)
    const buildNumber = Number(rest[0])
    const build = job.builds.find((item) => item.number === buildNumber)
    const tail = rest.slice(1)

    if (tail[0] === 'api' && tail[1] === 'json') {
      if (!build) {
        text(response, 404, 'Not Found')
        return
      }
      json(response, 200, {
        ...buildSummary(build),
        artifacts: build.artifacts.map((artifact) => ({
          fileName: artifact.fileName,
          relativePath: artifact.relativePath,
          displayPath: artifact.relativePath,
        })),
      })
      return
    }

    if (tail[0] === 'consoleText') {
      if (!build) {
        text(response, 404, 'Not Found')
        return
      }
      text(response, 200, build.log)
      return
    }

    if (method === 'POST' && tail[0] === 'stop') {
      if (!build) {
        text(response, 404, 'Not Found')
        return
      }
      build.result = 'ABORTED'
      text(response, 200, '')
      return
    }

    if (tail[0] === 'artifact') {
      const relativePath = tail.slice(1).map(decodeURIComponent).join('/')
      const artifact = build?.artifacts.find((item) => item.relativePath === relativePath)
      if (!artifact) {
        text(response, 404, 'Not Found')
        return
      }
      text(response, 200, artifact.content ?? '')
      return
    }

    text(response, 404, 'Not Found')
  }

  return { state, addJob, handle, jobDetail }
}

export async function startFakeJenkins(options = {}) {
  const jenkins = createFakeJenkins(options)
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    jenkins.handle(request, response, url)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    ...jenkins,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
