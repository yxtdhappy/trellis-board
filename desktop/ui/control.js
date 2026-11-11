const title = document.querySelector('#title')
const message = document.querySelector('#message')
const details = document.querySelector('#details')
const error = document.querySelector('#error')
const actions = document.querySelector('#actions')

let current = null
let busy = false
let reviewChoices = new Map()
let sourceSignature = ''

function invoke(command, args) {
  const api = window.__TAURI__?.core?.invoke
  if (!api) return Promise.reject(new Error('本地客户端控制接口不可用'))
  return api(command, args)
}

function addDetail(label, value) {
  if (value == null || value === '') return
  const term = document.createElement('dt')
  const description = document.createElement('dd')
  term.textContent = label
  description.textContent = String(value)
  details.append(term, description)
}

function taskLabel(taskKey) {
  const value = String(taskKey || '')
  const separator = value.indexOf('::')
  return separator >= 0 ? value.slice(separator + 2) : value
}

function conflictLabel(conflict) {
  if (typeof conflict === 'string') return conflict
  const details = [String(conflict?.path || '')]
  if (Number.isSafeInteger(conflict?.revision)) {
    details.push(`文件版本 r${conflict.revision}`)
  }
  if (conflict?.changeType === 'line-endings') details.push('仅换行差异')
  if (conflict?.changeType === 'content') details.push('内容变化')
  const changedBy = conflict?.changedBy
  if (changedBy?.displayName || changedBy?.deviceName || changedBy?.occurredAt) {
    details.push(
      [
        changedBy.displayName,
        changedBy.deviceName,
        changedBy.occurredAt ? new Date(changedBy.occurredAt).toLocaleString() : null,
      ]
        .filter(Boolean)
        .join(' · '),
    )
  }
  return details.filter(Boolean).join(' · ')
}

function differenceTypeLabel(type) {
  switch (type) {
    case 'server-only':
      return '仅服务端存在'
    case 'local-only':
      return '仅本地存在'
    case 'content-conflict':
      return '内容冲突'
    case 'move-delete-conflict':
      return '移动或删除冲突'
    case 'invalid':
      return '任务结构或身份异常'
    default:
      return type
  }
}

function differenceTitle(difference) {
  return (
    difference.server?.taskId ||
    difference.local?.taskId ||
    difference.taskId ||
    difference.server?.taskDir ||
    difference.local?.taskDir ||
    difference.taskDir ||
    '未知任务'
  )
}

function appendInitialDifference(difference) {
  const key = String(
    difference.taskId ||
      difference.taskDir ||
      difference.local?.taskId ||
      difference.server?.taskId ||
      '',
  )
  const term = document.createElement('dt')
  term.textContent = `${differenceTitle(difference)} · ${differenceTypeLabel(difference.type)}`
  const description = document.createElement('dd')
  const pathSummary = [
    difference.local?.taskDir ? `本地：${difference.local.taskDir}` : null,
    difference.server?.taskDir ? `服务端：${difference.server.taskDir}` : null,
  ]
    .filter(Boolean)
    .join('；')
  if (pathSummary) {
    const path = document.createElement('p')
    path.className = 'source'
    path.textContent = pathSummary
    description.append(path)
  }
  const label = document.createElement('label')
  label.className = 'review-choice'
  const text = document.createElement('span')
  text.textContent = '处理方式'
  const select = document.createElement('select')
  let options
  let fallback
  if (difference.type === 'server-only') {
    options = [
      ['use-server', '下载服务端任务'],
      ['skip', '暂不处理'],
    ]
    fallback = 'use-server'
  } else if (difference.type === 'local-only') {
    options = [
      ['use-local', '上传本地任务'],
      ['skip', '暂不处理'],
    ]
    fallback = 'use-local'
  } else if (difference.type === 'invalid') {
    options = difference.local
      ? [
          ['save-local', '仅保存本地副本'],
          ['skip', '暂不处理'],
        ]
      : [['skip', '暂不处理']]
    fallback = 'skip'
  } else {
    options = [
      ['use-server', '使用服务端版本'],
      ['use-local', '使用本地版本'],
      ['save-local', '仅保存本地副本'],
      ['skip', '暂不处理'],
    ]
    fallback = 'skip'
  }
  for (const [value, labelText] of options) {
    const option = document.createElement('option')
    option.value = value
    option.textContent = labelText
    if (value === fallback) option.selected = true
    select.append(option)
  }
  reviewChoices.set(key, fallback)
  select.addEventListener('change', () => reviewChoices.set(key, select.value))
  label.append(text, select)
  description.append(label)
  details.append(term, description)
}

