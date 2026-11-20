/**
 * team 面板：登录 → 选项目（可多选）→ 按需求分组的任务表。
 *
 * 只做读，不做写。所有文案按 design.md §12，不出现"会话/token/凭据"这类词。
 * 与宿主通信走 postMessage 桥：iframe 没有 same-origin，不能直接 fetch，
 * 也用不了 localStorage（sandbox 无 allow-same-origin，访问会抛 SecurityError），
 * 所以"上次查询的项目/筛选条件"落服务端 /app/prefs（team 下按用户分区）。
 */
const bridge = TrellisBridge.create()

const STATUS_OPTIONS = [
  { value: '1', label: '待处理' },
  { value: '3', label: '进行中' },
  { value: '97', label: '待提交' },
  { value: '2', label: '已完成' },
  { value: '99', label: '已关闭' },
  { value: '4', label: '已取消' },
  { value: '0', label: '草稿' },
]

const PRIORITY_OPTIONS = [
  { value: '1', label: 'P0' },
  { value: '2', label: 'P1' },
  { value: '3', label: 'P2' },
  { value: '4', label: 'P3' },
]

const CHILD_CONCURRENCY = 3

const state = {
  auth: null,
  projects: [],
  selected: new Set(),
  projectQuery: '',
  prefs: {},
  filters: {
    code: '',
    name: '',
    status: [],
    priority: [],
    assignee: [],
    iteration: '',
    createFrom: '',
    createTo: '',
  },
  users: [],
  usersLoaded: false,
  iterations: [],
  page: 1,
  size: 50,
  total: 0,
  items: [],
  groups: [],
  expanded: new Set(),
  childLoaded: new Set(),
  childLoading: new Set(),
  childQueue: [],
  activeChildren: 0,
  loading: false,
  loaded: false,
  error: '',
  hasStoredProjects: false,
  projectQuery: '',
}

function byId(id) {
  return document.getElementById(id)
}

// 统一走宿主桥（/plugin-ui/v1/bridge.js）：iframe 没有 same-origin，不能直接 fetch。
async function rpc(method, path, body) {
  const verb = String(method).toUpperCase()
  try {
    if (verb === 'DELETE') return await bridge.delete(path, body)
    if (verb === 'POST') return await bridge.post(path, body)
    if (verb === 'PUT') return await bridge.put(path, body)
    return await bridge.get(path)
  } catch (error) {
    // 宿主把 { error, code } 放在 error.data 里，面板按 code 决定下一步。
    error.code = error.code ?? error.data?.code ?? null
    throw error
  }
}

bridge.ready.then(() => boot()).catch((error) => setBanner(error.message || '加载失败'))

function setBanner(text) {
  const node = byId('banner')
  node.hidden = !text
  node.textContent = text || ''
}

function renderAuth() {
  const auth = state.auth
  const online = auth?.online === true
  byId('auth-chip').textContent = online ? `${auth.account} · 已登录` : '未登录'
  byId('auth-chip').className = online ? 'tb-chip tb-chip-ok' : 'tb-chip'
  byId('login').hidden = online
  byId('logout').hidden = !online
  byId('workspace').hidden = !online
  if (!online) byId('meta').textContent = '先登录 WitOps 账号，再查看项目任务。'
}

// ---------------------------------------------------------------- 项目多选

function selectedProjects() {
  return state.projects.filter((project) => state.selected.has(project.id))
}

/**
 * 实际参与查询的项目 id。
 * 没勾选任何项目时按"全部项目"查（上限 20 个），避免空选择退化成 400。
 */
function effectiveProjectIds() {
  const ids = state.selected.size
    ? [...state.selected]
    : state.projects.map((project) => project.id)
  return ids.slice(0, 20)
}

function syncProjectInput() {
  // 项目多选与状态/优先级/负责人共用 details+checkbox 组件，样式和交互保持一致。
  const search = byId('project-search')
  if (search) search.disabled = state.projects.length === 0
  syncProjectSummary()
  renderProjectOptions(state.projectQuery)
}

