const KIND_META = {
  requirement: { label: '需求', cls: 'requirement' },
  task: { label: '任务', cls: 'task' },
  bug: { label: '缺陷', cls: 'bug' },
  workOrder: { label: '工单', cls: 'work-order' },
}
const TYPE_ORDER = [3, 4, 2, 0]
const PRIORITIES = ['P0', 'P1', 'P2', 'P3']

const state = {
  items: [],
  auth: null,
  loading: false,
  busy: false,
  error: '',
  notice: '',
  selected: new Set(),
  userId: null,
  fetchedAt: null,
  projects: [],
  repositoryId: '',
  pending: [],
  previewItems: [],
  previewResults: [],
  pendingReload: null,
  filters: {
    types: [0, 2, 3, 4],
    code: '',
    name: '',
    priority: '',
    status: '',
    categories: '',
    allUsers: false,
  },
  filterOptions: { types: [], priorities: [], statuses: [], categories: [] },
}
const bridge = window.TrellisBridge.create()
const { chip, confirm } = window.TrellisUI

function byId(id) {
  return document.getElementById(id)
}

function on(id, type, handler) {
  const node = byId(id)
  if (!node) {
    console.warn(`[witops-core] 面板缺少元素 #${id}，跳过 ${type} 绑定`)
    return
  }
  node.addEventListener(type, handler)
}

let credentialsWidget = null
function mountCredentials() {
  const root = byId('credentials')
  if (!root || !window.TrellisCredentialsWidget) return
  credentialsWidget = window.TrellisCredentialsWidget.mount({
    root,
    request: bridge.request,
    systemId: 'witops',
  })
}

bridge.onInit(() => {
  void loadFilters()
  void load(false)
  mountCredentials()
})

function span(className, text) {
  const node = document.createElement('span')
  node.className = className
  node.textContent = text
  return node
}

function cell(className, content) {
  const node = document.createElement('td')
  if (className) node.className = className
  if (typeof content === 'string') node.textContent = content
  else node.append(content)
  return node
}

function itemKey(item) {
  return `${item.type}:${item.id}`
}

function kindMeta(item) {
  return KIND_META[item.kind] ?? { label: item.kindLabel || '任务', cls: 'task' }
}

function linkedTasks(item) {
  return Array.isArray(item.trellisTasks) ? item.trellisTasks : []
}

function dispatchable(item) {
  return Boolean(item.id) && linkedTasks(item).length === 0
}

function authLabel(auth) {
  if (!auth) return '未登录'
  if (auth.status === 'authenticated') {
    return auth.account ? `${auth.account} · 已登录` : '已登录'
  }
  if (auth.mode === 'token') return auth.status === 'token-expired' ? 'token 已失效' : 'token 模式'
  if (auth.status === 'expired') return '会话过期'
  return '未登录'
}

function renderAuth() {
  const auth = state.auth
  byId('auth-chip').textContent = authLabel(auth)
  byId('auth-chip').dataset.state = auth?.status || 'anonymous'
  const needsLogin = auth?.mode !== 'token' && auth?.status !== 'authenticated'
  byId('login').hidden = !needsLogin
  byId('logout').hidden = auth?.status !== 'authenticated'
  if (needsLogin) {
    byId('login-hint').textContent = auth?.hasStoredPassword
      ? '已保存加密密码；可直接登录，或点登录复用。'
      : '密码默认不落盘；勾选记住密码后用宿主密钥加密保存。'
  }
}