function appendDiff(detailsElement, file) {
  const term = document.createElement('dt')
  term.textContent = file.path
  const description = document.createElement('dd')
  const grid = document.createElement('div')
  grid.className = 'diff-grid'
  for (const [label, content] of [
    ['本地版本', file.localContent],
    ['服务端版本', file.serverContent],
  ]) {
    const block = document.createElement('section')
    const heading = document.createElement('strong')
    heading.textContent = label
    const pre = document.createElement('pre')
    pre.textContent = content == null ? '该文件在对应版本中不存在' : content
    block.append(heading, pre)
    grid.append(block)
  }
  description.append(grid)
  if (file.changedBy?.displayName || file.changedBy?.deviceName || file.changedBy?.occurredAt) {
    const source = document.createElement('p')
    source.className = 'source'
    source.textContent = [
      file.changedBy.displayName,
      file.changedBy.deviceName,
      file.changedBy.occurredAt ? new Date(file.changedBy.occurredAt).toLocaleString() : null,
    ]
      .filter(Boolean)
      .join(' · ')
    description.append(source)
  }
  detailsElement.append(term, description)
}

function renderConflictDiff(result) {
  title.textContent = `任务「${result.taskTitle || result.taskId || '未知任务'}」差异`
  message.textContent = '左侧是本地版本，右侧是服务端版本。关闭后可继续选择保留哪一份。'
  details.replaceChildren()
  actions.replaceChildren()
  for (const file of result.files || []) appendDiff(details, file)
  button('返回冲突处理', 'back', 'primary')
}

function button(label, action, className = '') {
  const element = document.createElement('button')
  element.type = 'button'
  element.textContent = label
  element.className = className
  element.dataset.alwaysEnabled = String(action === 'close')
  element.addEventListener('click', () => void runAction(action))
  actions.append(element)
  return element
}

async function runAction(action) {
  if (!current) return
  if (action === 'close') {
    try {
      await invoke('live_control_dismiss')
      current = null
      await refresh()
    } catch (actionError) {
      error.textContent =
        actionError instanceof Error ? actionError.message : String(actionError || '关闭通知失败')
    }
    return
  }
  if (action === 'review-open') {
    current = { ...current, expanded: true }
    render(current)
    return
  }
  if (action === 'review-collapse') {
    current = { ...current, expanded: false }
    render(current)
    return
  }
  if (action === 'back') {
    render(current)
    return
  }
  if (busy) return
  busy = true
  error.textContent = ''
  message.textContent = '正在提交，请稍候…'
  actions.querySelectorAll('button').forEach((item) => {
    item.disabled = item.dataset.alwaysEnabled !== 'true'
  })
  try {
    if (current.type === 'task_file_conflict') {
      if (action === 'view-difference') {
        const result = await invoke('live_control_diff', {
          taskSpaceId: current.taskSpaceId,
          conflictId: current.conflict.conflictId,
        })
        busy = false
        renderConflictDiff(result)
        return
      }
      if (
        action === 'overwrite-server' &&
        !window.confirm('这会用本地任务目录覆盖服务端当前版本，双方内容都会先备份。确认继续？')
      ) {
        busy = false
        render(current)
        return
      }
      await invoke('live_control_decide', {
        taskSpaceId: current.taskSpaceId,
        conflictId: current.conflict.conflictId,
        action,
      })
    } else if (current.type === 'initial_sync_review') {
      if (action === 'apply-review') {
        const decisions = [...reviewChoices.entries()].map(([taskId, choice]) => ({
          taskId,
          action: choice,
        }))
        await invoke('live_control_initial', {
          taskSpaceId: current.taskSpaceId,
          mode: 'review',
          decisions,
        })
      } else {
        await invoke('live_control_initial', {
          taskSpaceId: current.taskSpaceId,
          mode: action,
        })
      }
    } else if (current.type === 'assignment_warning') {
      await invoke('live_control_decide', {
        pendingId: current.pendingId,
        action,
      })
    } else if (current.type === 'remote_overwrite') {
      await invoke('live_control_restore', {
        backupId: current.backupId,
      })
    }
    current = null
    busy = false
  } catch (actionError) {
    error.textContent =
      actionError instanceof Error ? actionError.message : String(actionError || '操作失败')
    busy = false
    render(current)
  }
}