function syncProjectSummary() {
  const counter = byId('project-count')
  const box = byId('ms-projects')
  const labels = selectedProjects().map((project) => project.name || project.id)
  if (!labels.length) {
    counter.textContent = state.projects.length ? `全部（${state.projects.length} 个）` : '没有项目'
    counter.title = ''
    box.dataset.active = 'false'
    return
  }
  counter.textContent =
    labels.length <= 2 ? labels.join('、') : `${labels[0]} 等 ${labels.length} 个`
  counter.title = labels.join('、')
  box.dataset.active = 'true'
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

function renderProjectOptions(query = '') {
  const box = byId('project-options')
  if (!box) return
  box.replaceChildren()
  if (!state.projects.length) {
    const empty = document.createElement('p')
    empty.className = 'ms-empty'
    empty.textContent = '你在 WitOps 里还没有可查看的项目'
    box.append(empty)
    return
  }
  const options = matchProjects(query)
  if (!options.length) {
    const empty = document.createElement('p')
    empty.className = 'ms-empty'
    empty.textContent = '没有匹配的项目'
    box.append(empty)
    return
  }
  for (const project of options) {
    const label = document.createElement('label')
    label.className = 'ms-option'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.value = project.id
    input.checked = state.selected.has(project.id)
    input.addEventListener('change', () => {
      if (input.checked) state.selected.add(project.id)
      else state.selected.delete(project.id)
      syncProjectSummary()
      onQueryChanged({ iterations: true })
    })
    const name = document.createElement('span')
    name.className = 'ms-option-name'
    name.textContent = project.name || project.id
    name.title = project.code ? `${project.name} · ${project.code}` : project.name || ''
    label.append(input, name)
    if (project.code) {
      const meta = document.createElement('span')
      meta.className = 'ms-option-meta'
      meta.textContent = project.code
      label.append(meta)
    }
    box.append(label)
  }
}

function toggleProject(id) {
  if (state.selected.has(id)) state.selected.delete(id)
  else state.selected.add(id)
  syncProjectSummary()
  renderProjectOptions(state.projectQuery)
  onQueryChanged({ iterations: true })
}

function clearProjects() {
  state.selected.clear()
  syncProjectSummary()
  renderProjectOptions(state.projectQuery)
  onQueryChanged({ iterations: true })
}

// ---------------------------------------------------------------- 筛选控件

function mountMultiSelect(id, options, key) {
  const box = byId(id)
  if (!box) return
  const panel = box.querySelector('.ms-panel')
  panel.replaceChildren()
  for (const option of options()) {
    const label = document.createElement('label')
    label.className = 'ms-option'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.value = option.value
    input.checked = state.filters[key].includes(option.value)
    input.addEventListener('change', () => {
      const current = new Set(state.filters[key])
      if (input.checked) current.add(option.value)
      else current.delete(option.value)
      state.filters[key] = [...current]
      syncMultiSummary(id, key, options)
      onQueryChanged()
    })
    const text = document.createElement('span')
    text.textContent = option.label
    label.append(input, text)
    panel.append(label)
  }
  syncMultiSummary(id, key, options)
}

function syncMultiSummary(id, key, options) {
  const box = byId(id)
  const counter = box.querySelector('.ms-count')
  const chosen = state.filters[key]
  if (!chosen.length) {
    counter.textContent = '全部'
    box.dataset.active = 'false'
    return
  }
  const labels = options()
    .filter((option) => chosen.includes(option.value))
    .map((option) => option.label)
  counter.textContent =
    labels.length <= 2 ? labels.join('、') : `${labels[0]} 等 ${labels.length} 项`
  box.dataset.active = 'true'
}

function syncDateInputs() {
  byId('filter-create-from').value = state.filters.createFrom
  byId('filter-create-to').value = state.filters.createTo
}

function renderIterations() {
  const select = byId('filter-iteration')
  select.replaceChildren()
  const all = document.createElement('option')
  all.value = ''
  all.textContent = '全部迭代'
  select.append(all)
  for (const iteration of state.iterations) {
    const option = document.createElement('option')
    option.value = iteration.id
    option.textContent = iteration.name
    select.append(option)
  }
  select.value = state.filters.iteration || ''
}

function assigneeOptions() {
  if (state.users.length) return state.users.map((user) => ({ value: user.id, label: user.name }))
  // 拿不到用户清单时退回"本页出现过的人"，至少能筛掉一半。
  const seen = new Map()
  for (const item of state.items) {
    if (item.assigneeId && item.assignee) seen.set(item.assigneeId, item.assignee)
  }
  return [...seen.entries()].map(([value, label]) => ({ value, label }))
}

// ---------------------------------------------------------------- 数据加载

function queryParams() {
  const params = new URLSearchParams({ page: String(state.page), size: String(state.size) })
  const ids = effectiveProjectIds()
  if (ids.length) params.set('projectIds', ids.join(','))
  const { filters } = state
  if (filters.code) params.set('code', filters.code)
  if (filters.name) params.set('name', filters.name)
  if (filters.status.length) params.set('status', filters.status.join(','))
  if (filters.priority.length) params.set('priority', filters.priority.join(','))
  if (filters.assignee.length) params.set('assignee', filters.assignee.join(','))
  if (filters.iteration) params.set('iteration', filters.iteration)
  // 平台 createTime 是 "YYYY-MM-DD HH:mm:ss,YYYY-MM-DD HH:mm:ss"，只看日期就用满开区间。
  if (filters.createFrom || filters.createTo) {
    const from = filters.createFrom ? `${filters.createFrom} 00:00:00` : '2000-01-01 00:00:00'
    const to = filters.createTo ? `${filters.createTo} 23:59:59` : '2099-12-31 23:59:59'
    params.set('createTime', `${from},${to}`)
  }
  return params.toString()
}

let loadToken = 0

/** 列表加载态：细条 + 转圈；同时把刷新按钮禁掉，避免连点叠加请求。 */
function setLoading(active, text = '正在加载任务…') {
  const bar = byId('loading')
  if (bar) {
    bar.hidden = !active
    const label = bar.querySelector('.loading-text')
    if (label) label.textContent = text
  }
  byId('team-table')?.setAttribute('aria-busy', String(active))
  const reload = byId('reload')
  if (reload) reload.disabled = active
}

async function loadTasks() {
  if (!state.projects.length) {
    state.items = []
    state.groups = []
    renderRows()
    renderMeta('你在 WitOps 里还没有可查看的项目')
    return
  }
  state.loading = true
  const token = ++loadToken
  setBanner('')
  setLoading(true)
  const projects = selectedProjects()
  byId('meta').textContent = projects.length
    ? `正在读取 ${projects.map((project) => project.name).join('、')} 的任务…`
    : '正在读取全部项目的任务…'
  try {
    const data = await rpc('GET', `/app/project-tasks?${queryParams()}`)
    if (token !== loadToken) return
    state.total = Number(data?.total ?? 0)
    state.items = Array.isArray(data?.items) ? data.items : []
    state.groups = Array.isArray(data?.groups) ? data.groups : []
    renderRows()
    renderProjectColumn()
    renderMeta()
    state.loaded = true
  } catch (error) {
    if (token !== loadToken) return
    if (error.code === 'CREDENTIALS_MISSING' || error.code === 'CONNECTION_LOST') {
      await handleSessionLost(error.code)
      return
    }
    setBanner(error.message || '加载任务失败')
    byId('meta').textContent = '加载失败'
  } finally {
    state.loading = false
    if (token === loadToken) setLoading(false)
  }
}

async function loadUsers() {
  if (state.usersLoaded) return
  state.usersLoaded = true
  try {
    const data = await rpc('GET', '/app/users')
    state.users = Array.isArray(data?.items) ? data.items : []
  } catch {
    state.users = []
  }
  mountMultiSelect('ms-assignee', assigneeOptions, 'assignee')
}

async function loadIterations() {
  const projectId = [...state.selected][0] || ''
  try {
    const data = await rpc('GET', `/app/iterations?projectId=${encodeURIComponent(projectId)}`)
    state.iterations = Array.isArray(data?.items) ? data.items : []
  } catch {
    state.iterations = []
  }
  if (!state.iterations.some((item) => item.id === state.filters.iteration)) {
    state.filters.iteration = ''
  }
  renderIterations()
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
  // 恢复上次的选择：只保留这次仍然有权限的项目。
  const available = new Set(state.projects.map((project) => project.id))
  state.selected = new Set([...state.selected].filter((id) => available.has(id)))
  // 首次使用（从没存过项目选择）默认选第一个：不选会一次查 20 个项目，慢且没必要。
  if (!state.hasStoredProjects && !state.selected.size && state.projects.length) {
    state.selected.add(state.projects[0].id)
    schedulePrefsSave()
  }
  syncProjectInput()
  if (!state.projects.length) renderMeta('你在 WitOps 里还没有可查看的项目')
}

// ---------------------------------------------------------------- 偏好读写

let prefsTimer = null

function schedulePrefsSave() {
  clearTimeout(prefsTimer)
  prefsTimer = setTimeout(() => void savePrefs(), 600)
}

async function savePrefs() {
  try {
    const data = await rpc('PUT', '/app/prefs', {
      projectIds: [...state.selected],
      filters: state.filters,
      pageSize: state.size,
    })
    if (data?.prefs) state.prefs = data.prefs
  } catch {
    // 偏好存不下不影响看任务，静默忽略。
  }
}

// 偏好可能来自旧版本或被手改过：认值也认标签，认不出的直接丢掉，避免界面出现"已选中却没人勾上"。
function toOptionValues(values, options) {
  const picked = []
  for (const raw of values) {
    const value = String(raw).trim()
    if (!value) continue
    const hit =
      options.find((option) => option.value === value) ??
      options.find((option) => option.label.toLowerCase() === value.toLowerCase())
    if (hit && !picked.includes(hit.value)) picked.push(hit.value)
  }
  return picked
}

function applyPrefs(prefs = {}) {
  if (Array.isArray(prefs.projectIds)) {
    // 存过（哪怕是空数组＝用户主动选了"全部项目"）就不再用默认值覆盖。
    state.hasStoredProjects = true
    state.selected = new Set(prefs.projectIds.map((id) => String(id)))
  }
  const filters = prefs.filters
  if (filters && typeof filters === 'object') {
    const list = (value) =>
      Array.isArray(value)
        ? value.map((part) => String(part))
        : String(value ?? '')
            .split(',')
            .filter(Boolean)
    if (filters.code) state.filters.code = String(filters.code)
    if (filters.name) state.filters.name = String(filters.name)
    if (filters.status) state.filters.status = toOptionValues(list(filters.status), STATUS_OPTIONS)
    if (filters.priority) {
      state.filters.priority = toOptionValues(list(filters.priority), PRIORITY_OPTIONS)
    }
    if (filters.assignee) state.filters.assignee = list(filters.assignee)
    if (filters.iteration) state.filters.iteration = String(filters.iteration)
    if (filters.createFrom) state.filters.createFrom = String(filters.createFrom)
    if (filters.createTo) state.filters.createTo = String(filters.createTo)
  }
  const size = Number(prefs.pageSize)
  if (Number.isFinite(size) && size >= 10) state.size = Math.min(200, size)
  byId('filter-code').value = state.filters.code
  byId('filter-name').value = state.filters.name
  syncDateInputs()
}

async function loadPrefs() {
  try {
    const data = await rpc('GET', '/app/prefs')
    state.prefs = data?.prefs ?? {}
  } catch {
    state.prefs = {}
  }
  applyPrefs(state.prefs)
}

// ---------------------------------------------------------------- 渲染

const STATUS_WEIGHT = { 3: 0, 1: 1, 97: 2, 2: 3, 99: 4, 4: 5, 0: 6 }
const CHILD_TYPE_WEIGHT = { 3: 0, 4: 1, 2: 2, 0: 3, 1: 4 }

function sortChildren(items) {
  return [...items].sort(
    (left, right) =>
      (CHILD_TYPE_WEIGHT[left.type] ?? 9) - (CHILD_TYPE_WEIGHT[right.type] ?? 9) ||
      (STATUS_WEIGHT[left.statusCode] ?? 9) - (STATUS_WEIGHT[right.statusCode] ?? 9) ||
      (left.priorityCode ?? 9) - (right.priorityCode ?? 9) ||
      String(left.code || left.id).localeCompare(String(right.code || right.id), 'zh-Hans-CN', {
        numeric: true,
      }),
  )
}

function renderProjectColumn() {
  const table = byId('team-table')
  table.classList.toggle('no-project', effectiveProjectIds().length <= 1)
}

function projectNameOf(item) {
  const project = state.projects.find((entry) => entry.id === item.projectId)
  return project ? project.name : ''
}

function priorityTone(label) {
  return label ? `pill-${label.toLowerCase()}` : 'pill-muted'
}

function statusTone(item) {
  const code = Number(item.statusCode)
  if (code === 3) return 'pill-running'
  if (code === 2) return 'pill-done'
  if (code === 1 || code === 97) return 'pill-todo'
  if (code === 4 || code === 99) return 'pill-cancel'
  return 'pill-muted'
}

function cell(className, ...children) {
  const node = document.createElement('td')
  if (className) node.className = className
  node.append(...children)
  return node
}

function pill(text, tone) {
  const node = document.createElement('span')
  node.className = `pill ${tone}`
  node.textContent = text || '—'
  return node
}

function muted(text) {
  const node = document.createElement('span')
  node.className = 'cell-muted'
  node.textContent = text || '—'
  return node
}

const CHILD_INDENT = 14

function childRows(group) {
  const fragment = document.createDocumentFragment()
  for (const item of group.children) {
    fragment.append(buildChildRow(item, group))
  }
  if (!group.children.length) {
    const row = document.createElement('tr')
    row.className = 'child-row child-row-empty'
    row.dataset.parent = group.key
    const td = document.createElement('td')
    td.colSpan = 8
    td.className = 'cell-muted'
    td.textContent = state.childLoading.has(group.requirement?.id)
      ? '正在读取子项…'
      : '这个需求下没有指派给你的子项'
    row.append(td)
    fragment.append(row)
  }
  return fragment
}

function buildChildRow(item, group) {
  const row = document.createElement('tr')
  const depth = Number(item.level ?? 0)
  const container = group.requirement
  // 已经挂在需求下面的子项，缩进从 1 级起算；平台返回的孙任务再逐级加。
  const indent = container && !container.orphan ? depth + 1 : depth
  row.className = 'child-row'
  row.dataset.parent = group.key
  row.dataset.key = `child:${item.type}:${item.id}`

  const toggle = cell('col-toggle')
  const badge = document.createElement('span')
  badge.className = `child-badge kind-${item.kind || 'task'}`
  badge.textContent = item.kindLabel || ''
  toggle.append(badge)

  const title = cell('title col-title')
  const wrap = document.createElement('div')
  wrap.className = 'title-wrap'
  wrap.style.paddingLeft = `${indent * CHILD_INDENT}px`
  const link = document.createElement('a')
  link.className = 'title-link'
  link.href = item.url ? item.url : '#'
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.textContent = item.name || item.code || item.id
  if (item.code) link.title = `${item.code} · ${item.name}`
  wrap.append(link)
  title.append(wrap)

  row.append(
    toggle,
    cell('col-code', muted(item.code || item.id)),
    title,
    cell('col-priority', pill(item.priority, priorityTone(item.priority))),
    cell('col-status', pill(item.status, statusTone(item))),
    cell('col-assignee', muted(item.assignee)),
    cell('col-due', muted(item.dueDate)),
    cell('col-project', muted(projectNameOf(item))),
  )
  return row
}

function buildGroupRow(group) {
  const requirement = group.requirement
  const key = group.key
  const expanded = state.expanded.has(key)
  const count = group.children.length

  const row = document.createElement('tr')
  row.className = 'group-row'
  row.dataset.key = key
  row.setAttribute('aria-expanded', String(expanded))
  if (expanded) row.classList.add('is-open')

  const toggle = document.createElement('td')
  toggle.className = 'col-toggle'
  // 本地子项为空但平台上可能还有时也要留出展开入口，否则懒加载永远触发不了。
  const expandable = count > 0 || (!requirement.synthetic && !requirement.orphan && requirement.id)
  if (expandable) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'row-toggle'
    button.dataset.toggle = key
    button.setAttribute('aria-expanded', String(expanded))
    button.setAttribute(
      'aria-label',
      `${expanded ? '收起' : '展开'} ${requirement.name || requirement.code}`,
    )
    button.textContent = expanded ? '▾' : '▸'
    toggle.append(button)
  } else {
    toggle.append(muted('·'))
  }

  const titleCell = cell('title col-title')
  const titleWrap = document.createElement('div')
  titleWrap.className = 'title-wrap'
  const name = document.createElement('span')
  name.className = 'group-title'
  name.textContent = requirement.name || requirement.code || '未命名需求'
  if (requirement.name && requirement.name.length > 40) name.title = requirement.name
  titleWrap.append(name)
  if (count) {
    const badge = document.createElement('span')
    badge.className = 'child-count'
    badge.textContent = String(count)
    badge.title = `${count} 个子项`
    titleWrap.append(badge)
  }
  if (requirement.synthetic && !requirement.status) {
    const hint = document.createElement('span')
    hint.className = 'group-hint'
    hint.textContent = '父需求不在当前结果'
    titleWrap.append(hint)
  }
  if (requirement.orphan) {
    const hint = document.createElement('span')
    hint.className = 'group-hint'
    hint.textContent = '没有需求归属'
    titleWrap.append(hint)
  }
  titleCell.append(titleWrap)

  row.append(
    toggle,
    cell('col-code', muted(requirement.code || requirement.id)),
    titleCell,
    cell('col-priority', pill(requirement.priority, priorityTone(requirement.priority))),
    cell('col-status', pill(requirement.status, statusTone(requirement))),
    cell('col-assignee', muted(requirement.assignee)),
    cell('col-due', muted(requirement.dueDate)),
    cell('col-project', muted(projectNameOf(requirement))),
  )
  return row
}

