/**
 * 统一账号面板：跑在宿主 iframe 里（sandbox），所有请求经 postMessage 桥转给
 * `/api/plugins/accounts-core/*`。界面全部用 DOM API 构建，不拼 innerHTML。
 */
const state = {
  accounts: [],
  systems: [],
  presets: [],
  tab: 'accounts',
  theme: 'light',
  initialized: false,
  pending: new Map(),
  sequence: 0,
}

function byId(id) {
  return document.getElementById(id)
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value)
    } else if (key in node) node[key] = value
    else node.setAttribute(key, value)
  }
  for (const child of children) {
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

function clear(node, ...children) {
  node.replaceChildren(...children.filter(Boolean))
}

function rpc(method, path, body) {
  const id = `r${++state.sequence}`
  return new Promise((resolve, reject) => {
    state.pending.set(id, { resolve, reject })
    window.parent.postMessage({ type: 'trellis:request', id, method, path, body }, '*')
  })
}

window.addEventListener('message', (event) => {
  const message = event.data
  if (!message || typeof message !== 'object') return
  if (message.type === 'trellis:init') {
    state.theme = message.theme || 'light'
    document.documentElement.dataset.theme = state.theme
    if (!state.initialized) {
      state.initialized = true
      void load()
    }
    return
  }
  if (message.type === 'trellis:response') {
    const entry = state.pending.get(message.id)
    if (!entry) return
    state.pending.delete(message.id)
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

function timeText(timestamp) {
  if (!Number.isFinite(timestamp)) return '—'
  const diff = Date.now() - timestamp
  if (diff < 60_000) return '刚刚'
  const minutes = Math.round(diff / 60_000)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.round(hours / 24)} 天前`
}

async function load() {
  try {
    const [accountsPayload, systemsPayload, presetsPayload] = await Promise.all([
      rpc('GET', '/accounts'),
      rpc('GET', '/systems'),
      rpc('GET', '/presets'),
    ])
    state.accounts = accountsPayload.accounts ?? []
    state.systems = systemsPayload.systems ?? []
    state.presets = presetsPayload.presets ?? []
    renderPresets()
    render()
  } catch (error) {
    toast(error.message, 'error')
  }
}

// 预设来自插件 config.systemPresets：只管输入提词，实际 id 仍可自由填写。
function renderPresets() {
  const list = byId('system-presets')
  if (!list) return
  clear(list, ...state.presets.map((preset) => el('option', { value: preset.id }, preset.name)))
  const hint = byId('system-preset-hint')
  if (hint) {
    const labels = state.presets.map((preset) =>
      preset.bound ? `${preset.id}（已绑定）` : preset.id,
    )
    hint.textContent = labels.length
      ? `可选：${labels.join('、')}；需与插件配置的 accountSystemId 一致。`
      : 'id 需与插件配置的 accountSystemId 一致。'
  }
}

function accountName(id) {
  if (!id) return '—'
  const account = state.accounts.find((item) => item.id === id)
  return account ? account.username : `${id}（缺失）`
}

function renderMeta() {
  const missing = state.accounts.filter((account) => !account.hasPassword).length
  byId('meta').textContent = `${state.accounts.length} 个账号 · ${state.systems.length} 个系统${
    missing ? ` · ${missing} 个账号未设密码` : ''
  }`
}

function renderAccounts() {
  const body = byId('accounts-body')
  const rows = state.accounts.map((account) =>
    el('tr', {}, [
      el('td', {}, [el('strong', {}, account.username)]),
      el('td', { class: 'muted' }, account.note || '—'),
      el('td', {}, [
        account.hasPassword
          ? el('span', { class: 'chip ok' }, '已设置')
          : el('span', { class: 'chip warn' }, '未设置'),
      ]),
      el('td', { class: 'muted' }, timeText(account.updatedAt)),
      el('td', { class: 'col-actions' }, [
        el(
          'button',
          { class: 'ghost', type: 'button', onclick: () => openAccount(account) },
          '编辑',
        ),
        el(
          'button',
          { class: 'ghost', type: 'button', onclick: () => openPassword(account) },
          '设密码',
        ),
        el(
          'button',
          {
            class: 'ghost danger',
            type: 'button',
            onclick: () => removeAccount(account),
          },
          '删除',
        ),
      ]),
    ]),
  )
  clear(body, ...rows)
  byId('accounts-empty').hidden = state.accounts.length > 0
}

function renderSystems() {
  const body = byId('systems-body')
  const rows = state.systems.map((system) =>
    el('tr', {}, [
      el('td', {}, [el('strong', {}, system.name), el('div', { class: 'muted small' }, system.id)]),
      el('td', { class: 'muted' }, system.baseUrl || '—'),
      el('td', {}, accountName(system.accountId)),
      el('td', {}, [
        system.enabled
          ? el('span', { class: 'chip ok' }, '启用')
          : el('span', { class: 'chip' }, '禁用'),
      ]),
      el('td', { class: 'col-actions' }, [
        el('button', { class: 'ghost', type: 'button', onclick: () => openSystem(system) }, '编辑'),
        el(
          'button',
          { class: 'ghost danger', type: 'button', onclick: () => removeSystem(system) },
          '删除',
        ),
      ]),
    ]),
  )
  clear(body, ...rows)
  byId('systems-empty').hidden = state.systems.length > 0
}

function render() {
  renderMeta()
  renderAccounts()
  renderSystems()
}

function switchTab(tab) {
  state.tab = tab
  byId('tab-accounts').classList.toggle('active', tab === 'accounts')
  byId('tab-systems').classList.toggle('active', tab === 'systems')
  byId('view-accounts').hidden = tab !== 'accounts'
  byId('view-systems').hidden = tab !== 'systems'
}

function openAccount(account) {
  const editing = Boolean(account)
  byId('account-dialog-title').textContent = editing ? '编辑账号' : '新建账号'
  byId('account-id').value = editing ? account.id : ''
  byId('account-username').value = editing ? account.username : ''
  byId('account-note').value = editing ? account.note : ''
  byId('account-password').value = ''
  byId('account-password-row').hidden = editing
  byId('account-dialog').showModal()
  byId('account-username').focus()
}

function openPassword(account) {
  openAccount(account)
  byId('account-dialog-title').textContent = `设置密码 · ${account.username}`
  byId('account-password-row').hidden = false
}

async function saveAccount(event) {
  event.preventDefault()
  const id = byId('account-id').value.trim()
  const username = byId('account-username').value.trim()
  const note = byId('account-note').value.trim()
  const password = byId('account-password').value
  if (!username) return toast('账号不能为空', 'error')
  try {
    const saved = await rpc('POST', '/accounts', { id: id || undefined, username, note })
    const accountId = saved.account?.id
    if (password && accountId) {
      await rpc('POST', '/accounts/password', { id: accountId, password })
    }
    byId('account-dialog').close()
    toast(id ? '账号已更新' : '账号已创建', 'ok')
    await load()
  } catch (error) {
    toast(error.message, 'error')
  }
}

// 面板在 sandbox iframe 里，window.confirm 会被浏览器静默忽略（返回 false），
// 所以删除确认用面板自己的 dialog。
function confirmAction(message) {
  const dialog = byId('confirm-dialog')
  byId('confirm-message').textContent = message
  dialog.returnValue = ''
  return new Promise((resolve) => {
    const done = () => {
      dialog.removeEventListener('close', done)
      resolve(dialog.returnValue === 'ok')
    }
    dialog.addEventListener('close', done)
    dialog.showModal()
  })
}

async function removeAccount(account) {
  if (!(await confirmAction(`删除账号「${account.username}」？（已绑定的系统会失去凭据）`))) return
  try {
    await rpc('DELETE', '/accounts', { id: account.id })
    toast('账号已删除', 'ok')
    await load()
  } catch (error) {
    toast(error.message, 'error')
    if (error.message.includes('仍被系统引用')) switchTab('systems')
  }
}

function fillAccountOptions(selectedId) {
  const select = byId('system-account')
  clear(
    select,
    el('option', { value: '' }, '（未绑定）'),
    ...state.accounts.map((account) =>
      el('option', { value: account.id }, `${account.username}（${account.id}）`),
    ),
  )
  select.value = selectedId || ''
}

function openSystem(system) {
  const editing = Boolean(system)
  byId('system-dialog-title').textContent = editing ? '编辑系统' : '新建系统'
  byId('system-id').value = editing ? system.id : ''
  byId('system-id').readOnly = editing
  byId('system-name').value = editing ? system.name : ''
  byId('system-baseurl').value = editing ? system.baseUrl : ''
  byId('system-note').value = editing ? system.note : ''
  byId('system-enabled').checked = editing ? system.enabled : true
  fillAccountOptions(editing ? system.accountId : '')
  byId('system-dialog').showModal()
  byId('system-id').focus()
}

async function saveSystem(event) {
  event.preventDefault()
  const payload = {
    id: byId('system-id').value.trim(),
    name: byId('system-name').value.trim(),
    baseUrl: byId('system-baseurl').value.trim(),
    accountId: byId('system-account').value,
    note: byId('system-note').value.trim(),
    enabled: byId('system-enabled').checked,
  }
  if (!payload.id) return toast('系统 id 不能为空', 'error')
  try {
    await rpc('POST', '/systems', payload)
    byId('system-dialog').close()
    toast('系统绑定已保存', 'ok')
    await load()
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function removeSystem(system) {
  if (!(await confirmAction(`删除系统「${system.name}」的绑定？`))) return
  try {
    await rpc('DELETE', '/systems', { id: system.id })
    toast('系统绑定已删除', 'ok')
    await load()
  } catch (error) {
    toast(error.message, 'error')
  }
}

byId('tab-accounts').addEventListener('click', () => switchTab('accounts'))
byId('tab-systems').addEventListener('click', () => switchTab('systems'))
byId('refresh').addEventListener('click', () => void load())
byId('new-account').addEventListener('click', () => openAccount(null))
byId('new-system').addEventListener('click', () => openSystem(null))
byId('account-cancel').addEventListener('click', () => byId('account-dialog').close())
byId('system-cancel').addEventListener('click', () => byId('system-dialog').close())
byId('account-form').addEventListener('submit', saveAccount)
byId('system-form').addEventListener('submit', saveSystem)

// 选中预设 id 时补显示名（仅在显示名为空时），用户仍可改。
byId('system-id').addEventListener('input', (event) => {
  const preset = state.presets.find((item) => item.id === event.target.value.trim())
  const nameInput = byId('system-name')
  if (preset && !nameInput.value.trim()) nameInput.value = preset.name
})