function summarizeOutcome(result, label) {
  const summary = result?.summary ?? {}
  const childSummary = { imported: 0, duplicated: 0, skipped: 0, failed: 0 }
  for (const row of result?.results ?? []) {
    if (!row.childSummary) continue
    for (const key of Object.keys(childSummary)) {
      childSummary[key] += Number(row.childSummary[key] ?? 0)
    }
  }
  const parts = []
  if (summary.imported) parts.push(`创建 ${summary.imported}`)
  if (summary.duplicated) parts.push(`已存在 ${summary.duplicated}`)
  if (summary.skipped) parts.push(`跳过 ${summary.skipped}`)
  if (summary.failed) parts.push(`失败 ${summary.failed}`)
  if (childSummary.imported) parts.push(`子任务 ${childSummary.imported}`)
  if (childSummary.failed) parts.push(`子任务失败 ${childSummary.failed}`)
  const failures = (result?.results ?? []).filter((row) => row.status === 'failed')
  if (!failures.length) {
    return { notice: parts.length ? `${label}：${parts.join('，')}` : label, error: '' }
  }
  const first = failures[0]
  const reason = String(first.reason || '')
    .split('\n')[0]
    .slice(0, 160)
  const who = first.code || first.businessId || ''
  return {
    notice: parts.length ? `${label}：${parts.join('，')}` : label,
    error: `${who ? `${who}：` : ''}${reason}${failures.length > 1 ? `（共 ${failures.length} 个失败）` : ''}`,
  }
}

function isCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

function renderTypeChips() {
  const root = byId('type-chips')
  if (!root) return
  root.replaceChildren()
  const options = state.filterOptions.types.length
    ? state.filterOptions.types
    : TYPE_ORDER.map((type) => ({
        type,
        name: KIND_META[
          type === 3 ? 'requirement' : type === 2 ? 'bug' : type === 0 ? 'workOrder' : 'task'
        ].label,
      }))
  for (const option of options) {
    const type = Number(option.type)
    const cls = type === 3 ? 'requirement' : type === 2 ? 'bug' : type === 0 ? 'work-order' : 'task'
    const active = state.filters.types.includes(type)
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `type-chip kind-${cls}${active ? ' is-active' : ''}`
    button.textContent = option.name
    button.setAttribute('aria-pressed', String(active))
    button.addEventListener('click', () => {
      const next = new Set(state.filters.types)
      if (next.has(type)) {
        if (next.size === 1) return
        next.delete(type)
      } else next.add(type)
      state.filters.types = [...next]
      if (!next.has(2)) state.filters.categories = ''
      renderTypeChips()
      syncCategoryRow()
      void load(false)
    })
    root.append(button)
  }
}

function renderFilterOptions() {
  const options = state.filterOptions
  fillSelect('filter-priority', options.priorities, state.filters.priority, '全部')
  fillSelect('filter-status', options.statuses, state.filters.status, '全部')
  fillSelect('filter-categories', options.categories, state.filters.categories, '全部')
  renderTypeChips()
  syncCategoryRow()
}

function fillSelect(id, rows, current, allLabel) {
  const select = byId(id)
  if (!select) return
  select.replaceChildren()
  const all = document.createElement('option')
  all.value = ''
  all.textContent = allLabel
  select.append(all)
  for (const row of rows ?? []) {
    const option = document.createElement('option')
    option.value = String(row.code ?? row.type ?? row.value ?? '')
    option.textContent = String(row.name ?? row.label ?? row.code ?? '')
    option.selected = option.value === current
    select.append(option)
  }
  select.value = current
}

function syncCategoryRow() {
  const row = byId('filter-secondary')
  if (!row) return
  const active = state.filters.types.includes(2)
  row.hidden = !active
  if (active) return
  state.filters.categories = ''
  const select = byId('filter-categories')
  if (select) select.value = ''
}

let filterTimer = null
function applyFiltersSoon() {
  clearTimeout(filterTimer)
  filterTimer = setTimeout(() => {
    readFilters()
    void load(false)
  }, 350)
}

async function loadFilters(force = false) {
  try {
    const data = await bridge.get(force ? '/filters?refresh=1' : '/filters')
    state.filterOptions = {
      types: Array.isArray(data?.types) ? data.types : [],
      priorities: Array.isArray(data?.priorities) ? data.priorities : [],
      statuses: Array.isArray(data?.statuses) ? data.statuses : [],
      categories: Array.isArray(data?.categories) ? data.categories : [],
    }
  } catch {
    state.filterOptions = { types: [], priorities: [], statuses: [], categories: [] }
  }
  renderFilterOptions()
}