function renderRows() {
  const tbody = byId('rows')
  const fragment = document.createDocumentFragment()
  for (const group of state.groups) {
    fragment.append(buildGroupRow(group))
    if (state.expanded.has(group.key)) fragment.append(childRows(group))
  }
  tbody.replaceChildren(fragment)
  byId('empty').hidden = !state.loaded || state.groups.length > 0
  renderHint()
  renderPager()
}

function renderHint() {
  const expandedCount = state.expanded.size
  byId('hint').textContent = expandedCount
    ? `${state.groups.length} 个需求 · 已展开 ${expandedCount}`
    : ''
}

function renderPager() {
  const pages = Math.max(1, Math.ceil(state.total / state.size))
  byId('page-label').textContent = `第 ${state.page} / ${pages} 页 · 本页 ${state.items.length} 条`
  byId('prev').disabled = state.page <= 1
  byId('next').disabled = state.page >= pages
}

function renderMeta(text) {
  if (text) {
    byId('meta').textContent = text
    return
  }
  const projects = selectedProjects()
  const scope = projects.length
    ? projects.length === 1
      ? projects[0].name
      : `${projects.length} 个项目`
    : '全部项目'
  byId('meta').textContent =
    `${scope} · 共 ${state.total} 条 · 按需求分组 ${state.groups.length} 组`
}

