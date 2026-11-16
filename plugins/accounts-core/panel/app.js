/**
 * 统一账号面板：跑在宿主 iframe 里（sandbox）。
 * 请求走 TrellisBridge，组件用 /plugin-ui/v1/（tokens/base/ui/combo），
 * 这里只写业务和布局，不再自带按钮、表格、对话框的基础样式。
 */
const UI = window.TrellisUI
const { el, button, chip, confirm, field, table, toast } = UI

const state = {
  accounts: [],
  systems: [],
  presets: [],
  tab: 'accounts',
  initialized: false,
}

const bridge = window.TrellisBridge.create()

function byId(id) {
  return document.getElementById(id)
}

const accountsTable = table({
  columns: [
    { title: '账号', render: (account) => el('strong', { text: account.username }) },
    { title: '备注', className: 'tb-muted', render: (account) => account.note || '—' },
    {
      title: '密码',
      render: (account) => (account.hasPassword ? chip('已设置', 'ok') : chip('未设置', 'warn')),
    },
    { title: '更新时间', className: 'tb-muted', render: (account) => timeText(account.updatedAt) },
    {
      title: '',
      className: 'tb-table-actions',
      render: (account) => [
        button({
          label: '编辑',
          variant: 'ghost',
          size: 'sm',
          onClick: () => openAccount(account),
        }),
        button({
          label: '设密码',
          variant: 'ghost',
          size: 'sm',
          onClick: () => openPassword(account),
        }),
        button({
          label: '删除',
          variant: 'danger',
          size: 'sm',
          onClick: () => removeAccount(account),
        }),
      ],
    },
  ],
  empty: '还没有账号，点「新建账号」添加 AD 账号。',
})

const systemsTable = table({
  columns: [
    {
      title: '系统',
      render: (system) => [
        el('strong', { text: system.name }),
        el('div', { class: 'tb-muted tb-small', text: system.id }),
      ],
    },
    { title: '地址', className: 'tb-muted', render: (system) => system.baseUrl || '—' },
    { title: '账号', render: (system) => accountName(system.accountId) },
    {
      title: '状态',
      render: (system) => (system.enabled ? chip('启用', 'ok') : chip('禁用')),
    },
    {
      title: '',
      className: 'tb-table-actions',
      render: (system) => [
        button({
          label: '编辑',
          variant: 'ghost',
          size: 'sm',
          onClick: () => openSystem(system),
        }),
        button({
          label: '删除',
          variant: 'danger',
          size: 'sm',
          onClick: () => removeSystem(system),
        }),
      ],
    },
  ],
  empty: '还没有绑定系统。在 jenkins-ops / witops-core 的配置里填 accountSystemId 后在这里绑定。',
})

byId('accounts-table').append(accountsTable.root)
byId('systems-table').append(systemsTable.root)

/* ---------- 表单控件 ---------- */

const usernameInput = el('input', { class: 'tb-input', id: 'account-username', maxlength: '64' })
const noteInput = el('input', { class: 'tb-input', id: 'account-note', maxlength: '200' })
const passwordInput = el('input', {
  class: 'tb-input',
  id: 'account-password',
  type: 'password',
  autocomplete: 'new-password',
})
const systemNameInput = el('input', { class: 'tb-input', id: 'system-name', maxlength: '80' })
const systemBaseUrlInput = el('input', {
  class: 'tb-input',
  id: 'system-baseurl',
  placeholder: 'https://ci.example.com',
})
const systemNoteInput = el('input', { class: 'tb-input', id: 'system-note', maxlength: '200' })
const accountSelect = el('select', { class: 'tb-input', id: 'system-account' })