function mineQuery(force) {
  const params = new URLSearchParams()
  params.set('types', state.filters.types.join(','))
  for (const key of ['code', 'name', 'priority', 'status', 'categories']) {
    const value = state.filters[key].trim()
    if (value) params.set(key, value)
  }
  if (state.filters.allUsers) params.set('allUsers', '1')
  if (force) params.set('refresh', '1')
  return `/mine?${params.toString()}`
}

function storyCell(item) {
  const linked = linkedTasks(item)[0] ?? null
  const code = item.storyCode || linked?.storyCode || ''
  const name = item.storyName || linked?.storyName || ''
  const url = item.storyUrl || linked?.storyUrl || ''
  const node = cell('story', '')
  if (!code && !url) {
    node.textContent = '—'
    return node
  }
  const label = code || '需求'
  if (url) {
    const link = document.createElement('a')
    link.className = 'story-link'
    link.href = url
    link.target = '_blank'
    link.rel = 'noreferrer'
    link.textContent = label
    if (name) link.title = `${label} ${name}`
    node.append(link)
  } else {
    node.append(span('code', label))
  }
  if (name) {
    const sub = span('story-name', name)
    sub.title = name
    node.append(sub)
  }
  return node
}

function metaLine(item) {
  const parts = [item.category, item.module, item.iteration].filter(Boolean)
  return parts.length ? parts.join(' · ') : ''
}

function priorityChip(priority) {
  const value = String(priority || '').toUpperCase()
  if (!PRIORITIES.includes(value)) return span('priority', priority || '—')
  return span(`priority priority-${value.toLowerCase()}`, value)
}

function render() {
  renderAuth()
  const rows = byId('rows')
  rows.replaceChildren()
  const items = state.items
  byId('empty').hidden = items.length > 0

  for (const item of items) {
    const meta = kindMeta(item)
    const tr = document.createElement('tr')
    tr.className = `row-kind-${meta.cls}`

    const pickCell = document.createElement('td')
    pickCell.className = 'pick'
    const pickInner = document.createElement('div')
    pickInner.className = 'pick-inner'
    const dot = span(`row-dot kind-${meta.cls}`, '')
    dot.setAttribute('aria-hidden', 'true')
    pickInner.append(dot)
    if (dispatchable(item)) {
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = state.selected.has(itemKey(item))
      box.dataset.key = itemKey(item)
      box.addEventListener('change', () => {
        if (box.checked) state.selected.add(itemKey(item))
        else state.selected.delete(itemKey(item))
        render()
      })
      pickInner.append(box)
    }
    pickCell.append(pickInner)
    tr.append(pickCell)

    const kindCell = document.createElement('td')
    kindCell.append(span(`kind kind-${meta.cls}`, item.kindLabel || meta.label))
    if (item.typeName && item.typeName !== (item.kindLabel || meta.label)) {
      kindCell.append(span('kind-type', item.typeName))
    }
    tr.append(kindCell)

    const codeCell = document.createElement('td')
    codeCell.className = 'code-col'
    const code = document.createElement('div')
    code.className = 'code-line'
    code.append(span('code', item.code || item.id || '—'))
    const line = metaLine(item)
    if (line) code.append(span('code-meta', line))
    codeCell.append(code)
    tr.append(codeCell)

    const title = document.createElement('td')
    title.className = 'title'
    const titleText = document.createElement('div')
    titleText.className = 'title-text'
    titleText.textContent = item.title || '—'
    title.title = item.title || ''
    title.append(titleText)
    tr.append(title)
    tr.append(cell('', priorityChip(item.priority)))
    tr.append(cell('', item.status || '—'))
    tr.append(cell('', item.assignee || '—'))
    tr.append(cell('', item.dueDate || '—'))
    tr.append(storyCell(item))

    const trellis = document.createElement('td')
    trellis.className = 'trellis'
    if (linkedTasks(item).length) {
      const wrap = document.createElement('div')
      wrap.className = 'trellis-cell'
      for (const task of linkedTasks(item)) {
        const dir = task.taskKey.split('::')[1] || task.taskKey
        const short = dir.replace(/^\d{2}-\d{2}-/, '')
        const badge = chip(`${short} · ${task.status || 'unknown'}`)
        badge.title = `${dir} · ${task.status || 'unknown'}`
        wrap.append(badge)
      }
      trellis.append(wrap)
    } else {
      trellis.textContent = '—'
    }
    tr.append(trellis)

    const ops = document.createElement('td')
    ops.className = 'ops'
    const previewButton = document.createElement('button')
    previewButton.type = 'button'
    previewButton.className = 'tb-btn tb-btn-ghost tb-btn-sm'
    previewButton.textContent = '预览'
    previewButton.addEventListener('click', () => void previewItems([item]))
    ops.append(previewButton)
    if (dispatchable(item)) {
      const createButton = document.createElement('button')
      createButton.type = 'button'
      createButton.className = 'tb-btn tb-btn-sm'
      createButton.textContent = '创建'
      createButton.disabled = state.busy
      createButton.addEventListener('click', () => openCreateDialog([item]))
      ops.append(createButton)
    }
    tr.append(ops)
    rows.append(tr)
  }

  const selected = state.selected.size
  byId('selected-count').textContent = selected ? `已选 ${selected} 项` : '未选择'
  byId('dispatch-selected').disabled = state.busy || selected === 0
  byId('sync').disabled = state.busy || state.loading
  byId('refresh').disabled = state.busy || state.loading
  byId('select-all').checked =
    items.length > 0 &&
    items.filter(dispatchable).every((item) => state.selected.has(itemKey(item)))

  const meta = state.error
    ? state.error
    : `${state.items.length} 项 · 用户 ${state.userId ?? '—'} · ${state.fetchedAt || '—'}`
  byId('meta').textContent = meta
  byId('error').hidden = !state.error
  byId('error').textContent = state.error
  byId('notice').hidden = !state.notice
  byId('notice').textContent = state.notice
}