// ---------------------------------------------------------------- 展开 / 懒加载

function groupByKey(key) {
  return state.groups.find((group) => group.key === key) ?? null
}

function toggleGroup(key) {
  const row = byId('rows').querySelector(`.group-row[data-key="${CSS.escape(key)}"]`)
  if (!row) return
  const group = groupByKey(key)
  if (!group) return
  if (state.expanded.has(key)) {
    state.expanded.delete(key)
    row.setAttribute('aria-expanded', 'false')
    row.classList.remove('is-open')
    const toggle = row.querySelector('.row-toggle')
    if (toggle) {
      toggle.textContent = '▸'
      toggle.setAttribute('aria-expanded', 'false')
    }
    // 只删自己的子行，其它分组不受影响。
    let next = row.nextElementSibling
    while (next && next.dataset.parent === key) {
      const following = next.nextElementSibling
      next.remove()
      next = following
    }
    renderHint()
    return
  }
  state.expanded.add(key)
  row.setAttribute('aria-expanded', 'true')
  row.classList.add('is-open')
  const toggle = row.querySelector('.row-toggle')
  if (toggle) {
    toggle.textContent = '▾'
    toggle.setAttribute('aria-expanded', 'true')
  }
  row.after(childRows(group))
  const storyId = group.requirement?.id
  if (storyId && !group.children.length && !state.childLoaded.has(storyId)) {
    row.after(childPlaceholder(group))
  }
  renderHint()
  // 先渲染本地已有子项（0 请求），再后台补齐平台上更全的子项。
  enqueueChildren(group)
}

