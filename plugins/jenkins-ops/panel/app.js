/**
 * Jenkins 面板：跑在宿主 iframe 里（sandbox 无 allow-same-origin），
 * 所有请求都经 postMessage 桥转给 `/api/plugins/jenkins-ops/*`。
 *
 * 全部界面用 DOM API 构建（不用 innerHTML）：Jenkins 返回的 job 名、描述、
 * 日志都可能包含尖括号，字符串拼接模板会变成注入点。
 */
const state = {
  status: null,
  jobs: [],
  filter: '',
  selected: null,
  job: null,
  theme: 'light',
  pollTimer: null,
}

const pending = new Map()
let sequence = 0
let initialized = false

function byId(id) {
  return document.getElementById(id)
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = String(value)
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value)
    } else if (key in node) node[key] = value
    else node.setAttribute(key, String(value))
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === undefined || child === null || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

function clear(node, ...children) {
  node.replaceChildren(...children.filter(Boolean))
}

function rpc(method, path, body) {
  const id = `r${++sequence}`
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    window.parent.postMessage({ type: 'trellis:request', id, method, path, body }, '*')
  })
}

window.addEventListener('message', (event) => {
  const message = event.data
  if (!message || typeof message !== 'object') return
  if (message.type === 'trellis:init') {
    state.theme = message.theme || 'light'
    document.documentElement.dataset.theme = state.theme
    if (!initialized) {
      initialized = true
      void load()
    }
    return
  }
  if (message.type === 'trellis:response') {
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.ok) entry.resolve(message.data)
    else entry.reject(new Error(message.data?.error || `请求失败（${message.status}）`))
  }
})

function toast(message, kind = 'info') {
  const node = byId('toast')
  node.textContent = message
  node.dataset.kind = kind
  node.hidden = false
  clearTimeout(node.hideTimer)
  node.hideTimer = setTimeout(() => {
    node.hidden = true
  }, 4000)
}