async function loadProjects() {
  try {
    const data = await bridge.get('/projects')
    state.projects = Array.isArray(data?.projects) ? data.projects : []
    state.repositoryId =
      state.repositoryId || data?.defaultRepositoryId || state.projects[0]?.repositoryId || ''
  } catch {
    state.projects = []
  }
  renderProjects()
}

function currentProject() {
  return state.projects.find((project) => project.repositoryId === state.repositoryId) ?? null
}

function renderProjects() {
  const select = byId('dialog-project')
  if (!select) return
  select.replaceChildren()
  const current = state.repositoryId || state.projects[0]?.repositoryId || ''
  for (const project of state.projects) {
    const option = document.createElement('option')
    option.value = project.repositoryId
    option.textContent = project.name || project.repositoryId
    option.selected = project.repositoryId === current
    select.append(option)
  }
  state.repositoryId = select.value || current
  renderBranches()
}

function renderBranches() {
  const select = byId('dialog-branch')
  if (!select) return
  const project = currentProject()
  const branches = Array.isArray(project?.branches) ? project.branches : []
  const current = project?.branch || branches[0] || ''
  select.replaceChildren()
  const fallback = document.createElement('option')
  fallback.value = ''
  fallback.textContent = branches.length ? '不指定（自动判断）' : '未发现本地分支'
  select.append(fallback)
  for (const branch of branches) {
    const option = document.createElement('option')
    option.value = branch
    option.textContent = branch
    select.append(option)
  }
  select.value = current
  select.disabled = branches.length === 0
}

function summaryGrid(rows) {
  const grid = document.createElement('dl')
  grid.className = 'summary-grid'
  for (const [label, value] of rows) {
    if (!value) continue
    const dt = document.createElement('dt')
    dt.textContent = label
    const dd = document.createElement('dd')
    dd.textContent = String(value)
    grid.append(dt, dd)
  }
  return grid
}

function setPreviewActionable(results) {
  const dialog = byId('preview-dialog')
  const ok = dialog?.dialog?.querySelector('.tb-dialog-footer .tb-btn:last-child')
  if (!ok) return
  const actionable = Array.isArray(results) && results.some((result) => result.status === 'ready')
  ok.style.display = actionable ? '' : 'none'
  ok.disabled = !actionable
}