function childPlaceholder(group) {
  const row = document.createElement('tr')
  row.className = 'child-row child-loading'
  row.dataset.parent = group.key
  const td = document.createElement('td')
  td.className = 'child-placeholder'
  td.colSpan = byId('team-table')?.tHead?.rows?.[0]?.cells?.length ?? 8
  const spinner = document.createElement('span')
  spinner.className = 'spinner'
  spinner.setAttribute('aria-hidden', 'true')
  td.append(spinner, document.createTextNode(' 正在加载子项…'))
  row.append(td)
  return row
}

function clearChildPlaceholder(key) {
  const row = byId('rows').querySelector(`.child-loading[data-parent="${CSS.escape(key)}"]`)
  if (row) row.remove()
}

function replaceChildRows(group) {
  const row = byId('rows').querySelector(`.group-row[data-key="${CSS.escape(group.key)}"]`)
  if (!row) return
  let next = row.nextElementSibling
  while (next && next.dataset.parent === group.key) {
    const following = next.nextElementSibling
    next.remove()
    next = following
  }
  row.after(childRows(group))
}

function enqueueChildren(group) {
  const id = group.requirement?.id
  if (!id || group.requirement.orphan) return
  if (state.childLoaded.has(id) || state.childLoading.has(id)) return
  if (!state.childQueue.includes(group)) state.childQueue.push(group)
  drainChildQueue()
}

