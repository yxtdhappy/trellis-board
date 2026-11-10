const title = document.querySelector('#title')
const message = document.querySelector('#message')
const details = document.querySelector('#details')
const error = document.querySelector('#error')
const actions = document.querySelector('#actions')

let current = null
let busy = false

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
  return details.filter(Boolean).join(' · ')
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
  if (busy) return
  busy = true
  error.textContent = ''
  message.textContent = '正在提交，请稍候…'
  actions.querySelectorAll('button').forEach((item) => {
    item.disabled = item.dataset.alwaysEnabled !== 'true'
  })
  try {
    if (current.type === 'assignment_warning') {
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
  if (event.type === 'assignment_warning') {
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
    if (JSON.stringify(next) !== JSON.stringify(current)) {
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