function openPreviewDialog() {
  const dialog = byId('preview-dialog')
  if (dialog && !dialog.open) dialog.showModal()
}

function closePreviewDialog() {
  const dialog = byId('preview-dialog')
  if (dialog?.open) dialog.close()
}

function previewChildrenList(children) {
  const wrap = document.createElement('div')
  wrap.className = 'preview-children'
  const title = document.createElement('div')
  title.className = 'preview-subtitle'
  title.textContent = `需求下已拆分子任务（${children.length}）`
  wrap.append(title)
  const list = document.createElement('ul')
  list.className = 'children-list'
  for (const child of children) {
    const item = document.createElement('li')
    const code = child.code ? `${child.code} · ` : ''
    item.textContent = `${code}${child.title || '未命名'}${child.assignee ? ` · ${child.assignee}` : ''}`
    list.append(item)
  }
  wrap.append(list)
  return wrap
}

function renderPreviewBody(results) {
  const root = byId('preview-body')
  root.replaceChildren()
  if (!results.length) {
    root.append(span('tb-muted tb-small', '没有可预览的内容'))
    return
  }
  for (const result of results) {
    const section = document.createElement('section')
    section.className = 'preview-item'
    const head = document.createElement('div')
    head.className = 'preview-head'
    const meta = KIND_META[result.kind] ?? null
    head.append(
      span(
        `kind kind-${meta?.cls ?? 'task'}`,
        result.draft?.typeName || meta?.label || `类型 ${result.type}`,
      ),
    )
    head.append(span('code', result.businessId || ''))
    head.append(span(`preview-status status-${result.status}`, result.status))
    section.append(head)

    if (result.status === 'loading') {
      section.append(span('tb-muted tb-small', '正在读取任务内容…'))
      root.append(section)
      continue
    }
    if (result.status === 'failed') {
      section.append(span('preview-error', result.reason || '预览失败'))
      root.append(section)
      continue
    }
    if (result.status === 'duplicated') {
      const fallback =
        result.draft?.sourceName && result.draft.sourceName !== 'task.md'
          ? `（无 task.md，展示 ${result.draft.sourceName}）`
          : ''
      section.append(
        span('preview-notice', `已存在 Trellis 任务：${result.taskKey || '—'}${fallback}`),
      )
      // 已存在任务若带回了现有 task.md，继续渲染下方的摘要与原文预览。
      if (!result.draft?.taskMarkdown) {
        if (Array.isArray(result.children) && result.children.length) {
          section.append(previewChildrenList(result.children))
        }
        root.append(section)
        continue
      }
    }
    const draft = result.draft ?? {}
    section.append(
      summaryGrid([
        ['标题', draft.title],
        ['编号', draft.code],
        ['类型', draft.typeName],
        ['负责人', draft.assignee],
        ['优先级', draft.priority],
        ['截止日期', draft.dueDate],
        ['目录', draft.slug],
      ]),
    )
    if (Array.isArray(result.children) && result.children.length) {
      section.append(previewChildrenList(result.children))
    }
    if (draft.taskMarkdown) {
      const details = document.createElement('details')
      details.className = 'markdown-preview'
      details.open = true
      const summary = document.createElement('summary')
      summary.textContent = `${draft.sourceName || 'task.md'} 内容`
      const pre = document.createElement('pre')
      pre.textContent = draft.taskMarkdown
      details.append(summary, pre)
      section.append(details)
    }
    root.append(section)
  }
}

async function previewItems(items) {
  if (!items.length) return
  state.previewItems = items
  state.previewResults = []
  renderPreviewBody([{ status: 'loading', businessId: items[0]?.id, type: items[0]?.type }])
  setPreviewActionable([])
  openPreviewDialog()
  try {
    const data = await bridge.post('/dispatch/preview', {
      items: items.map((item) => ({ type: item.type, businessId: item.id })),
    })
    const results = Array.isArray(data?.results) ? data.results : []
    state.previewResults = results
    renderPreviewBody(results)
    setPreviewActionable(results)
  } catch (error) {
    renderPreviewBody([
      { status: 'failed', businessId: items[0]?.id, reason: error.message || '预览失败' },
    ])
    setPreviewActionable([])
  }
}

