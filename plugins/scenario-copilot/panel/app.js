const state = {
  defaults: null,
  tasks: [],
  runs: [],
  selected: null,
  timer: null,
  init: false,
  theme: 'light',
  outlineDraft: null,
}

const bridge = window.TrellisBridge.create({ timeout: 300000 })

bridge.onInit(() => {
  if (state.init) return
  state.init = true
  void boot()
})

bridge.onEvent((event) => {
  const name = event?.name
  if (name === 'scenario-copilot/run.finished' || name === 'scenario-copilot/run.started') {
    void loadRuns()
    if (state.selected) void loadRun(state.selected)
  }
})

const $ = (id) => document.getElementById(id)

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (key === 'className') node.className = value
    else if (key === 'textContent') node.textContent = value
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else node.setAttribute(key, value)
  }
  for (const child of children) node.append(child)
  return node
}

function formatTime(value) {
  if (!value) return '-'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

function formatDuration(ms) {
  if (!Number.isFinite(Number(ms))) return '-'
  const seconds = Math.round(Number(ms) / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function setHint(message, tone = 'warn') {
  const hint = $('hint')
  hint.textContent = message || ''
  hint.style.color = tone === 'muted' ? 'var(--tb-muted-fg)' : ''
}

const STATUS_CHIP = {
  running: 'tb-chip tb-chip-warn',
  paused: 'tb-chip tb-chip-warn',
  succeeded: 'tb-chip tb-chip-ok',
  failed: 'tb-chip tb-chip-danger',
}

const STATUS_LABEL = {
  running: '运行中',
  paused: '已暂停',
  succeeded: '成功',
  failed: '失败',
}

function statusText(status) {
  return STATUS_LABEL[status] || status || '-'
}

function statusClass(status) {
  return STATUS_CHIP[status] || 'tb-chip'
}

async function boot() {
  try {
    const [defaults, tasks, runs] = await Promise.all([
      bridge.get('/defaults'),
      bridge.get('/tasks'),
      bridge.get('/history'),
    ])
    state.defaults = defaults
    state.tasks = tasks.tasks || []
    state.runs = runs.runs || []
    $('org').value = defaults.orgName || ''
    $('no-run').checked = !defaults.hasCredentials
    $('generate-outline').hidden = !defaults.canGenerateOutline
    renderOutlines(defaults.outlines || [], '')
    renderTasks()
    renderRuns()
    setHint(
      defaults.hasCredentials
        ? '已配置测试账号，可直接执行浏览器用例'
        : '未配置测试账号，默认仅生成与校验',
      'muted',
    )
  } catch (error) {
    setHint(error.message)
  }
}

function renderTasks() {
  const select = $('task')
  select.replaceChildren()
  if (!state.tasks.length) {
    select.append(el('option', { value: '', textContent: '（没有可用的 Trellis 任务）' }))
    return
  }
  const preferred = state.tasks.find((task) => !task.archived) || state.tasks[0]
  for (const task of state.tasks) {
    const label = `${task.archived ? '[归档] ' : ''}${task.title}`
    const option = el('option', { value: task.taskKey, textContent: label })
    if (task.taskKey === preferred.taskKey) option.selected = true
    select.append(option)
  }
  applyTask(preferred.taskKey)
}

function selectedTask() {
  return state.tasks.find((task) => task.taskKey === $('task').value) || null
}

function applyTask(taskKey) {
  const task = state.tasks.find((candidate) => candidate.taskKey === taskKey)
  if (!task) return
  $('target').value = task.binding?.targetUrl || ''
  const outline = task.binding?.outline
  $('outline').value =
    outline && [...$('outline').options].some((option) => option.value === outline) ? outline : ''
  setHint(
    task.binding?.targetUrl ? '使用该任务已保存的测试地址' : '该任务尚未配置测试地址，请填写后下发',
    'muted',
  )
}

function renderOutlines(outlines, selected) {
  const select = $('outline')
  select.replaceChildren()
  select.append(el('option', { value: '', textContent: '未关联（由任务/需求自动解析）' }))
  for (const outline of outlines) {
    const option = el('option', { value: outline.name, textContent: outline.title })
    if (outline.name === selected) option.selected = true
    select.append(option)
  }
  if (selected) select.value = selected
}

function renderRuns() {
  const list = $('runs')
  list.replaceChildren()
  if (!state.runs.length) {
    list.append(el('li', { className: 'empty', textContent: '还没有运行记录' }))
    return
  }
  for (const run of state.runs) {
    const item = el(
      'li',
      {
        className: `run${run.id === state.selected ? ' active' : ''}`,
        dataset: { id: run.id },
        tabindex: '0',
      },
      [
        el('div', { className: 'run-title', textContent: run.outline }),
        el('div', { className: 'run-meta' }, [
          el('span', { className: statusClass(run.status), textContent: statusText(run.status) }),
          el('span', {
            className: 'tb-chip',
            textContent: run.paused ? `停在 ${run.stage}` : run.stage || 'execute',
          }),
          el('span', {
            textContent: `${formatTime(run.startedAt)} · ${formatDuration(run.durationMs)}`,
          }),
        ]),
      ],
    )
    item.addEventListener('click', () => selectRun(run.id))
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') selectRun(run.id)
    })
    list.append(item)
  }
}

async function loadRuns() {
  const data = await bridge.get('/history')
  state.runs = data.runs || []
  renderRuns()
}

async function selectRun(id) {
  state.selected = id
  renderRuns()
  await loadRun(id)
  startPolling()
}

async function loadRun(id) {
  try {
    const data = await bridge.get(`/run?id=${encodeURIComponent(id)}`)
    const run = data.run
    renderDetail(run)
    $('status-pill').textContent = statusText(run.status)
    $('status-pill').className = statusClass(run.status)
  } catch (error) {
    setHint(error.message)
  }
}

function renderDetail(run) {
  $('detail-title').textContent = run.outline
  const meta = $('detail-meta')
  meta.replaceChildren()
  const rows = [
    ['任务', run.taskTitle || run.taskKey || '-'],
    ['测试版本', run.testVersion || '-'],
    ['状态', statusText(run.status)],
    ['阶段', run.paused ? `${run.stage}（已暂停，可继续下一阶段）` : run.stage || 'execute'],
    ['续跑', run.resumed ? '是（复用上次脚本）' : '否'],
    ['覆盖率', run.coveragePassed ? '通过' : '未通过'],
    ['地址', run.targetUrl],
    ['开始', formatTime(run.startedAt)],
    ['耗时', formatDuration(run.durationMs)],
    ['模式', run.noRun ? '仅生成/校验' : '生成 + 执行'],
    ['脚本', run.scriptPath || '-'],
  ]
  for (const [label, value] of rows) {
    meta.append(
      el('div', {}, [
        el('span', { textContent: `${label}：` }),
        el('code', { textContent: String(value) }),
      ]),
    )
  }
  if (run.error) meta.append(el('div', { textContent: `错误：${run.error}` }))
  if (run.statePath) {
    meta.append(
      el('div', {}, [
        el('span', { textContent: '状态文件：' }),
        el('code', { textContent: run.statePath }),
      ]),
    )
  }

  const failedBox = $('failed-tests')
  failedBox.replaceChildren()
  const failed = Array.isArray(run.failedTests) ? run.failedTests : []
  failedBox.hidden = failed.length === 0
  if (failed.length) {
    failedBox.append(
      el('div', { className: 'failed-title', textContent: `失败用例（${failed.length}）` }),
    )
    for (const title of failed) {
      failedBox.append(el('div', { className: 'failed-item', textContent: title }))
    }
  }

  const running = run.status === 'running'
  $('resume-next').hidden = !run.paused || running
  $('retry-failed').hidden = failed.length === 0 || running
  $('regenerate').hidden = running
  const logs = $('logs')
  const atBottom = logs.scrollTop + logs.clientHeight >= logs.scrollHeight - 40
  logs.textContent = run.logs || '（暂无输出）'
  if (atBottom) logs.scrollTop = logs.scrollHeight
  $('cancel').hidden = run.status !== 'running'
}

function startPolling() {
  if (state.timer) clearInterval(state.timer)
  state.timer = setInterval(async () => {
    const current = state.runs.find((run) => run.id === state.selected)
    if (!current || current.status !== 'running') {
      clearInterval(state.timer)
      state.timer = null
      await loadRuns()
      return
    }
    await loadRun(current.id).catch(() => {})
    await loadRuns().catch(() => {})
  }, 2500)
}

$('start').addEventListener('click', async () => {
  const button = $('start')
  button.disabled = true
  setHint('正在启动 scenario-copilot…', 'muted')
  try {
    const result = await bridge.post('/runs', {
      taskKey: $('task').value,
      outline: $('outline').value,
      stage: $('stage').value,
      targetUrl: $('target').value,
      username: $('username').value,
      password: $('password').value,
      orgName: $('org').value,
      noRun: $('no-run').checked,
    })
    state.selected = result.run.id
    await loadRuns()
    await loadRun(result.run.id)
    startPolling()
    setHint(result.noRun ? '已启动：仅生成与覆盖率校验' : '已启动：生成并执行浏览器用例', 'muted')
  } catch (error) {
    setHint(error.message)
  } finally {
    button.disabled = false
  }
})

$('refresh').addEventListener('click', () => {
  void loadRuns()
  if (state.selected) void loadRun(state.selected)
})

$('task').addEventListener('change', () => applyTask($('task').value))

$('cancel').addEventListener('click', async () => {
  if (!state.selected) return
  try {
    await bridge.post('/cancel', { id: state.selected })
    await loadRun(state.selected)
  } catch (error) {
    setHint(error.message)
  }
})

function setGenHint(message, tone = 'warn') {
  const hint = $('gen-hint')
  hint.textContent = message || ''
  hint.style.color = tone === 'muted' ? 'var(--tb-muted-fg)' : ''
}

function openOutlineDialog() {
  const task = selectedTask()
  $('gen-title').value = task ? task.title : ''
  $('gen-notes').value = ''
  $('gen-name').value = ''
  $('gen-preview').textContent = ''
  $('gen-preview').hidden = true
  $('gen-save').disabled = true
  state.outlineDraft = null
  setGenHint('')
  $('outline-dialog').showModal()
  $('gen-notes').focus()
}

$('generate-outline').addEventListener('click', () => openOutlineDialog())
$('gen-close').addEventListener('click', () => $('outline-dialog').close())

$('gen-run').addEventListener('click', async () => {
  if (!$('gen-notes').value.trim()) {
    setGenHint('请先填写需求描述或测试要点')
    return
  }
  const button = $('gen-run')
  button.disabled = true
  setGenHint('正在生成大纲，通常需要几十秒到两分钟…', 'muted')
  try {
    const result = await bridge.post('/outlines/generate', {
      title: $('gen-title').value,
      notes: $('gen-notes').value,
    })
    state.outlineDraft = result
    $('gen-preview').textContent = result.content
    $('gen-preview').hidden = false
    $('gen-save').disabled = false
    const warnings = result.warnings || []
    setGenHint(
      `已生成 ${result.cases} 个用例 / ${result.steps} 条步骤` +
        (warnings.length ? ` · ${warnings.length} 条提示：${warnings[0]}` : ''),
      warnings.length ? 'warn' : 'muted',
    )
  } catch (error) {
    setGenHint(error.message)
  } finally {
    button.disabled = false
  }
})

$('gen-save').addEventListener('click', async () => {
  const draft = state.outlineDraft
  if (!draft) return
  const button = $('gen-save')
  button.disabled = true
  try {
    const task = selectedTask()
    const saved = await bridge.post('/outlines/save', {
      content: draft.content,
      name: $('gen-name').value,
      scope: task ? 'task' : 'requirement',
      taskKeys: task ? [task.taskKey] : [],
      source: 'generated',
    })
    renderOutlines(saved.outlines || [], saved.name)
    $('outline').value = saved.name
    $('outline-dialog').close()
    setHint(`已保存大纲 ${saved.name}，可直接发起测试`, 'muted')
  } catch (error) {
    setGenHint(error.message)
  } finally {
    button.disabled = false
  }
})

async function resumeSelected(action, button) {
  if (!state.selected) return
  button.disabled = true
  try {
    const result = await bridge.post('/runs/resume', {
      id: state.selected,
      action,
      username: $('username').value,
      password: $('password').value,
      orgName: $('org').value,
    })
    state.selected = result.run.id
    await loadRuns()
    await loadRun(result.run.id)
    startPolling()
    const ACTION_HINTS = {
      next: `已继续下一阶段：${result.run.stage}`,
      'only-failed': '已开始仅重跑失败用例',
      regenerate: '已开始重新生成',
    }
    setHint(ACTION_HINTS[action] || '已开始续跑', 'muted')
  } catch (error) {
    setHint(error.message)
  } finally {
    button.disabled = false
  }
}

$('resume-next').addEventListener('click', () => resumeSelected('next', $('resume-next')))
$('retry-failed').addEventListener('click', () => resumeSelected('only-failed', $('retry-failed')))
$('regenerate').addEventListener('click', () => resumeSelected('regenerate', $('regenerate')))
