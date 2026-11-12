const form = document.getElementById('login-form')
const serverUrlInput = document.getElementById('server-url')
const usernameInput = document.getElementById('username')
const passwordInput = document.getElementById('password')
const submitButton = document.getElementById('submit')
const statusElement = document.getElementById('status')
const errorElement = document.getElementById('error')
const versionElement = document.getElementById('version')
const configPathElement = document.getElementById('config-path')

const envPanel = document.getElementById('env-panel')
const loginPanel = document.getElementById('login-panel')
const envStatus = document.getElementById('env-status')
const envError = document.getElementById('env-error')
const envInstall = document.getElementById('env-install')
const envRetry = document.getElementById('env-retry')
const envSteps = Array.from(document.querySelectorAll('#env-steps li'))

const invoke = window.__TAURI__?.core?.invoke
const listen = window.__TAURI__?.event?.listen

const STEP_ORDER = ['node:check', 'trellis:check', 'node:download', 'trellis:install', 'ready']
const PROGRESS_STEP = {
  'node:download': 'node:download',
  'node:verify': 'node:download',
  'node:extract': 'node:download',
  'node:validate': 'node:download',
  'trellis:install': 'trellis:install',
  'trellis:validate': 'trellis:install',
  'write-flag': 'ready',
  ready: 'ready',
}

let submitting = false
let autoLoginAttempted = false
let installing = false
let loginReady = false

function setStatus(text) {
  statusElement.textContent = text
}

function clearError() {
  errorElement.textContent = ''
  errorElement.hidden = true
}

function showError(error) {
  const message = error instanceof Error ? error.message : String(error || '登录失败')
  errorElement.textContent = message.replace(/^Error:\s*/i, '')
  errorElement.hidden = false
}

function setSubmitting(value) {
  submitting = value
  submitButton.disabled = value
  submitButton.textContent = value ? '正在登录…' : '登录'
  for (const input of form.elements) {
    if (input instanceof HTMLInputElement) input.disabled = value
  }
}

function validateInput() {
  const serverUrl = serverUrlInput.value.trim()
  const username = usernameInput.value.trim()
  const password = passwordInput.value
  if (!serverUrl) return '请填写服务器地址。'
  try {
    const parsed = new URL(serverUrl)
    if (!['http:', 'https:'].includes(parsed.protocol)) return '服务器地址必须使用 HTTP 或 HTTPS。'
  } catch {
    return '服务器地址格式无效。'
  }
  if (username.length < 3) return '请填写有效的登录名。'
  if (password.length < 6) return '密码至少需要 6 个字符。'
  return null
}

/* ---------- 环境检查 ---------- */

function setEnvStatus(text) {
  envStatus.textContent = text
}

function showEnvError(error) {
  const message = error instanceof Error ? error.message : String(error || '')
  envError.textContent = message.replace(/^Error:\s*/i, '')
  envError.hidden = false
}

function clearEnvError() {
  envError.textContent = ''
  envError.hidden = true
}

function markSteps(activeStep, doneBefore = []) {
  for (const item of envSteps) {
    const step = item.dataset.step
    item.classList.toggle('done', doneBefore.includes(step))
    item.classList.toggle('active', step === activeStep)
  }
}

function renderRuntime(status) {
  clearEnvError()
  const state = status?.state || 'checking'
  if (state !== 'ready') {
    envPanel.hidden = false
    loginPanel.hidden = true
  }
  const node = status?.node || {}
  const trellis = status?.trellis || {}
  if (state === 'ready') {
    markSteps(null, ['node:check', 'trellis:check', 'node:download', 'trellis:install', 'ready'])
    setEnvStatus(`运行环境就绪：Node.js ${node.version || ''} / Trellis ${trellis.version || ''}`)
    showLogin()
    return
  }
  if (state === 'installing') {
    envInstall.hidden = true
    envRetry.hidden = true
    setEnvStatus('正在安装运行环境…')
    return
  }
  if (state === 'needs_setup') {
    markSteps(null, ['node:check', 'trellis:check'])
    const missing = []
    if (!node.ok) missing.push('Node.js')
    if (!trellis.ok) missing.push('Trellis CLI')
    setEnvStatus(`缺少${missing.join('与')}，请先安装运行环境。`)
    envInstall.hidden = false
    envRetry.hidden = true
    return
  }
  if (state === 'failed') {
    envInstall.hidden = false
    envRetry.hidden = true
    setEnvStatus('运行环境检查失败。')
    showEnvError(status?.error || '请重试或检查网络连接。')
    return
  }
  markSteps('node:check')
  setEnvStatus('正在检查运行环境…')
}