function timeAgo(timestamp) {
  if (!Number.isFinite(timestamp)) return ''
  const diff = Date.now() - timestamp
  if (diff < 60_000) return '刚刚'
  const minutes = Math.round(diff / 60_000)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`
}

const STATUS_TEXT = {
  success: '成功',
  failed: '失败',
  unstable: '不稳定',
  building: '构建中',
  aborted: '已中止',
  disabled: '已禁用',
  notbuilt: '未构建',
  unknown: '未知',
}

function statusLabel(status) {
  return STATUS_TEXT[status] || STATUS_TEXT.unknown
}

function statusOfResult(build) {
  if (!build) return 'unknown'
  if (build.building) return 'building'
  const result = String(build.result || '').toLowerCase()
  if (!result) return 'unknown'
  return result === 'success' ? 'success' : result === 'failure' ? 'failed' : result
}

function dot(status) {
  return el('span', {
    class: `dot status-${status}`,
    title: statusLabel(status),
  })
}

async function load() {
  await Promise.all([loadStatus(), loadJobs()])
}

async function loadStatus() {
  try {
    state.status = await rpc('GET', '/status')
    renderConnection()
  } catch (error) {
    renderConnection(error.message)
  }
}

function renderConnection(error) {
  const node = byId('conn')
  const status = state.status
  node.classList.remove('ok', 'warn', 'bad')
  if (error || status?.error) {
    node.textContent = '连接异常'
    node.classList.add('bad')
    node.title = error || status.error
    return
  }
  if (!status?.configured) {
    node.textContent = '未配置'
    node.title = '点「设置」填写 Jenkins 地址、账号与密码'
    return
  }
  node.textContent = status.connection?.jenkinsVersion
    ? `Jenkins ${status.connection.jenkinsVersion}`
    : '已配置'
  node.classList.add('ok')
  node.title = `${status.baseUrl}（${status.username || '匿名'}）`
}

async function loadJobs() {
  try {
    const data = await rpc('GET', '/jobs')
    state.jobs = data.jobs || []
    renderJobs()
  } catch (error) {
    state.jobs = []
    renderJobs()
    byId('jobs-empty').textContent = error.message
    byId('jobs-empty').hidden = false
  }
}

function visibleJobs() {
  const filter = state.filter.trim().toLowerCase()
  if (!filter) return state.jobs
  return state.jobs.filter((job) => job.name.toLowerCase().includes(filter))
}

function renderJobs() {
  const list = byId('jobs')
  const jobs = visibleJobs()
  clear(
    list,
    ...jobs.map((job) =>
      el(
        'li',
        {
          class: job.name === state.selected ? 'job active' : 'job',
          dataset: { job: job.name },
          onclick: () => {
            void selectJob(job.name)
          },
        },
        [
          dot(job.status),
          el('span', { class: 'job-name', title: job.name, text: job.shortName || job.name }),
          job.view
            ? el('span', { class: 'view-tag', title: `视图 ${job.view}`, text: job.view })
            : null,
        ],
      ),
    ),
  )
  byId('jobs-empty').hidden = jobs.length > 0
  if (jobs.length) return
  byId('jobs-empty').textContent = state.jobs.length
    ? '没有匹配的 job'
    : state.status?.configured
      ? 'Jenkins 里没有可见的 job'
      : '尚未配置 Jenkins 连接，请点右上角「设置」'
}

async function selectJob(name) {
  state.selected = name
  renderJobs()
  stopPolling()
  try {
    state.job = await rpc('GET', `/job?name=${encodeURIComponent(name)}`)
    renderJob()
    schedulePollIfBuilding()
  } catch (error) {
    clear(byId('job-body'), el('div', { class: 'empty bad', text: error.message }))
  }
}

async function loadParameterOptions(definition, combo) {
  const job = state.job?.name
  if (!job) {
    combo.setError('先选择任务')
    return
  }
  try {
    const query = [
      `job=${encodeURIComponent(job)}`,
      `name=${encodeURIComponent(definition.name)}`,
      `class=${encodeURIComponent(definition.className || '')}`,
    ].join('&')
    const data = await rpc('GET', `/param-values?${query}`)
    const values = (Array.isArray(data.values) ? data.values : []).map((value) => String(value))
    combo.setValues(values)
  } catch (error) {
    combo.setError(error.message)
  }
}

function parameterNode(definition) {
  const id = `param-${definition.name}`
  const description = definition.description ? ` · ${definition.description}` : ''
  const label = el('label', { for: id, text: `${definition.name}${description}` })
  if (definition.type === 'BooleanParameterDefinition') {
    const checked = definition.defaultValue === true || definition.defaultValue === 'true'
    return el('div', { class: 'field inline' }, [
      el('input', { id, name: definition.name, type: 'checkbox', checked }),
      el('label', { for: id, text: `${definition.name}${description}` }),
    ])
  }
  // 动态参数（例如 List Git Branches 的 Branch）：可搜索的下拉框
  if (definition.dynamicChoices) {
    const combo = TrellisCombo.create({
      id,
      name: definition.name,
      value: definition.defaultValue,
      placeholder: '输入关键字过滤，或点右侧箭头选择',
    })
    combo.hint.textContent = '正在加载可选值…'
    void loadParameterOptions(definition, combo)
    return el('div', { class: 'field' }, [label, combo.root, combo.hint])
  }

  if (definition.type === 'ChoiceParameterDefinition' && definition.choices?.length) {
    const select = el(
      'select',
      { id, name: definition.name },
      definition.choices.map((choice) =>
        el('option', {
          value: String(choice),
          text: String(choice),
          selected: String(choice) === String(definition.defaultValue),
        }),
      ),
    )
    return el('div', { class: 'field' }, [label, select])
  }
  return el('div', { class: 'field' }, [
    label,
    el('input', {
      id,
      name: definition.name,
      type: 'text',
      value: definition.defaultValue == null ? '' : String(definition.defaultValue),
    }),
  ])
}

function renderJob() {
  const job = state.job
  if (!job) return
  byId('job-title').textContent = job.name
  const last = job.lastBuild
  byId('job-meta').textContent = [
    job.description,
    last ? `最近构建 #${last.number} · ${timeAgo(last.timestamp)}` : '还没有构建记录',
  ]
    .filter(Boolean)
    .join(' · ')

  const lastValue = last
    ? `#${last.number} ${statusLabel(statusOfResult(last))}${last.building ? ' · 构建中' : ''}`
    : '—'
  const lastMeta = last
    ? `${timeAgo(last.timestamp)}${last.duration ? ` · 耗时 ${formatDuration(last.duration)}` : ''}`
    : ''

  const cards = el('div', { class: 'cards' }, [
    el('div', { class: 'card' }, [
      el('span', { class: 'label', text: '当前状态' }),
      el('span', { class: 'value' }, [dot(job.status), ` ${statusLabel(job.status)}`]),
    ]),
    el('div', { class: 'card' }, [
      el('span', { class: 'label', text: '最近构建' }),
      el('span', { class: 'value', text: lastValue }),
      el('span', { class: 'muted', text: lastMeta }),
    ]),
    el('div', { class: 'card' }, [
      el('span', { class: 'label', text: '下次构建号' }),
      el('span', { class: 'value', text: job.nextBuildNumber ? `#${job.nextBuildNumber}` : '—' }),
    ]),
  ])

  const nodes = [cards]
  if (job.parameters?.length) {
    nodes.push(
      el('form', { id: 'build-form', class: 'params' }, [
        el('h2', { text: '构建参数' }),
        ...job.parameters.map(parameterNode),
      ]),
    )
  } else {
    nodes.push(el('p', { class: 'muted', text: '该 job 没有构建参数。' }))
  }

  const result = el('div', { id: 'build-result', class: 'result muted' })
  nodes.push(
    el('div', { class: 'actions' }, [
      el('button', {
        id: 'do-build',
        type: 'button',
        text: '开始构建',
        onclick: () => {
          void triggerBuild()
        },
      }),
      el('button', {
        id: 'do-stop',
        class: 'ghost danger',
        type: 'button',
        text: '中止最近构建',
        disabled: !last,
        onclick: () => {
          void stopBuild()
        },
      }),
      el('button', {
        id: 'do-log',
        class: 'ghost',
        type: 'button',
        text: '控制台日志',
        disabled: !last,
        onclick: () => {
          void showLog(last?.number)
        },
      }),
      el('button', {
        id: 'do-artifacts',
        class: 'ghost',
        type: 'button',
        text: '产物',
        disabled: !last,
        onclick: () => {
          void showArtifacts(last?.number)
        },
      }),
    ]),
  )
  nodes.push(result)
  clear(byId('job-body'), ...nodes)
}