const usernameField = field({
  label: '账号（AD 用户名）',
  control: usernameInput,
  htmlFor: 'account-username',
})
const noteField = field({ label: '备注', control: noteInput, htmlFor: 'account-note' })
const passwordField = field({
  label: '密码',
  control: passwordInput,
  htmlFor: 'account-password',
  hint: '留空表示不修改已保存的密码',
})
const systemNameField = field({
  label: '显示名',
  control: systemNameInput,
  htmlFor: 'system-name',
})
const systemBaseUrlField = field({
  label: '默认地址',
  control: systemBaseUrlInput,
  htmlFor: 'system-baseurl',
  hint: '留空则用消费方插件自己的地址',
})
const systemAccountField = field({
  label: '绑定账号',
  control: accountSelect,
  htmlFor: 'system-account',
})
const systemNoteField = field({
  label: '备注',
  control: systemNoteInput,
  htmlFor: 'system-note',
})

byId('field-username').append(usernameField.root)
byId('field-note').append(noteField.root)
byId('field-password').append(passwordField.root)
byId('field-system-name').append(systemNameField.root)
byId('field-system-baseurl').append(systemBaseUrlField.root)
byId('field-system-account').append(systemAccountField.root)
byId('field-system-note').append(systemNoteField.root)

// 系统 id 用可搜索下拉框；预设来自插件 config.systemPresets，实际 id 仍可手填。
const systemIdCombo = window.TrellisCombo.create({
  id: 'system-id',
  name: 'system-id',
  placeholder: 'jenkins / witops',
  onChange: (value) => {
    const preset = state.presets.find((item) => item.id === value)
    if (preset?.name && !systemNameInput.value.trim()) systemNameInput.value = preset.name
  },
})
const systemIdField = field({
  label: '系统 id',
  control: systemIdCombo.root,
  htmlFor: 'system-id',
})
byId('field-system-id').append(systemIdField.root, systemIdCombo.hint)

/* ---------- 数据加载 ---------- */

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

function accountName(id) {
  if (!id) return '—'
  const account = state.accounts.find((item) => item.id === id)
  return account ? account.username : `${id}（缺失）`
}