function drainChildQueue() {
  while (state.activeChildren < CHILD_CONCURRENCY && state.childQueue.length) {
    const group = state.childQueue.shift()
    const id = group.requirement?.id
    if (!id || state.childLoaded.has(id) || state.childLoading.has(id)) continue
    state.childLoading.add(id)
    state.activeChildren += 1
    void fetchChildren(group, id).finally(() => {
      state.activeChildren -= 1
      state.childLoading.delete(id)
      drainChildQueue()
    })
  }
}

async function fetchChildren(group, id) {
  try {
    // 与客户端一致：type 传父节点自己的类型（需求 0 / 任务 3），不写死。
    const type = group.requirement?.type ?? 3
    const data = await rpc('GET', `/app/children?id=${encodeURIComponent(id)}&type=${type}`)
    const items = Array.isArray(data?.items) ? data.items : []
    state.childLoaded.add(id)
    clearChildPlaceholder(group.key)
    mergeChildren(group, items)
  } catch (error) {
    clearChildPlaceholder(group.key)
    // 单个需求取子项失败不该打断整张表，等下次展开再试。
    if (error?.code === 'CREDENTIALS_MISSING' || error?.code === 'CONNECTION_LOST') {
      await handleSessionLost(error.code)
    }
  }
}

function mergeChildren(group, items) {
  const known = new Set(group.children.map((item) => `${item.type}:${item.id}`))
  let changed = false
  for (const item of items) {
    const key = `${item.type}:${item.id}`
    if (known.has(key)) continue
    known.add(key)
    group.children.push(item)
    changed = true
  }
  if (!changed) return
  group.children = sortChildren(group.children)
  if (state.expanded.has(group.key)) replaceChildRows(group)
}