function collectParameters() {
  const job = state.job
  const parameters = {}
  const form = byId('build-form')
  if (!form || !job?.parameters?.length) return parameters
  for (const definition of job.parameters) {
    const field = form.elements.namedItem(definition.name)
    if (!field) continue
    parameters[definition.name] =
      definition.type === 'BooleanParameterDefinition' ? Boolean(field.checked) : field.value
  }
  return parameters
}

async function triggerBuild() {
  const button = byId('do-build')
  const output = byId('build-result')
  button.disabled = true
  output.textContent = '正在触发构建…'
  try {
    const result = await rpc('POST', '/build', {
      job: state.job.name,
      parameters: collectParameters(),
      wait: true,
    })
    output.textContent = result.buildNumber
      ? `已进入队列 #${result.queueId ?? '?'}，构建号 #${result.buildNumber}`
      : `已进入队列 #${result.queueId ?? '?'}（等待执行）`
    toast('构建已触发', 'ok')
    await selectJob(state.job.name)
  } catch (error) {
    output.textContent = `触发失败：${error.message}`
    toast(error.message, 'bad')
  } finally {
    button.disabled = false
  }
}

async function stopBuild() {
  const last = state.job?.lastBuild
  if (!last) return
  try {
    await rpc('POST', '/build/stop', { job: state.job.name, number: last.number })
    toast(`已请求中止 #${last.number}`, 'ok')
    await selectJob(state.job.name)
  } catch (error) {
    toast(error.message, 'bad')
  }
}

async function showLog(number) {
  const dialog = byId('log-dialog')
  byId('log-title').textContent = `${state.job.name} · #${number} 控制台输出`
  byId('log-body').textContent = '加载中…'
  byId('log-hint').textContent = ''
  dialog.showModal()
  try {
    const data = await rpc(
      'GET',
      `/log?job=${encodeURIComponent(state.job.name)}&number=${encodeURIComponent(number)}&tail=500`,
    )
    byId('log-body').textContent = data.text || '(没有输出)'
    byId('log-body').scrollTop = byId('log-body').scrollHeight
    byId('log-hint').textContent = data.truncated
      ? `已显示最后 500 行（共 ${data.totalLines} 行）`
      : `共 ${data.totalLines} 行`
  } catch (error) {
    byId('log-body').textContent = error.message
  }
}

async function showArtifacts(number) {
  const dialog = byId('log-dialog')
  const container = byId('log-body')
  byId('log-title').textContent = `${state.job.name} · #${number} 产物`
  byId('log-hint').textContent = ''
  container.textContent = '加载中…'
  dialog.showModal()
  try {
    const data = await rpc(
      'GET',
      `/artifacts?job=${encodeURIComponent(state.job.name)}&number=${encodeURIComponent(number)}`,
    )
    if (!data.artifacts?.length) {
      container.textContent = '这次构建没有产物。'
      return
    }
    const base = state.status?.baseUrl || ''
    clear(
      container,
      ...data.artifacts.map((artifact) => {
        const href = `${base}${artifact.downloadPath}`
        return el('div', { class: 'artifact' }, [
          el('span', {
            class: 'artifact-name',
            text: artifact.displayPath || artifact.fileName,
          }),
          el('button', {
            class: 'ghost',
            type: 'button',
            text: '复制链接',
            onclick: () => {
              navigator.clipboard
                ?.writeText(href)
                .then(() => toast('链接已复制', 'ok'))
                .catch(() => toast('复制失败，请手动复制', 'bad'))
            },
          }),
        ])
      }),
    )
  } catch (error) {
    container.textContent = error.message
  }
}

