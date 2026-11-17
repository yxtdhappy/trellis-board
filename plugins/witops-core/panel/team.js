/**
 * team 面板：登录 → 选项目 → 看任务。
 *
 * 只做读，不做写；所有文案按 design.md §12，不出现"会话/token/凭据"这类词。
 * 与宿主通信走 postMessage 桥：iframe 没有 same-origin，不能直接 fetch。
 */
const state = {
  auth: null,
  projects: [],
  projectId: '',
  page: 1,
  size: 20,
  total: 0,
  loading: false,
  error: '',
}

const pending = new Map()
let sequence = 0

function byId(id) {
  return document.getElementById(id)
}

const projectInputNode = byId('project-input')
const projectList = byId('project-list')

function rpc(method, path, body) {
  const id = `t${++sequence}`
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    window.parent.postMessage({ type: 'trellis:request', id, method, path, body }, '*')
  })
}

window.addEventListener('message', (event) => {
  const message = event.data
  if (!message || typeof message !== 'object') return
  if (message.type === 'trellis:init') {
    document.documentElement.dataset.theme = message.theme || 'light'
    void boot()
    return
  }
  if (message.type !== 'trellis:response') return
  const entry = pending.get(message.id)
  if (!entry) return
  pending.delete(message.id)
  if (message.ok) {
    entry.resolve(message.data)
    return
  }
  const error = new Error(message.data?.error || '请求失败')
  error.code = message.data?.code ?? null
  error.status = message.status ?? null
  entry.reject(error)
})

function setBanner(text) {
  const node = byId('banner')
  node.hidden = !text
  node.textContent = text || ''
}

function renderAuth() {
  const auth = state.auth
  const online = auth?.online === true
  byId('auth-chip').textContent = online ? `${auth.account} · 已登录` : '未登录'
  byId('auth-chip').dataset.state = online ? 'authenticated' : 'anonymous'
  byId('login').hidden = online
  byId('logout').hidden = !online
  byId('workspace').hidden = !online
  if (!online) byId('meta').textContent = '先登录 WitOps 账号，再查看项目任务。'
}

// 项目选择器：可输入搜索的 combobox。列表里的顺序严格跟随 state.projects。
const projectCombo = { open: false, active: -1, options: [] }

function selectedProject() {
  return state.projects.find((project) => project.id === state.projectId) ?? null
}

function syncProjectInput() {
  projectInputNode.value = selectedProject()?.name ?? ''
  projectInputNode.disabled = state.projects.length === 0
  projectInputNode.placeholder = state.projects.length
    ? '搜索项目'
    : '你在 WitOps 里还没有可查看的项目'
}

function matchProjects(query) {
  const needle = query.trim().toLowerCase()
  if (!needle) return state.projects
  return state.projects.filter((project) =>
    [project.name, project.code, project.id]
      .map((value) => String(value ?? '').toLowerCase())
      .some((value) => value.includes(needle)),
  )
}

function markActiveOption() {
  for (const item of projectList.querySelectorAll('.combo-option')) {
    const active = Number(item.dataset.index) === projectCombo.active
    item.dataset.active = String(active)
    if (active) item.scrollIntoView({ block: 'nearest' })
  }
  const activeId = projectCombo.active >= 0 ? `project-option-${projectCombo.active}` : ''
  if (activeId) projectInputNode.setAttribute('aria-activedescendant', activeId)
  else projectInputNode.removeAttribute('aria-activedescendant')
}

function renderProjects(query = '') {
  projectCombo.options = matchProjects(query)
  projectList.replaceChildren()
  if (!projectCombo.options.length) {
    projectCombo.active = -1
    const hint = document.createElement('li')
    hint.className = 'combo-empty'
    hint.textContent = '没有匹配的项目'
    projectList.append(hint)
    markActiveOption()
    return
  }
  projectCombo.active = Math.min(Math.max(projectCombo.active, 0), projectCombo.options.length - 1)
  projectCombo.options.forEach((project, index) => {
    const item = document.createElement('li')
    item.id = `project-option-${index}`
    item.className = 'combo-option'
    item.dataset.id = project.id
    item.dataset.index = String(index)
    item.setAttribute('role', 'option')
    item.setAttribute('aria-selected', String(project.id === state.projectId))
    const name = document.createElement('span')
    name.textContent = project.name || project.id
    item.append(name)
    if (project.code) {
      const meta = document.createElement('span')
      meta.className = 'meta'
      meta.textContent = project.code
      item.append(meta)
    }
    projectList.append(item)
  })
  markActiveOption()
}

