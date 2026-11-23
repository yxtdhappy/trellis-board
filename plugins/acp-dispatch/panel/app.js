const state = {
  data: null,
  taskKey: null,
  sending: false,
}

const bridge = window.TrellisBridge.create()
const { chip } = window.TrellisUI

function byId(id) {
  return document.getElementById(id)
}

bridge.onInit(() => {
  void load()
})

bridge.onEvent((event) => {
  const name = event?.name || ''
  if (!name.startsWith('acp-dispatch/session.')) return
  if (name === 'acp-dispatch/session.started') setStatus('运行中…')
  if (name === 'acp-dispatch/session.finished') setStatus('已完成')
  void load()
})

const CHIP_KIND = { succeeded: 'ok', failed: 'danger', timeout: 'danger', running: 'warn' }

function setStatus(text) {
  byId('prompt-status').textContent = text || ''
}

function taskLabel(taskKey) {
  return String(taskKey || '').split('::')[1] || taskKey || '未知任务'
}

function latestRuns(runs) {
  const map = new Map()
  for (const run of runs) {
    if (!map.has(run.taskKey)) map.set(run.taskKey, run)
  }
  return map
}

function span(className, text) {
  const node = document.createElement('span')
  node.className = className
  node.textContent = text
  return node
}

function renderList() {
  const list = byId('runs')
  const runs = latestRuns(state.data?.runs || [])
  const activeKeys = new Set((state.data?.active || []).map((item) => item.taskKey))
  const sessions = new Map((state.data?.sessions || []).map((item) => [item.taskKey, item]))
  const tasks = new Map((state.data?.tasks || []).map((item) => [item.taskKey, item]))
  list.replaceChildren()
  if (!runs.size && !sessions.size && !tasks.size) {
    const empty = document.createElement('li')
    empty.className = 'muted'
    empty.textContent = '暂无任务'
    list.append(empty)
    return
  }
  const keys = new Set([...tasks.keys(), ...runs.keys(), ...sessions.keys()])
  for (const taskKey of keys) {
    const task = tasks.get(taskKey)
    const run = runs.get(taskKey)
    const session = sessions.get(taskKey)
    const status = activeKeys.has(taskKey) ? 'running' : run?.status || task?.status || 'idle'
    const item = document.createElement('li')
    item.className = taskKey === state.taskKey ? 'active' : ''
    const row = document.createElement('div')
    row.className = 'row'
    const title = span('title', task?.title || taskLabel(taskKey))
    const statusKind = CHIP_KIND[status]
    const statusNode = statusKind ? chip(status, statusKind) : span('tb-muted tb-small', status)
    row.append(title, statusNode)
    const sessionNode = span(
      'muted',
      session?.sessionId || run?.result?.session?.id || '未建立会话',
    )
    item.append(row, sessionNode)
    item.addEventListener('click', () => {
      state.taskKey = taskKey
      renderList()
      renderDetail()
    })
    list.append(item)
  }
}

function card(label, value, status) {
  const node = document.createElement('div')
  node.className = 'card'
  node.append(span('label', label), span(`value ${status ? `status-${status}` : ''}`, value))
  return node
}

function renderDetail() {
  const title = byId('task-title')
  const meta = byId('task-meta')
  const outcome = byId('outcome')
  const send = byId('send')
  const cancel = byId('cancel')
  const summary = byId('summary')
  const taskKey = state.taskKey
  if (!taskKey) {
    title.textContent = '选择一个任务'
    meta.textContent = ''
    outcome.replaceChildren()
    summary.hidden = true
    send.disabled = true
    cancel.disabled = true
    return
  }
  const runs = state.data?.runs || []
  const run = runs.find((item) => item.taskKey === taskKey) || null
  const result = run?.result || null
  const activeEntry = (state.data?.active || []).find((item) => item.taskKey === taskKey)
  const session = (state.data?.sessions || []).find((item) => item.taskKey === taskKey)
  const sessionId = activeEntry?.sessionId || result?.session?.id || session?.sessionId || null
  const status = activeEntry ? 'running' : result?.outcome?.status || run?.status || 'idle'

  title.textContent = taskLabel(taskKey)
  meta.textContent = [
    sessionId ? `session ${sessionId}` : '未建立会话',
    result?.outcome?.stopReason ? `stop ${result.outcome.stopReason}` : null,
    result?.stats?.durationMs ? `${Math.round(result.stats.durationMs / 1000)}s` : null,
    result?.stats?.toolCalls ? `${result.stats.toolCalls} 次工具调用` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const cards = [
    card('状态', status, status),
    card('会话', sessionId || '—'),
    card('开始', run?.startedAt ? new Date(run.startedAt).toLocaleString() : '—'),
    card('结束', run?.finishedAt ? new Date(run.finishedAt).toLocaleString() : '—'),
  ]
  if (result?.outcome?.error) cards.push(card('错误', result.outcome.error, 'failed'))
  outcome.replaceChildren(...cards)

  const text = result?.summary?.text
  summary.hidden = !text
  summary.textContent = text || ''

  send.disabled = state.sending || status === 'running'
  cancel.disabled = status !== 'running'
}

async function load() {
  try {
    state.data = await bridge.get('/panel/data')
    byId('agent-label').textContent = state.data.configured ? state.data.agent || 'agent' : '未配置'
    if (!state.taskKey) {
      const first =
        (state.data.tasks || [])[0]?.taskKey ||
        (state.data.runs || [])[0]?.taskKey ||
        (state.data.sessions || [])[0]?.taskKey
      if (first) state.taskKey = first
    }
    renderList()
    renderDetail()
  } catch (error) {
    setStatus(error.message)
  }
}

async function send() {
  if (!state.taskKey || state.sending) return
  const input = byId('prompt-text')
  const text = input.value.trim()
  if (!text) {
    setStatus('请输入命令')
    return
  }
  state.sending = true
  setStatus('已发送，等待 agent…')
  renderDetail()
  try {
    await bridge.post('/panel/prompt', { taskKey: state.taskKey, text })
    input.value = ''
    setStatus('已完成')
  } catch (error) {
    setStatus(error.message)
  } finally {
    state.sending = false
    await load()
  }
}

async function cancel() {
  if (!state.taskKey) return
  setStatus('取消中…')
  try {
    await bridge.post('/panel/cancel', { taskKey: state.taskKey })
    setStatus('已请求取消')
  } catch (error) {
    setStatus(error.message)
  }
}

byId('send').addEventListener('click', () => void send())
byId('cancel').addEventListener('click', () => void cancel())
byId('refresh').addEventListener('click', () => void load())