async function showQueue() {
  const dialog = byId('queue-dialog')
  const container = byId('queue-body')
  container.textContent = '加载中…'
  dialog.showModal()
  try {
    const data = await rpc('GET', '/queue')
    if (!data.items?.length) {
      container.textContent = '队列为空。'
      return
    }
    clear(
      container,
      ...data.items.map((item) =>
        el('div', { class: 'queue-item' }, [
          el('div', {}, [
            el('strong', { text: item.job || `队列项 ${item.id}` }),
            el('div', {
              class: 'muted',
              text: `${item.why || '等待执行'}${item.stuck ? ' · 卡住' : ''}`,
            }),
          ]),
          el('button', {
            class: 'ghost danger',
            type: 'button',
            text: '取消',
            disabled: item.cancelable === false,
            onclick: async () => {
              try {
                await rpc('POST', '/queue/cancel', { id: item.id })
                toast('已取消', 'ok')
                await showQueue()
              } catch (error) {
                toast(error.message, 'bad')
              }
            },
          }),
        ]),
      ),
    )
  } catch (error) {
    container.textContent = error.message
  }
}

function openSettings() {
  const status = state.status || {}
  byId('set-base-url').value = status.baseUrl || ''
  byId('set-username').value = status.username || ''
  byId('set-password').value = ''
  byId('set-verify-tls').checked = status.verifyTls !== false
  byId('set-filter').value = (status.jobFilter || []).join(', ')
  byId('set-views').value = (status.views || []).join(', ')
  byId('settings-hint').textContent = status.hasPassword
    ? '已保存密码，留空表示不修改。插件会用账号密码走表单登录换会话。'
    : '还没有保存密码。填写 Jenkins 登录账号与密码，插件会自己登录。'
  byId('settings-dialog').showModal()
}

async function saveSettings() {
  const hint = byId('settings-hint')
  hint.textContent = '保存中…'
  try {
    await rpc('POST', '/settings', {
      baseUrl: byId('set-base-url').value.trim(),
      username: byId('set-username').value.trim(),
      verifyTls: byId('set-verify-tls').checked,
      jobFilter: byId('set-filter').value,
      views: byId('set-views').value,
    })
    const password = byId('set-password').value.trim()
    if (password) await rpc('POST', '/password', { password })
    byId('settings-dialog').close()
    toast('设置已保存', 'ok')
    await load()
    if (state.selected) await selectJob(state.selected)
    await credentialsWidget?.refresh()
  } catch (error) {
    hint.textContent = error.message
    toast(error.message, 'bad')
  }
}

async function clearPassword() {
  try {
    await rpc('POST', '/password/clear')
    byId('set-password').value = ''
    byId('settings-hint').textContent = '密码已清除。'
    await loadStatus()
    await credentialsWidget?.refresh()
  } catch (error) {
    toast(error.message, 'bad')
  }
}

function stopPolling() {
  if (state.pollTimer) clearTimeout(state.pollTimer)
  state.pollTimer = null
}

function schedulePollIfBuilding() {
  stopPolling()
  if (!state.job?.lastBuild?.building) return
  state.pollTimer = setTimeout(async () => {
    if (!state.selected) return
    try {
      state.job = await rpc('GET', `/job?name=${encodeURIComponent(state.selected)}`)
      renderJob()
    } catch {
      // 轮询失败不打断界面。
    }
    schedulePollIfBuilding()
  }, 4000)
}

function bindStatic() {
  byId('search').addEventListener('input', (event) => {
    state.filter = event.target.value
    renderJobs()
  })
  byId('refresh-jobs').addEventListener('click', () => {
    void load()
  })
  byId('show-settings').addEventListener('click', openSettings)
  byId('show-queue').addEventListener('click', () => {
    void showQueue()
  })
  byId('save-settings').addEventListener('click', () => {
    void saveSettings()
  })
  byId('clear-password').addEventListener('click', () => {
    void clearPassword()
  })
  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => {
      button.closest('dialog')?.close()
    })
  }
}

bindStatic()

let credentialsWidget = null
function mountCredentials() {
  const root = byId('credentials')
  if (!root || !window.TrellisCredentialsWidget) return
  credentialsWidget = window.TrellisCredentialsWidget.mount({
    root,
    request: rpc,
    systemId: 'jenkins',
  })
}

mountCredentials()
window.parent.postMessage({ type: 'trellis:ready' }, '*')