function openCreateDialog(items) {
  if (!items.length) return
  state.pending = items
  const single = items.length === 1 ? items[0] : null
  byId('dialog-hint').textContent = single
    ? `${single.code || single.id} · ${single.title || ''}`.slice(0, 120)
    : `将批量创建 ${items.length} 个任务`
  byId('dialog-summary').replaceChildren()
  if (single) {
    const meta = kindMeta(single)
    byId('dialog-summary').append(
      summaryGrid([
        ['类型', single.kindLabel || meta.label],
        ['编号', single.code || single.id],
        ['标题', single.title],
        ['负责人', single.assignee],
        ['平台优先级', single.priority],
        ['截止日期', single.dueDate],
      ]),
    )
  } else {
    byId('dialog-summary').append(
      summaryGrid([
        ['数量', `${items.length} 项`],
        ['编号', items.map((item) => item.code || item.id).join('、')],
      ]),
    )
  }
  byId('dialog-children-row').hidden = !single || single.type !== 3
  byId('dialog-children').checked = true
  byId('dialog-priority').value = PRIORITIES.includes(String(single?.priority || '').toUpperCase())
    ? String(single.priority).toUpperCase()
    : ''
  byId('dialog-due').value = single?.dueDate || ''
  void loadProjects()
  byId('create-dialog').showModal()
}

function closeCreateDialog() {
  byId('create-dialog').close()
  state.pending = []
}

async function load(force) {
  if (state.loading) {
    state.pendingReload =
      state.pendingReload === null ? Boolean(force) : state.pendingReload || Boolean(force)
    return
  }
  state.loading = true
  state.error = ''
  render()
  try {
    state.auth = await bridge.get('/auth')
    if (force) await bridge.post('/refresh', {})
    const data = await bridge.get(mineQuery(force))
    state.items = Array.isArray(data?.items) ? data.items : []
    state.userId = data?.userId ?? null
    state.fetchedAt = data?.fetchedAt ?? null
    if (!state.projects.length) await loadProjects()
    const keys = new Set(state.items.filter(dispatchable).map(itemKey))
    state.selected = new Set([...state.selected].filter((key) => keys.has(key)))
  } catch (error) {
    state.error = error.message || '加载失败'
  } finally {
    state.loading = false
    const again = state.pendingReload
    state.pendingReload = null
    render()
    if (again !== null) void load(again)
  }
}

async function dispatchItems(items, options = {}) {
  if (state.busy || !items.length) return
  state.busy = true
  state.error = ''
  state.notice = ''
  render()
  let notice = ''
  let errorText = ''
  try {
    const payload = {
      repositoryId: options.repositoryId || state.repositoryId || undefined,
      baseBranch: options.baseBranch || undefined,
      priority: options.priority || undefined,
      includeChildren: options.includeChildren !== false,
      items: items.map((item) => ({
        type: item.type,
        businessId: item.id,
        dueDate: options.dueDate || undefined,
        includeChildren: options.includeChildren !== false,
      })),
    }
    const result = await bridge.post('/dispatch', payload)
    const outcome = summarizeOutcome(result, '创建完成')
    notice = outcome.notice
    errorText = outcome.error
    state.selected.clear()
  } catch (error) {
    errorText = error.message || '创建失败'
  } finally {
    state.busy = false
    await load(true)
    state.notice = notice
    state.error = errorText
    render()
  }
}