async function load() {
  try {
    const [accountsPayload, systemsPayload, presetsPayload] = await Promise.all([
      bridge.get('/accounts'),
      bridge.get('/systems'),
      bridge.get('/presets'),
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

function renderPresets() {
  systemIdCombo.setOptions(
    state.presets.map((preset) => ({
      value: preset.id,
      label: preset.name ? `${preset.id} · ${preset.name}` : preset.id,
    })),
  )
  const labels = state.presets.map((preset) =>
    preset.bound ? `${preset.id}（已绑定）` : preset.id,
  )
  systemIdCombo.setHint(
    labels.length
      ? `可选：${labels.join('、')}；需与插件配置的 accountSystemId 一致。`
      : 'id 需与插件配置的 accountSystemId 一致。',
  )
}

function renderMeta() {
  const missing = state.accounts.filter((account) => !account.hasPassword).length
  byId('meta').textContent = `${state.accounts.length} 个账号 · ${state.systems.length} 个系统${
    missing ? ` · ${missing} 个账号未设密码` : ''
  }`
}

function render() {
  renderMeta()
  accountsTable.render(state.accounts)
  systemsTable.render(state.systems)
}

function switchTab(tab) {
  state.tab = tab
  byId('tab-accounts').classList.toggle('is-active', tab === 'accounts')
  byId('tab-systems').classList.toggle('is-active', tab === 'systems')
  byId('view-accounts').hidden = tab !== 'accounts'
  byId('view-systems').hidden = tab !== 'systems'
}

/* ---------- 账号 ---------- */

const accountDialog = byId('account-dialog')

function openAccount(account) {
  const editing = Boolean(account)
  accountDialog.setAttribute('title', editing ? '编辑账号' : '新建账号')
  accountDialog.dataset.accountId = editing ? account.id : ''
  usernameInput.value = editing ? account.username : ''
  noteInput.value = editing ? (account.note ?? '') : ''
  passwordInput.value = ''
  usernameField.setHint('')
  passwordField.root.hidden = editing
  accountDialog.showModal()
  usernameInput.focus()
}

function openPassword(account) {
  openAccount(account)
  accountDialog.setAttribute('title', `设置密码 · ${account.username}`)
  passwordField.root.hidden = false
  passwordInput.focus()
}

async function saveAccount() {
  const id = accountDialog.dataset.accountId || ''
  const username = usernameInput.value.trim()
  const note = noteInput.value.trim()
  const password = passwordInput.value
  if (!username) {
    usernameField.setError('账号不能为空')
    usernameInput.focus()
    return
  }
  usernameField.setHint('')
  try {
    const saved = await bridge.post('/accounts', { id: id || undefined, username, note })
    const accountId = saved.account?.id
    if (password && accountId) {
      await bridge.post('/accounts/password', { id: accountId, password })
    }
    accountDialog.close()
    toast(id ? '账号已更新' : '账号已创建', 'ok')
    await load()
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function removeAccount(account) {
  const ok = await confirm({
    title: '删除账号',
    message: `删除账号「${account.username}」？已绑定的系统会失去凭据。`,
    okText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await bridge.delete('/accounts', { id: account.id })
    toast('账号已删除', 'ok')
    await load()
  } catch (error) {
    toast(error.message, 'error')
    if (error.message.includes('仍被系统引用')) switchTab('systems')
  }
}

/* ---------- 系统 ---------- */

const systemDialog = byId('system-dialog')

function fillAccountOptions(selectedId) {
  accountSelect.replaceChildren(
    el('option', { value: '' }, '（未绑定）'),
    ...state.accounts.map((account) =>
      el('option', { value: account.id }, `${account.username}（${account.id}）`),
    ),
  )
  accountSelect.value = selectedId || ''
}

function openSystem(system) {
  const editing = Boolean(system)
  systemDialog.setAttribute('title', editing ? '编辑系统' : '新建系统')
  systemDialog.dataset.systemId = editing ? system.id : ''
  systemIdCombo.setValue(editing ? system.id : '')
  systemIdCombo.setReadOnly(editing)
  systemNameInput.value = editing ? system.name : ''
  systemBaseUrlInput.value = editing ? (system.baseUrl ?? '') : ''
  systemNoteInput.value = editing ? (system.note ?? '') : ''
  byId('system-enabled').checked = editing ? system.enabled : true
  fillAccountOptions(editing ? system.accountId : '')
  systemDialog.showModal()
  systemIdCombo.focus()
}

async function saveSystem() {
  const id = systemIdCombo.value.trim()
  if (!id) {
    systemIdField.setError('系统 id 不能为空')
    systemIdCombo.setError('系统 id 不能为空')
    systemIdCombo.focus()
    return
  }
  systemIdField.setHint('')
  const payload = {
    id,
    name: systemNameInput.value.trim(),
    baseUrl: systemBaseUrlInput.value.trim(),
    accountId: accountSelect.value,
    note: systemNoteInput.value.trim(),
    enabled: byId('system-enabled').checked,
  }
  try {
    await bridge.post('/systems', payload)
    systemDialog.close()
    toast('系统绑定已保存', 'ok')
    await load()
  } catch (error) {
    toast(error.message, 'error')
  }
}

async function removeSystem(system) {
  const ok = await confirm({
    title: '删除系统绑定',
    message: `删除系统「${system.name}」的绑定？`,
    okText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await bridge.delete('/systems', { id: system.id })
    toast('系统绑定已删除', 'ok')
    await load()
  } catch (error) {
    toast(error.message, 'error')
  }
}

/* ---------- 事件 ---------- */

byId('tab-accounts').addEventListener('click', () => switchTab('accounts'))
byId('tab-systems').addEventListener('click', () => switchTab('systems'))
byId('refresh').addEventListener('click', () => void load())
byId('new-account').addEventListener('click', () => openAccount(null))
byId('new-system').addEventListener('click', () => openSystem(null))
accountDialog.addEventListener('ok', () => void saveAccount())
systemDialog.addEventListener('ok', () => void saveSystem())

bridge.onInit(() => {
  if (state.initialized) return
  state.initialized = true
  void load()
})