function showLogin() {
  if (loginReady) return
  loginReady = true
  envPanel.hidden = true
  loginPanel.hidden = false
  readStatus()
}

async function refreshRuntime() {
  if (!invoke) {
    envPanel.hidden = false
    setEnvStatus('请在 Trellis Board 桌面客户端中打开此页面。')
    showEnvError('未能连接桌面客户端进程。')
    return
  }
  try {
    const status = await invoke('runtime_status')
    renderRuntime(status)
  } catch (error) {
    envPanel.hidden = false
    envInstall.hidden = false
    setEnvStatus('无法检查运行环境。')
    showEnvError(error)
  }
}

async function installRuntime() {
  if (!invoke || installing) return
  installing = true
  clearEnvError()
  envInstall.hidden = true
  envRetry.hidden = true
  markSteps('node:download')
  setEnvStatus('正在准备运行环境…')
  try {
    const result = await invoke('runtime_install')
    setEnvStatus(
      `运行环境安装完成：Node.js ${result?.nodeVersion || ''} / Trellis ${result?.trellisVersion || ''}`,
    )
    markSteps(null, ['node:check', 'trellis:check', 'node:download', 'trellis:install', 'ready'])
    showLogin()
  } catch (error) {
    setEnvStatus('运行环境安装失败。')
    showEnvError(error)
    envInstall.hidden = false
    envRetry.hidden = false
  } finally {
    installing = false
  }
}

envInstall.addEventListener('click', installRuntime)
envRetry.addEventListener('click', refreshRuntime)

if (listen) {
  listen('runtime-progress', (event) => {
    const stage = event?.payload?.stage || ''
    const message = event?.payload?.message || ''
    if (message) setEnvStatus(message)
    const mapped = PROGRESS_STEP[stage]
    if (mapped) {
      const index = STEP_ORDER.indexOf(mapped)
      markSteps(mapped, STEP_ORDER.slice(0, Math.max(index, 0)))
    }
  }).catch(() => {})
}

/* ---------- 登录 ---------- */

async function readStatus() {
  if (!invoke) {
    setSubmitting(true)
    setStatus('请在 Trellis Board 桌面客户端中打开此页面。')
    showError('未能连接桌面客户端进程。')
    return
  }
  try {
    const app = await invoke('app_status')
    versionElement.textContent = `v${app.version}`
    configPathElement.textContent = app.configPath ? `配置：${app.configPath}` : ''
    if (app.serverUrl) serverUrlInput.value = app.serverUrl
    if (app.username) usernameInput.value = app.username
    if (app.password) passwordInput.value = app.password
    if (app.serverUrl && app.username && app.password) {
      setStatus('已恢复上次登录信息，正在自动登录…')
      autoLoginAttempted = true
      form.requestSubmit()
      return
    }
    setStatus('请输入账号密码登录。')
    const firstEmpty = [serverUrlInput, usernameInput, passwordInput].find((input) => !input.value)
    ;(firstEmpty || submitButton).focus()
  } catch (error) {
    setStatus('无法读取本地配置。')
    showError(error)
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (submitting || !invoke) return
  const automatic = autoLoginAttempted
  autoLoginAttempted = false
  clearError()
  const validationError = validateInput()
  if (validationError) {
    showError(validationError)
    return
  }
  setSubmitting(true)
  setStatus('正在验证账号并建立设备会话…')
  try {
    await invoke('desktop_login', {
      serverUrl: serverUrlInput.value.trim(),
      username: usernameInput.value.trim(),
      password: passwordInput.value,
    })
    passwordInput.value = ''
    setStatus('登录成功，正在打开 Board…')
  } catch (error) {
    setSubmitting(false)
    setStatus(automatic ? '自动登录失败，请检查后重试。' : '登录失败。')
    showError(error)
    passwordInput.focus()
  }
})

refreshRuntime()