on('refresh', 'click', () => void load(true))
on('filter-reset', 'click', () => {
  state.filters = {
    types: [0, 2, 3, 4],
    code: '',
    name: '',
    priority: '',
    status: '',
    categories: '',
    allUsers: false,
  }
  byId('filter-code').value = ''
  byId('filter-name').value = ''
  byId('filter-all-users').checked = false
  renderFilterOptions()
  void load(false)
})
for (const id of ['filter-code', 'filter-name']) {
  on(id, 'input', applyFiltersSoon)
  on(id, 'keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    clearTimeout(filterTimer)
    readFilters()
    void load(false)
  })
}
for (const id of ['filter-priority', 'filter-status', 'filter-categories', 'filter-all-users']) {
  on(id, 'change', () => {
    readFilters()
    void load(false)
  })
}
on('logout', 'click', async () => {
  try {
    state.auth = (await bridge.post('/logout', {}))?.auth ?? null
    state.notice = '已退出登录'
  } catch (error) {
    state.error = error.message || '退出失败'
  }
  render()
})
on('select-all', 'change', (event) => {
  if (event.target.checked) {
    for (const item of state.items) if (dispatchable(item)) state.selected.add(itemKey(item))
  } else {
    state.selected.clear()
  }
  render()
})
on('dispatch-selected', 'click', () => {
  const items = state.items.filter(
    (item) => dispatchable(item) && state.selected.has(itemKey(item)),
  )
  openCreateDialog(items)
})
on('dialog-project', 'change', () => {
  state.repositoryId = byId('dialog-project').value
  renderBranches()
})
on('dialog-preview', 'click', () => void previewItems(state.pending))

byId('preview-dialog').addEventListener('ok', () => {
  const readyIds = new Set(
    (state.previewResults || [])
      .filter((result) => result.status === 'ready')
      .map((result) => String(result.businessId)),
  )
  const items = state.previewItems.filter((item) => readyIds.has(String(item.id)))
  closePreviewDialog()
  if (items.length) openCreateDialog(items)
})

byId('create-dialog').addEventListener('ok', async () => {
  const items = state.pending.slice()
  if (!items.length) return
  const dueDate = byId('dialog-due').value.trim()
  if (dueDate && !isCalendarDate(dueDate)) {
    state.error = '截止日期格式应为 YYYY-MM-DD'
    byId('dialog-due').focus()
    render()
    return
  }
  const repositoryId = byId('dialog-project').value
  const baseBranch = byId('dialog-branch').value.trim()
  const priority = byId('dialog-priority').value
  const includeChildren = byId('dialog-children').checked
  const childrenHint = items.some((item) => item.type === 3) && includeChildren
  const ok = await confirm({
    title: '确认创建任务',
    message: `将创建 ${items.length} 个 Trellis 任务${baseBranch ? `，基于分支 ${baseBranch}` : ''}${
      childrenHint ? '，并创建需求下已拆分的子任务' : ''
    }。确认继续？`,
    okText: '确认创建',
  })
  if (!ok) return
  state.error = ''
  closeCreateDialog()
  void dispatchItems(items, { repositoryId, baseBranch, priority, dueDate, includeChildren })
})

function readFilters() {
  state.filters.code = byId('filter-code').value.trim()
  state.filters.name = byId('filter-name').value.trim()
  state.filters.priority = byId('filter-priority').value
  state.filters.status = byId('filter-status').value
  state.filters.categories = byId('filter-categories').value
  state.filters.allUsers = byId('filter-all-users').checked
}

on('sync', 'click', async () => {
  if (state.busy) return
  state.busy = true
  state.error = ''
  state.notice = ''
  render()
  let notice = ''
  let errorText = ''
  try {
    const result = await bridge.post('/sync', { size: 20 })
    const outcome = summarizeOutcome(result, '同步完成')
    notice = outcome.notice
    errorText = outcome.error
  } catch (error) {
    errorText = error.message || '同步失败'
  } finally {
    state.busy = false
    await load(true)
    state.notice = notice
    state.error = errorText
    render()
  }
})
on('login', 'submit', async (event) => {
  event.preventDefault()
  if (state.busy) return
  state.busy = true
  state.error = ''
  state.notice = ''
  render()
  try {
    const result = await bridge.post('/login', {
      account: byId('account').value.trim(),
      password: byId('password').value,
      remember: byId('remember').checked,
    })
    state.auth = result?.auth ?? null
    byId('password').value = ''
    state.notice = '登录成功'
    await credentialsWidget?.refresh()
  } catch (error) {
    state.error = error.message || '登录失败'
  } finally {
    state.busy = false
    await load(false)
  }
})

render()
renderTypeChips()