function openProjects() {
  if (!state.projects.length) return
  if (!projectCombo.open) {
    projectCombo.open = true
    projectList.hidden = false
    projectInputNode.setAttribute('aria-expanded', 'true')
    const index = state.projects.findIndex((project) => project.id === state.projectId)
    projectCombo.active = Math.max(index, 0)
    renderProjects('')
    projectInputNode.select()
  }
}

function closeProjects({ restore = true } = {}) {
  if (!projectCombo.open) return
  projectCombo.open = false
  projectList.hidden = true
  projectList.replaceChildren()
  projectCombo.options = []
  projectCombo.active = -1
  projectInputNode.setAttribute('aria-expanded', 'false')
  projectInputNode.removeAttribute('aria-activedescendant')
  if (restore) syncProjectInput()
}

async function chooseProject(id) {
  const project = state.projects.find((item) => item.id === id)
  if (!project) return
  const changed = project.id !== state.projectId
  state.projectId = project.id
  if (changed) state.page = 1
  closeProjects({ restore: true })
  if (!changed) return
  try {
    await loadTasks()
  } catch (error) {
    setBanner(error.message || '加载任务失败')
  }
}

function cell(text, className) {
  const node = document.createElement('td')
  if (className) node.className = className
  node.textContent = text ?? ''
  return node
}

function renderRows(items) {
  const tbody = byId('rows')
  tbody.replaceChildren()
  for (const item of items) {
    const row = document.createElement('tr')
    row.append(
      cell(item.code || item.id, 'code'),
      cell(item.name || ''),
      cell(item.statusLabel || '—'),
      cell(item.priority || '—'),
      cell(item.assignee || '—'),
      cell(item.dueDate || '—'),
    )
    tbody.append(row)
  }
  byId('empty').hidden = items.length > 0
  const pages = Math.max(1, Math.ceil(state.total / state.size))
  byId('page-label').textContent = `第 ${state.page} / ${pages} 页 · 共 ${state.total} 条`
  byId('prev').disabled = state.page <= 1
  byId('next').disabled = state.page >= pages
}

function renderMeta(text) {
  byId('meta').textContent = text
}

function forgetSession() {
  state.auth = { online: false, account: null }
  state.projects = []
  state.projectId = ''
  closeProjects({ restore: false })
  renderAuth()
  syncProjectInput()
}

async function loadSession() {
  const data = await rpc('GET', '/session')
  state.auth = { online: data?.online === true, account: data?.account ?? null }
  renderAuth()
  return state.auth
}

// 项目名可能是中文，用 collator 排出来才是"字母序"而不是 UTF-16 码点序。
const projectNameCollator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

function byProjectName(left, right) {
  const a = String(left?.name ?? '').trim()
  const b = String(right?.name ?? '').trim()
  if (!a) return b ? 1 : 0
  if (!b) return -1
  return projectNameCollator.compare(a, b)
}

async function loadProjects() {
  const data = await rpc('GET', '/app/project-space')
  const managed = (data?.managed ?? []).map((project) => ({ ...project, mine: 'manager' }))
  const joined = (data?.joined ?? []).map((project) => ({ ...project, mine: 'participant' }))
  // 同一个项目可能既"我管理的"又"我参与的"，按 id 去重，保留管理身份。
  const merged = new Map()
  for (const project of managed) merged.set(project.id, project)
  for (const project of joined) {
    if (!merged.has(project.id)) merged.set(project.id, project)
  }
  state.projects = [...merged.values()].sort(byProjectName)
  state.projectId = state.projectId || state.projects[0]?.id || ''
  syncProjectInput()
  if (projectCombo.open) renderProjects(projectInputNode.value)
  if (!state.projects.length) renderMeta('你在 WitOps 里还没有可查看的项目')
}

