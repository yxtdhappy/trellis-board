/**
 * team 模式的平台会话：token 由宿主保管，插件只在单次请求里看到它。
 *
 * - 宿主转发请求时把 `credential` 放进 RPC 载荷，SDK 用 AsyncLocalStorage 暴露给这里；
 * - 插件**不缓存 token**，也不落盘、不读 secrets；
 * - 平台返回 401/403 时只报"连接已断开"，绝不自动重登（会踢掉用户在 WitOps 的其他会话）。
 */
import { ApiError } from './witops-client.js'
import { decodeUserId, maskAccount, numberOrNull, text } from './util.js'

/**
 * 平台对"账号密码不对"的响应形形色色：业务码 40001、HTTP 401/403 都见过。
 * 这里只把"平台确实回了拒绝"翻译成账号密码错误；连不上/5xx 仍交回上层报 502。
 */
function isCredentialRejection(error) {
  if (!(error instanceof ApiError)) return false
  if (error.status === 401 || error.status === 403) return true
  if (error.status !== null && error.status >= 500) return false
  return error.code !== null
}

export function createTeamSession({ ctx, client }) {
  function credential() {
    const value = ctx.currentCredential?.() ?? null
    return value && text(value.token) ? value : null
  }

  function missing() {
    return ctx.error(1001, '先登录 WitOps 账号，再查看任务', { reason: 'missing-credentials' })
  }

  function expired() {
    return ctx.error(1001, '你和 WitOps 的连接已断开，需要重新输入密码', {
      reason: 'connection-lost',
    })
  }

  async function authorized(handler) {
    const current = credential()
    if (!current) throw missing()
    try {
      return await handler(current.token)
    } catch (error) {
      if (error instanceof ApiError && error.authExpired) throw expired()
      throw error
    }
  }

  /** 只由宿主 `POST /api/plugins/<id>/session` 通过 `/session/open` 调用。 */
  async function login({ account, password } = {}) {
    if (!text(account) || !text(password)) {
      throw ctx.error(1001, '请填写 WitOps 账号和密码', { reason: 'missing-credentials' })
    }
    const data = await loginWithFeedback(account, password)
    const token =
      typeof data === 'string' ? data : data?.token || data?.accessToken || data?.Authorization
    if (!token || typeof token !== 'string') {
      throw ctx.error(1001, '登录成功但平台没有返回凭据', { reason: 'missing-credentials' })
    }
    const userId =
      numberOrNull(data?.user?.id ?? data?.userId ?? data?.id) ?? decodeUserId(token) ?? null
    ctx.log.info('平台登录成功', { account: maskAccount(account), mode: 'team' })
    return { token, account: text(account), userId }
  }

  async function loginWithFeedback(account, password) {
    try {
      return await client.login(account, password)
    } catch (error) {
      if (isCredentialRejection(error)) {
        // 别把平台的原话吞掉：只看"账号密码不对"分不清是密码错还是入参格式错。
        // 只记状态码与平台 msg，不记密码。
        ctx.log.info('平台拒绝登录', {
          account: maskAccount(account),
          status: error.status ?? null,
          code: error.code ?? null,
          msg: String(error.message ?? '').slice(0, 120),
        })
        throw ctx.error(1001, 'WitOps 账号或密码不对，请重新输入', { reason: 'auth-failed' })
      }
      throw error
    }
  }

  function logout() {
    // 凭据由宿主按当前会话保管，插件进程内不保留任何跨请求状态。
    return { ok: true }
  }

  async function ensureToken() {
    const current = credential()
    if (!current) throw missing()
    return current.token
  }

  async function resolveUserId() {
    const current = credential()
    if (!current) throw missing()
    const fromCredential = numberOrNull(current.witopsUserId)
    if (fromCredential !== null) return fromCredential
    const decoded = decodeUserId(current.token)
    if (decoded !== null) return decoded
    const data = await authorized((token) => client.findUser({ token }))
    const id = numberOrNull(data?.id ?? data?.userId ?? data?.user?.id)
    if (id === null) throw ctx.error(1001, '无法确定当前平台用户')
    return id
  }

  function status() {
    const current = credential()
    return {
      mode: 'team',
      status: current ? 'authenticated' : 'anonymous',
      source: current ? 'host' : null,
      account: current?.account ? maskAccount(current.account) : null,
      userId: numberOrNull(current?.witopsUserId),
      expiresAt: current?.expiresAt ?? null,
      hasToken: Boolean(current),
      hasConfigPassword: false,
      hasStoredPassword: false,
      rememberEnabled: false,
    }
  }

  return {
    mode: 'team',
    login,
    logout,
    ensureToken,
    authorized,
    resolveUserId,
    status,
    async hasStoredPassword() {
      return false
    },
  }
}
