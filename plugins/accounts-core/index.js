/**
 * accounts-core：内网 AD 统一账号的唯一可信源。
 *
 * - 账号（username）与系统（baseUrl + 账号引用）存 store，密码只落 secrets
 *   （宿主 AES-256-GCM 加密），任何接口都不回传密码；
 * - 其他插件通过 capability `accounts.credentials` 解析凭据，解决 secret 按插件隔离的问题；
 * - 面板负责编辑；jenkins-ops / witops-core 复用 panel/widget/credentials-widget.js。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPlugin } from '@trellis-board/server/plugins/sdk.js'

const PLUGIN_ID = 'accounts-core'
const PLUGIN_VERSION = '1.0.0'
const BASE_DIR = path.dirname(fileURLToPath(import.meta.url))
const ACCOUNTS_KEY = 'accounts'
const SYSTEMS_KEY = 'systems'
const SYSTEM_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
// 面板输入提词；插件配置里的 config.systemPresets 会整包覆盖它。
const DEFAULT_PRESETS = [
  { id: 'witops', name: 'WitOps 平台' },
  { id: 'jenkins', name: 'Jenkins' },
]

function text(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function respond(status, body) {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8' }, body }
}

function toHttpError(error) {
  const code = error?.code
  const byCode = { '-32602': 400, 1003: 504, 1004: 404, 1005: 429 }
  const status = byCode[code] ?? 502
  return respond(status, {
    error: error?.message || '账号操作失败',
    code: Number.isInteger(code) ? code : null,
  })
}

function guard(handler) {
  return async (request) => {
    try {
      return await handler(request)
    } catch (error) {
      return toHttpError(error)
    }
  }
}

function passwordKey(accountId) {
  return `${PLUGIN_ID}/account-${accountId}`
}

function normalizeAccountList(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      id: text(item.id),
      username: text(item.username),
      note: text(item.note),
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : null,
    }))
    .filter((item) => item.id && item.username)
}

function normalizeSystemList(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      id: text(item.id),
      name: text(item.name) || text(item.id),
      baseUrl: text(item.baseUrl),
      accountId: text(item.accountId),
      note: text(item.note),
      enabled: item.enabled !== false,
    }))
    .filter((item) => item.id)
}

function normalizePresets(value) {
  const source = Array.isArray(value) ? value : DEFAULT_PRESETS
  return source
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({ id: text(item.id), name: text(item.name) || text(item.id) }))
    .filter((item) => item.id && SYSTEM_ID_PATTERN.test(item.id))
}

export default createPlugin({
  name: PLUGIN_ID,
  version: PLUGIN_VERSION,
  apiVersion: 1,
  permissions: [
    'http:route',
    'panels',
    'store',
    'secrets:read',
    'secrets:write',
    'capabilities:provide',
  ],

  async onStart(ctx) {
    let accounts = normalizeAccountList(await ctx.store.get(ACCOUNTS_KEY))
    let systems = normalizeSystemList(await ctx.store.get(SYSTEMS_KEY))
    // 预设只是面板输入提示，不影响解析；消费方插件的 accountSystemId 仍以 id 为准。
    const presets = normalizePresets(ctx.config?.systemPresets)

    function persistAccounts() {
      return ctx.store.set(ACCOUNTS_KEY, accounts)
    }

    function persistSystems() {
      return ctx.store.set(SYSTEMS_KEY, systems)
    }

    // 其他插件订阅 `accounts-core/changed` 后重新解析凭据，无需重启。
    function notifyChanged(kind, id) {
      ctx.events
        .publish('accounts-core/changed', { kind, id: text(id), at: Date.now() })
        .catch((error) => ctx.log.warn('变更事件发布失败', { kind, message: error.message }))
    }

    async function readPasswords() {
      const entries = await Promise.all(
        accounts.map(async (account) => {
          try {
            return [account.id, text(await ctx.secrets.get(passwordKey(account.id)))]
          } catch {
            return [account.id, '']
          }
        }),
      )
      return new Map(entries)
    }

    async function accountViews() {
      const passwords = await readPasswords()
      return accounts.map((account) => ({
        ...account,
        hasPassword: Boolean(passwords.get(account.id)),
      }))
    }

    async function systemViews() {
      const passwords = await readPasswords()
      return systems.map((system) => {
        const account = accountById(system.accountId)
        return {
          ...system,
          hasAccount: Boolean(account),
          username: account?.username ?? '',
          hasPassword: Boolean(account && passwords.get(account.id)),
        }
      })
    }

    function accountById(id) {
      return accounts.find((account) => account.id === id) ?? null
    }

    function systemsOfAccount(id) {
      return systems.filter((system) => system.accountId === id).map((system) => system.id)
    }

    function nextAccountId() {
      let max = 0
      for (const account of accounts) {
        const match = /^acc-(\d+)$/.exec(account.id)
        if (match) max = Math.max(max, Number(match[1]))
      }
      return `acc-${max + 1}`
    }

    function requireAccount(id) {
      const account = accountById(text(id))
      if (!account) throw ctx.error(1004, `账号不存在: ${text(id)}`)
      return account
    }

    function requireSystem(id) {
      const systemId = text(id)
      const system = systems.find((item) => item.id === systemId)
      if (!system) throw ctx.error(1004, `系统不存在: ${systemId}`)
      return system
    }

    ctx.http.route(
      'GET',
      '/presets',
      guard(async () => {
        const known = new Set(systems.map((system) => system.id))
        return respond(200, {
          presets: presets.map((preset) => ({
            ...preset,
            bound: known.has(preset.id),
          })),
        })
      }),
    )

    ctx.http.route(
      'GET',
      '/status',
      guard(async () => {
        const views = await accountViews()
        return respond(200, {
          plugin: PLUGIN_ID,
          version: PLUGIN_VERSION,
          accounts: views.length,
          systems: systems.length,
          missingPasswords: views.filter((account) => !account.hasPassword).map((a) => a.id),
        })
      }),
    )

    ctx.http.route(
      'GET',
      '/accounts',
      guard(async () => respond(200, { accounts: await accountViews() })),
    )

    ctx.http.route(
      'POST',
      '/accounts',
      guard(async (request) => {
        const body = request.json() ?? {}
        const username = text(body.username)
        if (!username) return respond(400, { error: 'username 不能为空' })
        const id = text(body.id)
        if (id && !ACCOUNT_ID_PATTERN.test(id))
          return respond(400, { error: `账号 id 不合法: ${id}` })
        const now = Date.now()
        const existing = id ? accountById(id) : null
        if (existing) {
          existing.username = username
          if (body.note !== undefined) existing.note = text(body.note)
          existing.updatedAt = now
        } else {
          accounts = [
            ...accounts,
            { id: id || nextAccountId(), username, note: text(body.note), updatedAt: now },
          ]
        }
        await persistAccounts()
        const created = id ? accountById(id) : accounts[accounts.length - 1]
        ctx.log.info('账号已保存', { id: created.id })
        notifyChanged('account', created.id)
        const view = (await accountViews()).find((account) => account.id === created.id)
        return respond(200, { ok: true, account: view, created: !existing })
      }),
    )

    ctx.http.route(
      'DELETE',
      '/accounts',
      guard(async (request) => {
        const body = request.json() ?? {}
        const account = requireAccount(body.id)
        const usedBy = systemsOfAccount(account.id)
        if (usedBy.length > 0) {
          return respond(409, { error: `账号仍被系统引用：${usedBy.join(', ')}`, systems: usedBy })
        }
        accounts = accounts.filter((item) => item.id !== account.id)
        await persistAccounts()
        try {
          await ctx.secrets.delete(passwordKey(account.id))
        } catch {
          /* 密码本就不存在时忽略 */
        }
        ctx.log.info('账号已删除', { id: account.id })
        notifyChanged('account', account.id)
        return respond(200, { ok: true })
      }),
    )

    ctx.http.route(
      'POST',
      '/accounts/password',
      guard(async (request) => {
        const body = request.json() ?? {}
        const account = requireAccount(body.id)
        const password = text(body.password)
        if (!password) return respond(400, { error: 'password 不能为空' })
        await ctx.secrets.set(passwordKey(account.id), password)
        ctx.log.info('账号密码已更新', { id: account.id })
        notifyChanged('account', account.id)
        return respond(200, { ok: true })
      }),
    )

    ctx.http.route(
      'DELETE',
      '/accounts/password',
      guard(async (request) => {
        const body = request.json() ?? {}
        const account = requireAccount(body.id)
        await ctx.secrets.delete(passwordKey(account.id))
        ctx.log.info('账号密码已清除', { id: account.id })
        notifyChanged('account', account.id)
        return respond(200, { ok: true })
      }),
    )

    ctx.http.route(
      'GET',
      '/systems',
      guard(async () => respond(200, { systems: await systemViews() })),
    )

    ctx.http.route(
      'POST',
      '/systems',
      guard(async (request) => {
        const body = request.json() ?? {}
        const id = text(body.id)
        if (!id) return respond(400, { error: 'id 不能为空' })
        if (!SYSTEM_ID_PATTERN.test(id)) {
          return respond(400, { error: 'id 需为 kebab-case（a-z、0-9、-）' })
        }
        const accountId = text(body.accountId)
        if (accountId && !accountById(accountId)) {
          return respond(400, { error: `账号不存在: ${accountId}` })
        }
        const baseUrl = text(body.baseUrl)
        if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
          return respond(400, { error: 'baseUrl 必须以 http:// 或 https:// 开头' })
        }
        const next = {
          id,
          name: text(body.name) || id,
          baseUrl,
          accountId,
          note: text(body.note),
          enabled: body.enabled !== false,
        }
        const index = systems.findIndex((item) => item.id === id)
        if (index >= 0) systems = systems.map((item, i) => (i === index ? next : item))
        else systems = [...systems, next]
        await persistSystems()
        ctx.log.info('系统绑定已保存', { id, accountId })
        notifyChanged('system', id)
        const view = (await systemViews()).find((system) => system.id === id)
        return respond(200, { ok: true, system: view })
      }),
    )

    ctx.http.route(
      'DELETE',
      '/systems',
      guard(async (request) => {
        const body = request.json() ?? {}
        const system = requireSystem(body.id)
        systems = systems.filter((item) => item.id !== system.id)
        await persistSystems()
        ctx.log.info('系统绑定已删除', { id: system.id })
        notifyChanged('system', system.id)
        return respond(200, { ok: true })
      }),
    )

    async function resolveCredential(params) {
      const systemId = text(params?.system)
      const system = systems.find((item) => item.id === systemId)
      if (!system) throw ctx.error(1004, `系统不存在: ${systemId}`)
      if (!system.enabled) throw ctx.error(1004, `系统已禁用: ${systemId}`)
      const account = accountById(system.accountId)
      if (!account) throw ctx.error(1004, `系统未绑定账号: ${systemId}`)
      let password = ''
      try {
        password = text(await ctx.secrets.get(passwordKey(account.id)))
      } catch {
        password = ''
      }
      if (!password) throw ctx.error(1004, `账号未设置密码: ${account.username}`)
      ctx.log.info('凭据已解析', { system: systemId, account: account.id })
      return {
        systemId,
        accountId: account.id,
        username: account.username,
        password,
        baseUrl: system.baseUrl || null,
      }
    }

    ctx.capabilities.register('accounts.credentials', {
      'accounts.list': async () => ({ accounts: await accountViews() }),
      'systems.list': async (params) => ({
        systems: (await systemViews())
          .filter((item) => (params?.enabledOnly ? item.enabled : true))
          .map(({ id, name, baseUrl, accountId, enabled, username, hasAccount, hasPassword }) => ({
            id,
            name,
            baseUrl,
            accountId,
            enabled,
            username,
            hasAccount,
            hasPassword,
          })),
      }),
      'credential.resolve': resolveCredential,
    })

    function asset(name, type) {
      try {
        return {
          status: 200,
          headers: { 'content-type': type },
          body: fs.readFileSync(path.join(BASE_DIR, 'panel', name), 'utf8'),
        }
      } catch {
        return respond(404, { error: `面板资源缺失: ${name}` })
      }
    }

    ctx.http.route('GET', '/panel', () => asset('index.html', 'text/html; charset=utf-8'))
    ctx.http.route('GET', '/panel/app.js', () => asset('app.js', 'text/javascript; charset=utf-8'))
    ctx.http.route('GET', '/panel/app.css', () => asset('app.css', 'text/css; charset=utf-8'))
    ctx.http.route('GET', '/panel/widget/credentials-widget.js', () =>
      asset('widget/credentials-widget.js', 'text/javascript; charset=utf-8'),
    )
    ctx.http.route('GET', '/panel/widget/credentials-widget.css', () =>
      asset('widget/credentials-widget.css', 'text/css; charset=utf-8'),
    )

    ctx.log.info('统一账号已启动', { accounts: accounts.length, systems: systems.length })
  },
})