// ---------------------------------------------------------------- 查询变更

function onQueryChanged({ iterations = false } = {}) {
  state.page = 1
  state.expanded.clear()
  state.childLoaded.clear()
  state.childQueue = []
  schedulePrefsSave()
  if (iterations) {
    void loadIterations()
  }
  void loadTasks()
}

let filterTimer = null

function scheduleFilter() {
  clearTimeout(filterTimer)
  filterTimer = setTimeout(() => {
    state.filters.code = byId('filter-code').value.trim()
    state.filters.name = byId('filter-name').value.trim()
    onQueryChanged()
  }, 350)
}

// ---------------------------------------------------------------- 会话

function forgetSession() {
  state.auth = { online: false, account: null }
  state.projects = []
  state.selected.clear()
  state.items = []
  state.groups = []
  state.expanded.clear()
  state.childLoaded.clear()
  byId('ms-projects').open = false
  renderAuth()
  syncProjectInput()
  renderRows()
}

async function handleSessionLost(code) {
  await rpc('DELETE', '/session').catch(() => {})
  forgetSession()
  setBanner(
    code === 'CONNECTION_LOST'
      ? '你和 WitOps 的连接已断开，需要重新输入密码'
      : '还没有登录 WitOps，请先输入账号密码',
  )
}

async function loadSession() {
  const data = await rpc('GET', '/session')
  state.auth = { online: data?.online === true, account: data?.account ?? null }
  renderAuth()
  return state.auth
}