async function loadTasks() {
  if (!state.projectId) {
    renderRows([])
    return
  }
  const query = new URLSearchParams({
    projectId: state.projectId,
    page: String(state.page),
    size: String(state.size),
  })
  const data = await rpc('GET', `/app/project-tasks?${query.toString()}`)
  state.total = Number(data?.total ?? 0)
  renderRows(Array.isArray(data?.items) ? data.items : [])
  renderMeta(
    `${state.projects.find((p) => p.id === state.projectId)?.name ?? ''} · 共 ${state.total} 条任务`,
  )
}

async function refresh() {
  if (state.loading) return
  state.loading = true
  setBanner('')
  try {
    await loadSession()
    if (state.auth.online) {
      await loadProjects()
      await loadTasks()
    }
  } catch (error) {
    if (error.code === 'CONNECTION_LOST') {
      // 令牌已被平台吊销：清掉宿主里的登记，直接让用户重新输入密码。
      await rpc('DELETE', '/session').catch(() => {})
      forgetSession()
      setBanner('你和 WitOps 的连接已断开，需要重新输入密码')
    } else if (error.code === 'CREDENTIALS_MISSING') {
      forgetSession()
    } else {
      setBanner(error.message || '加载失败')
    }
  } finally {
    state.loading = false
  }
}

async function boot() {
  try {
    await refresh()
  } catch (error) {
    setBanner(error.message || '加载失败')
  }
}

byId('login').addEventListener('submit', async (event) => {
  event.preventDefault()
  const account = byId('account').value.trim()
  const password = byId('password').value
  if (!account || !password) return
  const submit = byId('login-submit')
  submit.disabled = true
  setBanner('')
  try {
    await rpc('POST', '/session', { account, password })
    byId('password').value = ''
    await refresh()
  } catch (error) {
    if (error.code === 'ACCOUNT_IN_USE') setBanner(error.message)
    else if (error.code === 'LOGIN_TOO_FREQUENT') setBanner('登录尝试太频繁，请稍后再试')
    else if (error.code === 'AUTH_FAILED') setBanner('WitOps 账号或密码不对，请重新输入')
    else setBanner(error.message || '登录失败')
  } finally {
    submit.disabled = false
  }
})

byId('logout').addEventListener('click', async () => {
  try {
    await rpc('DELETE', '/session')
  } catch {
    // 退出失败也要让用户看到已退出的状态：下次请求会再校验。
  }
  forgetSession()
  setBanner('已退出，下次查看任务需要重新登录。')
})

projectInputNode.addEventListener('focus', () => openProjects())
// focus 只会触发一次；Esc 或点空白关掉列表后再点输入框，需要重新打开。
projectInputNode.addEventListener('click', () => openProjects())
projectInputNode.addEventListener('input', () => {
  if (!projectCombo.open) openProjects()
  projectCombo.active = 0
  renderProjects(projectInputNode.value)
})
projectInputNode.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    if (!projectCombo.open) {
      openProjects()
      return
    }
    const count = projectCombo.options.length
    if (!count) return
    const step = event.key === 'ArrowDown' ? 1 : -1
    projectCombo.active = (projectCombo.active + step + count) % count
    markActiveOption()
    return
  }
  if (event.key === 'Enter') {
    const project = projectCombo.options[projectCombo.active]
    if (projectCombo.open && project) {
      event.preventDefault()
      void chooseProject(project.id)
    }
    return
  }
  if (event.key === 'Escape') {
    if (projectCombo.open) {
      event.preventDefault()
      closeProjects()
    }
    return
  }
  if (event.key === 'Tab') closeProjects()
})

// mousedown 命中列表时阻止默认行为，否则 input 先失焦、列表先关，click 打空。
projectList.addEventListener('mousedown', (event) => event.preventDefault())
projectList.addEventListener('click', (event) => {
  const item = event.target.closest('.combo-option')
  if (item?.dataset.id) void chooseProject(item.dataset.id)
})

document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('#project-combo')) closeProjects()
})

byId('reload').addEventListener('click', () => void refresh())

byId('prev').addEventListener('click', () => {
  if (state.page <= 1) return
  state.page -= 1
  void loadTasks().catch((error) => setBanner(error.message))
})

byId('next').addEventListener('click', () => {
  state.page += 1
  void loadTasks().catch((error) => setBanner(error.message))
})