function render(event) {
  title.textContent = '当前没有待处理事件'
  message.textContent = ''
  details.replaceChildren()
  actions.replaceChildren()
  if (!event) return
  if (event.type === 'initial_sync_review') {
    const differences = (event.differences || []).filter((item) => item.type !== 'same')
    title.textContent = '任务差异需要确认'
    message.textContent =
      '本地仓库和团队服务端任务不一致。可以先仅同步安全项，或逐项决定每个任务保留哪一份。'
    addDetail('任务空间', event.taskSpaceId)
    addDetail(
      '差异',
      differences
        .map((item) => `${differenceTitle(item)}（${differenceTypeLabel(item.type)}）`)
        .join('、'),
    )
    if (event.expanded) {
      reviewChoices = new Map()
      for (const difference of differences) appendInitialDifference(difference)
      button('返回摘要', 'review-collapse')
      button('应用选择', 'apply-review', 'primary')
    } else {
      button('仅同步无冲突项', 'safe')
      button('查看并处理差异', 'review-open', 'primary')
      button('稍后处理', 'close')
    }
  } else if (event.type === 'task_file_conflict') {
    const conflict = event.conflict || {}
    const files = conflict.files || []
    const changedBy = files.find((file) => file.changedBy)?.changedBy
    const source = [
      changedBy?.displayName,
      changedBy?.deviceName,
      changedBy?.occurredAt ? new Date(changedBy.occurredAt).toLocaleString() : null,
    ]
      .filter(Boolean)
      .join(' · ')
    title.textContent = `任务「${conflict.taskTitle || conflict.taskId || '未知任务'}」发生冲突`
    message.textContent = source
      ? `${source} 修改了该任务。本次没有覆盖任何文件，请选择保留哪一份。`
      : '任务文件已发生变化。本次没有覆盖任何文件，请选择保留哪一份。'
    addDetail('冲突文件', files.map(conflictLabel).join('\n'))
    addDetail('处理建议', conflict.suggestion)
    button('查看差异', 'view-difference')
    button('使用服务端版本', 'use-server')
    button('用我的版本覆盖', 'overwrite-server', 'danger')
    button('仅保存本地副本', 'save-local-copy')
    button('稍后处理', 'close')
  } else if (event.type === 'task_sync_error') {
    title.textContent = '任务同步失败'
    message.textContent = event.message || '任务空间同步暂时失败，请稍后重试。'
    addDetail('任务空间', event.taskSpaceId)
    button('关闭', 'close', 'primary')
  } else if (event.type === 'assignment_warning') {
    const assignee = event.assignee?.displayName || event.assignee?.username || '其他成员'
    title.textContent = '你正在修改他人负责的任务'
    message.textContent =
      `当前责任人是 ${assignee}。建议先沟通，避免多人重复推进同一任务。` +
      '继续推进会保留原责任人并记录审计；只有接管任务才会显式改派。' +
      '选择稍后处理后，可从托盘重新打开。'
    addDetail('任务', event.task?.title || event.task?.taskKey)
    addDetail('责任人', assignee)
    if (event.expiresAt) addDetail('确认截止', new Date(event.expiresAt).toLocaleString())
    button('取消并恢复', 'cancel', 'danger')
    button('继续推进', 'continue')
    button('接管任务', 'takeover', 'primary')
    button('稍后处理', 'close')
  } else if (event.type === 'remote_overwrite') {
    const taskKeys = event.taskKeys || []
    const conflicts = event.conflicts?.length ? event.conflicts : event.files || []
    const fileCount = event.fileCount ?? conflicts.length
    title.textContent = '本地文件已被团队最新版本更新'
    message.textContent =
      `冲突文件已先备份到工作区外。仅在远端版本不正确时使用一键复原；` +
      `它会恢复本次全部 ${fileCount} 个冲突文件，形成新的团队版本并广播给其他客户端。`
    addDetail('影响范围', `${taskKeys.length} 个任务、${fileCount} 个文件`)
    addDetail('任务', taskKeys.map(taskLabel).join('、'))
    addDetail('冲突文件', conflicts.map(conflictLabel).join('\n'))
    addDetail('同步版本', event.revision)
    addDetail('备份位置', event.backupPath)
    button('关闭', 'close')
    button('一键复原', 'restore', 'primary')
  } else if (event.type === 'assignment_overridden') {
    title.textContent = '你负责的任务已被其他成员推进'
    message.textContent =
      event.action === 'takeover'
        ? '其他成员已显式接管该任务。请查看任务详情和审计记录后再决定是否继续处理。'
        : '其他成员选择继续推进该任务，原责任人未变更。建议沟通确认当前进度。'
    addDetail('任务', event.taskKey)
    addDetail('团队版本', event.revision)
    button('知道了', 'close', 'primary')
  }
}

async function refresh() {
  try {
    const next = await invoke('live_control_pending')
    const nextSignature = JSON.stringify(next)
    if (nextSignature !== sourceSignature) {
      sourceSignature = nextSignature
      current = next
      busy = false
      render(current)
    }
  } catch (refreshError) {
    error.textContent =
      refreshError instanceof Error
        ? refreshError.message
        : String(refreshError || '读取待确认事件失败')
  }
}

void refresh()
setInterval(() => void refresh(), 750)