async function refresh({ reuseSession = false } = {}) {
  setBanner('')
  try {
    if (!reuseSession) await loadSession()
    if (!state.auth.online) return
    await loadProjects()
    syncDateInputs()
    byId('filter-code').value = state.filters.code
    byId('filter-name').value = state.filters.name
    mountMultiSelect('ms-status', () => STATUS_OPTIONS, 'status')
    mountMultiSelect('ms-priority', () => PRIORITY_OPTIONS, 'priority')
    mountMultiSelect('ms-assignee', assigneeOptions, 'assignee')
    await loadIterations()
    await loadTasks()
    // 负责人清单按需加载，不挡首屏。
    void loadUsers()
  } catch (error) {
    if (error.code === 'CONNECTION_LOST' || error.code === 'CREDENTIALS_MISSING') {
      await handleSessionLost(error.code)
      return
    }
    setBanner(error.message || '加载失败')
  }
}

async function boot() {
  syncDateInputs()
  renderRows()
  try {
    const auth = await loadSession()
    // 偏好先于项目列表读：项目列表会按当前选择做一次裁剪。
    if (auth.online) await loadPrefs()
    await refresh({ reuseSession: true })
  } catch (error) {
    setBanner(error.message || '加载失败')
  }
}

// ---------------------------------------------------------------- 事件绑定

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
    await boot()
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

// 项目多选：与状态/优先级/负责人同一套 details+checkbox 组件。
const projectDetails = byId('ms-projects')
projectDetails.addEventListener('toggle', () => {
  if (!projectDetails.open) return
  for (const other of document.querySelectorAll('.ms[open]')) {
    if (other !== projectDetails) other.open = false
  }
  renderProjectOptions(state.projectQuery)
  byId('project-search').focus()
})

byId('project-search').addEventListener('input', (event) => {
  state.projectQuery = event.target.value
  renderProjectOptions(state.projectQuery)
})

byId('project-search').addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  projectDetails.open = false
  projectDetails.querySelector('summary')?.focus()
})

byId('project-all').addEventListener('click', () => {
  for (const project of matchProjects(state.projectQuery)) state.selected.add(project.id)
  syncProjectSummary()
  renderProjectOptions(state.projectQuery)
  onQueryChanged({ iterations: true })
})

byId('project-none').addEventListener('click', () => clearProjects())

document.addEventListener('pointerdown', (event) => {
  if (event.target.closest('.ms')) return
  for (const box of document.querySelectorAll('.ms[open]')) box.open = false
})

byId('filter-create-from').addEventListener('change', () => {
  state.filters.createFrom = byId('filter-create-from').value
  onQueryChanged()
})
byId('filter-create-to').addEventListener('change', () => {
  state.filters.createTo = byId('filter-create-to').value
  onQueryChanged()
})

byId('filter-code').addEventListener('input', scheduleFilter)
byId('filter-name').addEventListener('input', scheduleFilter)
byId('filter-iteration').addEventListener('change', () => {
  state.filters.iteration = byId('filter-iteration').value
  onQueryChanged()
})

byId('filter-reset').addEventListener('click', () => {
  state.filters = {
    code: '',
    name: '',
    status: [],
    priority: [],
    assignee: [],
    iteration: '',
    createFrom: '',
    createTo: '',
  }
  byId('filter-code').value = ''
  byId('filter-name').value = ''
  byId('filter-iteration').value = ''
  syncDateInputs()
  mountMultiSelect('ms-status', () => STATUS_OPTIONS, 'status')
  mountMultiSelect('ms-priority', () => PRIORITY_OPTIONS, 'priority')
  mountMultiSelect('ms-assignee', assigneeOptions, 'assignee')
  onQueryChanged()
})

// 展开/收功用事件委托：一张表只挂一个监听器，子行再多也不会成倍增加回调。
byId('rows').addEventListener('click', (event) => {
  const toggle = event.target.closest('[data-toggle]')
  if (toggle) {
    event.preventDefault()
    toggleGroup(toggle.dataset.toggle)
    return
  }
  // 点整行也能展开，手不用瞄准那个小箭头。
  const row = event.target.closest('.group-row')
  if (row && !event.target.closest('a')) toggleGroup(row.dataset.key)
})

byId('rows').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return
  const row = event.target.closest('.group-row')
  if (!row) return
  event.preventDefault()
  toggleGroup(row.dataset.key)
})

byId('reload').addEventListener('click', () => void refresh())

byId('prev').addEventListener('click', () => {
  if (state.page <= 1) return
  state.page -= 1
  onQueryChanged()
})

byId('next').addEventListener('click', () => {
  state.page += 1
  onQueryChanged()
})
