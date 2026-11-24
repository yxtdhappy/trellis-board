import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPlugin } from '@trellis-board/server/plugins/sdk.js'
import { ApiError, createWitopsClient } from './witops-client.js'
import { createSession, resolveAuthMode } from './auth.js'
import { createTeamSession } from './team-auth.js'
import { createLinkIndex } from './links.js'
import { createDispatch } from './dispatch.js'
import { resolveRequirement } from './mapper.js'
import {
  buildTaskFilters,
  groupByRequirement,
  normalizeTeamTasks,
  sanitizePreferences,
} from './team-view.js'
import {
  asPositiveInt,
  calendarDate,
  detailOf,
  flattenTree,
  normalizeId,
  normalizeStatus,
  numberOrNull,
  pick,
  statusLabel,
  text,
} from './util.js'

const BASE_DIR = path.dirname(fileURLToPath(import.meta.url))

const DEFAULTS = {
  // 内置默认平台地址：宿主 plugins.json 里的 config.baseUrl 仍然优先覆盖。
  baseUrl: 'http://witops.weintdata.cn',
  gatewayPrefix: '/appgw',
  taskServicePrefix: '/weint-witops-service',
  adminServicePrefix: '/system-mng',
  webRoot: 'weint-witops-web',
  platform: 'MOM_WEB',
  path: '/weint-witops-web/dashboard/mine',
  repositoryId: '',
  userId: null,
  assignedToUserId: null,
  assignee: '',
  developerMap: {},
  skipIfNoAssignee: true,
  types: [0, 2, 3, 4],
  type: 4,
  status: '1,3',
  pageSize: 50,
  categoryScanSize: 200,
  maxItems: 200,
  maxPerSync: 50,
  cacheTtlMs: 60_000,
  requestIntervalMs: 200,
  retries: 2,
  timeoutMs: 20_000,
  keepRaw: false,
  agentId: null,
  credentialSource: 'auto',
  accountSystemId: 'witops',
  accountSystemName: 'WitOps',
  credentials: { mode: 'password', account: '', password: '', token: '' },
  session: { persist: true },
  poll: { enabled: false, intervalMs: 1_800_000 },
}

function normalizeConfig(raw = {}) {
  const credentials = { ...DEFAULTS.credentials, ...(raw.credentials ?? {}) }
  credentials.mode = resolveAuthMode(credentials)
  return {
    ...DEFAULTS,
    ...raw,
    credentials,
    session: { ...DEFAULTS.session, ...(raw.session ?? {}) },
    poll: { ...DEFAULTS.poll, ...(raw.poll ?? {}) },
    developerMap: raw.developerMap && typeof raw.developerMap === 'object' ? raw.developerMap : {},
  }
}

export default createPlugin({
  name: 'witops-core',
  version: '2.0.0',
  apiVersion: 1,
  permissions: [
    'capabilities:provide',
    'tasks:read',
    'tasks:write',
    'store',
    'events',
    'http:route',
    'panels',
    'schedule',
    'runs:read',
    'runs:write',
    'secrets:read',
    'secrets:write',
    'capabilities:call',
  ],

  async onStart(ctx, rawConfig) {
    const config = normalizeConfig({ ...rawConfig, ...(ctx.config ?? {}) })
    let accountCredential = null
    let accountsError = ''
    let accountsAvailable = false

    // 统一账号优先：成功则覆盖 config.credentials，失败按 credentialSource 回退本地。
    // 先算结果再一次性提交，避免事件回包期间状态短暂变空。
    let refreshSeq = 0
    async function refreshAccounts({ reason = 'startup' } = {}) {
      const seq = ++refreshSeq
      let next = null
      let error = ''
      if (config.credentialSource !== 'local') {
        try {
          const result = await ctx.capabilities.call('accounts.credentials', 'credential.resolve', {
            system: config.accountSystemId,
          })
          next = {
            accountId: text(result?.accountId),
            account: text(result?.username),
            password: text(result?.password),
            baseUrl: text(result?.baseUrl),
          }
        } catch (caught) {
          error = caught?.message || String(caught)
        }
      }
      if (seq !== refreshSeq) return
      accountCredential = next
      accountsError = error
      // 只有 accounts-core 未运行/能力不可用/系统未配置时视为“不展示统一账号”；
      // 系统已配置但未绑定账号仍算可用，面板会提示去绑定。
      const unavailable =
        /未运行|capability 不可用|CAPABILITY_UNAVAILABLE|系统不存在|系统已禁用/.test(error)
      accountsAvailable = Boolean(next) || (Boolean(error) && !unavailable)
      if (!next) {
        if (error) {
          ctx.log.info('统一账号不可用，按配置回退', {
            source: config.credentialSource,
            error,
            reason,
          })
        }
        return
      }
      config.credentials.account = next.account
      config.credentials.password = next.password
      config.credentials.mode = 'password'
      if (next.baseUrl) config.baseUrl = next.baseUrl
      ctx.log.info('统一账号凭据已生效', {
        system: config.accountSystemId,
        account: next.accountId,
        reason,
      })
    }

    await refreshAccounts()
    const client = createWitopsClient(config)
    const teamMode = ctx.mode === 'team'
    // team 下 token 由宿主按用户保管，插件通过 ctx.currentCredential() 读取；
    // standalone 仍走原来的账号密码/session 持久化逻辑。
    const session = teamMode
      ? createTeamSession({ ctx, client })
      : createSession({ ctx, config, client })
    const links = createLinkIndex({ ctx, config })
    const readCache = new Map()
    const groupStoryCaches = new Map()
    let dispatch = null
    const READ_CACHE_MAX_ENTRIES = 400
    const READ_CACHE_MAX_PER_SCOPE = 80
    const storyIndexCaches = new Map()
    const storyIndexPromises = new Map()

    // Team 模式同一进程服务多个用户：读缓存必须按 actor 分区，
    // 否则 A 的 /project-tasks 会命中 B 的缓存。standalone 保持单命名空间。
    function cacheScope() {
      if (!teamMode) return 'local'
      const userId = text(ctx.currentActor?.()?.userId)
      return userId ? `user:${userId}` : null
    }

    function scopedKey(key) {
      const scope = cacheScope()
      return scope ? `${scope}\u0000${key}` : null
    }

    function clearScopedKeys(store, scope) {
      for (const key of [...store.keys()]) {
        if (key.startsWith(`${scope}\u0000`)) store.delete(key)
      }
    }

    function clearStoryCaches(scope) {
      for (const store of [storyIndexCaches, storyIndexPromises, groupStoryCaches]) {
        for (const key of [...store.keys()]) {
          if (key === scope || key.startsWith(`${scope}\u0000`)) store.delete(key)
        }
      }
    }

    function trimReadCache(scope) {
      if (scope) {
        let count = 0
        for (const key of [...readCache.keys()]) {
          if (!key.startsWith(`${scope}\u0000`)) continue
          count += 1
          if (count > READ_CACHE_MAX_PER_SCOPE) readCache.delete(key)
        }
      }
      while (readCache.size > READ_CACHE_MAX_ENTRIES) {
        readCache.delete(readCache.keys().next().value)
      }
    }

    /** 只清当前用户（Team 模式）的缓存；拿不到 actor 时不清，避免误伤其他用户。 */
    function clearReadCache() {
      const scope = cacheScope()
      if (!scope) return
      clearScopedKeys(readCache, scope)
      clearStoryCaches(scope)
    }

    function resetAllCaches() {
      readCache.clear()
      groupStoryCaches.clear()
      storyIndexCaches.clear()
      storyIndexPromises.clear()
    }

    // 统一账号变更后重算凭据（下次 ensureToken 用新密码登录），并丢掉旧缓存。
    ctx.events.on('accounts-core/changed', async () => {
      await refreshAccounts({ reason: 'accounts-changed' })
      resetAllCaches()
    })

    function cached(key) {
      const scoped = scopedKey(key)
      if (!scoped) return null
      const entry = readCache.get(scoped)
      if (!entry) return null
      if (Date.now() - entry.at > Number(config.cacheTtlMs || 0)) {
        readCache.delete(scoped)
        return null
      }
      return entry.value
    }

    function remember(key, value) {
      const scoped = scopedKey(key)
      if (!scoped) return value
      readCache.set(scoped, { at: Date.now(), value })
      trimReadCache(cacheScope())
      return value
    }

    dispatch = createDispatch({
      ctx,
      config,
      client,
      session,
      links,
      onChanged: () => clearReadCache(),
    })

    // 与 witops-web 的 detailTypes 一致：0 工单 / 2 缺陷 / 3 需求 / 4 任务。
    const ITEM_KINDS = {
      0: { kind: 'workOrder', label: '工单' },
      1: { kind: 'release', label: '发版单' },
      2: { kind: 'bug', label: '缺陷' },
      3: { kind: 'requirement', label: '需求' },
      4: { kind: 'task', label: '任务' },
    }
    const ALLOWED_TYPES = [0, 2, 3, 4]
    const PRIORITY_LABELS = { 1: 'P0', 2: 'P1', 3: 'P2', 4: 'P3' }

    function itemKind(type) {
      return ITEM_KINDS[type] ?? { kind: 'task', label: `类型 ${type}` }
    }

    function parseTypeList(value) {
      const raw = Array.isArray(value) ? value : text(value).split(',')
      return raw
        .map((part) => text(part))
        .filter(Boolean)
        .map((part) => Number(part))
        .filter((code) => Number.isInteger(code) && ALLOWED_TYPES.includes(code))
    }

    function normalizeFilters(input = {}) {
      const filters = {}
      for (const key of ['code', 'name', 'priority', 'status', 'categories', 'iterationId']) {
        const value = input[key]
        if (Array.isArray(value)) {
          const joined = value
            .map((part) => text(part))
            .filter(Boolean)
            .join(',')
          if (joined) filters[key] = joined
        } else if (text(value)) {
          filters[key] = text(value)
        }
      }
      if (input.allUsers === true || input.allUsers === '1' || input.allUsers === 1) {
        filters.assignedToUserId = 'all'
      } else if (text(input.assignedToUserId)) {
        filters.assignedToUserId = text(input.assignedToUserId)
      }
      return filters
    }

    function rowsOf(payload) {
      if (Array.isArray(payload)) return payload
      const rows = pick(payload, 'records', 'list', 'rows', 'data', 'items')
      return Array.isArray(rows) ? rows : []
    }

    function normalizeProjectList(payload) {
      return rowsOf(payload)
        .map((row) => ({
          id: text(pick(row, 'id', 'projectId', 'businessId')),
          name: text(pick(row, 'name', 'projectName', 'title')),
          code: text(pick(row, 'code', 'projectCode')),
          status: text(pick(row, 'statusName', 'status')),
        }))
        .filter((row) => row.id && row.name)
    }

    function normalizeProjectTasks(payload, options) {
      return normalizeTeamTasks(payload, options)
    }

    /** 面板行附上跳转链接：点标题直接开 WitOps 详情页。 */
    function withPanelLink(item) {
      return { ...item, url: itemLink(item.type, item.id) }
    }

    function itemLink(type, id) {
      const webRoot = text(config.webRoot).replace(/^\/+|\/+$/g, '')
      if (!config.baseUrl) return ''
      return `${String(config.baseUrl).replace(/\/+$/, '')}/#/${webRoot}/commonDetail/nodeTaskDetail/${type}/${id}`
    }

    function normalizeItem(record) {
      const type = numberOrNull(record?.type) ?? 4
      const id = normalizeId(pick(record, 'businessId', 'sourceId', 'id'))
      const requirement = resolveRequirement(record)
      const kind = itemKind(type)
      const priorityCode = numberOrNull(
        pick(record, 'priorityDicConfigCode', 'priorityCode', 'priority'),
      )
      return {
        kind: kind.kind,
        kindLabel: kind.label,
        type,
        typeName: text(pick(record, 'typeName')) || kind.label,
        id,
        code: text(pick(record, 'code', 'businessCode')) || id,
        title: text(pick(record, 'name', 'title')),
        status: statusLabel(
          pick(record, 'sourceStatusName', 'statusName', 'sourceStatus', 'status'),
        ),
        priority:
          text(pick(record, 'priorityName', 'priority')) || PRIORITY_LABELS[priorityCode] || '',
        category: text(pick(record, 'taskCategoryName', 'categoryDicConfigName', 'category')),
        categoryCode: text(pick(record, 'categoryDicConfigCode', 'categoryCode')),
        module: text(pick(record, 'projectModuleName', 'moduleName')),
        iteration: text(pick(record, 'iterationName', 'sprintName')),
        assignee: text(pick(record, 'assignedToUserName', 'assigneeName', 'assignee')),
        dueDate: calendarDate(
          pick(
            record,
            'expectCompleteTime',
            'expectFinishTime',
            'expectEndTime',
            'deadline',
            'planEndTime',
          ),
        ),
        mentionTime: text(pick(record, 'mentionTime')),
        storyId: requirement ? requirement.id : null,
        storyCode: requirement ? requirement.code : null,
        storyName: requirement && requirement.name ? requirement.name : null,
        storyUrl: requirement ? itemLink(3, requirement.id) : '',
        url: itemLink(type, id),
      }
    }

    async function mine({ types, filters, force = false } = {}) {
      const wanted = parseTypeList(types).length
        ? parseTypeList(types)
        : parseTypeList(config.types)
      const activeTypes = wanted.length ? wanted : [3, 4]
      const activeFilters = normalizeFilters(filters)
      const key = `mine:${activeTypes.join(',')}:${JSON.stringify(activeFilters)}`
      if (!force) {
        const hit = cached(key)
        if (hit) return hit
      }
      const items = []
      const seen = new Set()
      for (const type of activeTypes) {
        let current = 1
        let pages = 1
        while (current <= pages && items.length < Number(config.maxItems || 200)) {
          const page = await dispatch.fetchPage({
            type,
            page: current,
            filters: activeFilters,
          })
          pages = Math.max(1, page.pages)
          for (const record of page.records) {
            if (items.length >= Number(config.maxItems || 200)) break
            const item = normalizeItem(record)
            const itemId = `${item.type}:${item.id}`
            if (!item.id || seen.has(itemId)) continue
            seen.add(itemId)
            items.push(item)
          }
          current += 1
        }
      }
      for (const item of items) item.trellisTasks = await links.forItem(item)
      return remember(key, {
        userId: await session.resolveUserId(),
        items,
        types: activeTypes,
        filters: activeFilters,
        fetchedAt: new Date().toISOString(),
      })
    }

    function normalizeRequirement(detail, fallbackId) {
      const id = normalizeId(pick(detail, 'businessId', 'sourceId', 'id')) || fallbackId
      return {
        id,
        code: text(pick(detail, 'code', 'businessCode')) || id,
        title: text(pick(detail, 'name', 'title')),
        status: normalizeStatus(
          pick(detail, 'sourceStatusName', 'statusName', 'sourceStatus', 'status'),
        ),
        priority: text(pick(detail, 'priorityDicConfigCode', 'priorityName', 'priority')),
        assignee: text(pick(detail, 'assignedToUserName', 'assigneeName', 'assignee')),
        description: text(pick(detail, 'description', 'content')),
        url: itemLink(3, id),
      }
    }

    function normalizeStory(record, fallbackCode = '') {
      const id = normalizeId(pick(record, 'businessId', 'sourceId', 'id'))
      const value = normalizeRequirement(record, id)
      value.id = id
      value.code = text(pick(record, 'code', 'businessCode')) || fallbackCode || id
      return value
    }

    function storyRecords(data) {
      return Array.isArray(data) ? data : (data?.records ?? data?.list ?? [])
    }

    async function buildStoryIndex() {
      const index = new Map()
      let current = 1
      let pages = 1
      while (current <= Math.min(pages, 10)) {
        const data = await session.authorized((token) =>
          client.storyPage({ current, size: 200 }, { token }),
        )
        const records = storyRecords(data)
        for (const record of records) {
          const story = normalizeStory(record)
          if (story.id) index.set(story.id, story)
        }
        pages = Math.max(1, Number(data?.pages ?? 1))
        if (records.length < 200) break
        current += 1
      }
      return index
    }

    async function loadStoryIndex() {
      const scope = cacheScope()
      // 拿不到 actor（Team 模式）时只请求不写缓存，避免把某个用户的数据写给下一个请求。
      if (!scope) return buildStoryIndex()
      const hit = storyIndexCaches.get(scope)
      if (hit && Date.now() - hit.at <= Number(config.cacheTtlMs || 0)) {
        return hit.value
      }
      const pending = storyIndexPromises.get(scope)
      if (pending) return pending
      const promise = buildStoryIndex()
        .then((index) => {
          storyIndexCaches.set(scope, { at: Date.now(), value: index })
          return index
        })
        .finally(() => storyIndexPromises.delete(scope))
      storyIndexPromises.set(scope, promise)
      return promise
    }

    function codeKey(value) {
      const match = /REQ[-_ ]?(\d+)/i.exec(text(value))
      return match ? `REQ-${Number(match[1])}` : text(value).toUpperCase()
    }

    function titleKey(value) {
      return text(value).replace(/\s+/g, '').toLowerCase()
    }

    function storyMatches(story, code, title) {
      const wantedCode = codeKey(code)
      if (wantedCode && (codeKey(story.code) === wantedCode || codeKey(story.id) === wantedCode)) {
        return true
      }
      return Boolean(title) && titleKey(story.title) === titleKey(title)
    }

    function storyRank(record, story, code, title) {
      let score = 0
      const wantedCode = codeKey(code)
      if (wantedCode && (codeKey(story.code) === wantedCode || codeKey(story.id) === wantedCode)) {
        score += 1000
      }
      if (title && titleKey(story.title) === titleKey(title)) score += 200
      if (record?.draftSourceId) score -= 500
      if (/草稿/.test(text(record?.sourceStatusName ?? record?.statusName ?? story.status))) {
        score -= 200
      }
      if (record?.detailData === true) score += 50
      if (story.id) score += 20
      if (story.assignee) score += 10
      if (record?.flowInstance) score += 10
      return score
    }

    async function resolveOne(code, title) {
      const key = `resolve:${text(code).toUpperCase()}:${text(title)}`
      const hit = cached(key)
      if (hit) return hit
      const queries = []
      if (text(title)) queries.push({ name: text(title) })
      else if (text(code)) queries.push({ code: text(code) })
      for (const query of queries) {
        try {
          const data = await session.authorized((token) =>
            client.storyPage({ current: 1, size: 50, ...query }, { token }),
          )
          let best = null
          for (const record of storyRecords(data)) {
            const story = normalizeStory(record, code)
            if (!storyMatches(story, code, title)) continue
            const rank = storyRank(record, story, code, title)
            if (!best || rank > best.rank) best = { story, rank }
          }
          if (best) return remember(key, best.story)
        } catch (error) {
          if (error?.authExpired) throw error
          ctx.log.warn('需求查询失败', {
            code,
            query: Object.keys(query).join(','),
            message: error.message,
          })
        }
      }
      if (text(title)) return null
      const index = await loadStoryIndex()
      for (const story of index.values()) {
        if (storyMatches(story, code, title)) return remember(key, story)
      }
      return null
    }

    function compactRequirement(value) {
      const rest = { ...value }
      delete rest.description
      return rest
    }

    async function resolveRequirements(params) {
      const input = (Array.isArray(params?.items) ? params.items : []).slice(0, 100)
      const resolved = input.map(() => null)
      let cursor = 0
      const worker = async () => {
        while (cursor < input.length) {
          const index = cursor
          cursor += 1
          const entry = input[index]
          const code = text(entry?.code)
          const title = text(entry?.title)
          if (!code && !title) {
            resolved[index] = { missing: { code, title, error: '缺少编号或标题' } }
            continue
          }
          try {
            const story = await resolveOne(code, title)
            resolved[index] = story
              ? { item: { ...compactRequirement(story), sourceCode: code, sourceTitle: title } }
              : { missing: { code, title, error: '未找到 需求' } }
          } catch (error) {
            resolved[index] = { missing: { code, title, error: error.message } }
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(6, input.length) }, worker))
      return {
        items: resolved.filter((entry) => entry?.item).map((entry) => entry.item),
        missing: resolved.filter((entry) => entry?.missing).map((entry) => entry.missing),
      }
    }

    async function requirement(id) {
      const key = `requirement:${id}`
      const hit = cached(key)
      if (hit) return hit
      const raw = await session.authorized((token) => client.story({ id, type: 3 }, { token }))
      return remember(key, normalizeRequirement(detailOf(raw), id))
    }

    async function tree(id) {
      const key = `tree:${id}`
      const hit = cached(key)
      if (hit) return hit
      const raw = await session.authorized((token) => client.tree({ id, type: 3 }, { token }))
      const root = detailOf(raw)
      const nodes = flattenTree(root)
      const tasks = nodes.slice(1).filter((node) => node.type === 4 || node.type === 3)
      const totalHours =
        Number(root.childrenTotalWorkHour ?? 0) ||
        tasks.reduce((sum, node) => sum + Number(node.hours || 0), 0)
      const value = {
        requirement: compactRequirement(normalizeRequirement(root, id)),
        tasks,
        totalHours,
      }
      return remember(key, value)
    }

    async function taskDetail(id) {
      const raw = await session.authorized((token) => client.detail({ id, type: 4 }, { token }))
      const detail = detailOf(raw)
      const taskId = normalizeId(pick(detail, 'businessId', 'sourceId', 'id')) || id
      return {
        id: taskId,
        requirementId: normalizeId(pick(detail, 'parentId', 'storyId', 'requirementId')) || null,
        code: text(pick(detail, 'code', 'businessCode')) || taskId,
        title: text(pick(detail, 'name', 'title')),
        status: normalizeStatus(
          pick(detail, 'sourceStatusName', 'statusName', 'sourceStatus', 'status'),
        ),
        assignee: text(pick(detail, 'assignedToUserName', 'assigneeName', 'assignee')),
        hours: Number(detail.inputWorkHour ?? 0) || 0,
        description: text(pick(detail, 'description', 'content')),
        url: itemLink(4, taskId),
      }
    }

    async function requirementQuery(ids) {
      const wanted = [
        ...new Set((Array.isArray(ids) ? ids : []).map(normalizeId).filter(Boolean)),
      ].slice(0, 200)
      const items = []
      for (const id of wanted) {
        try {
          items.push(compactRequirement(await requirement(id)))
        } catch (error) {
          items.push({ id, error: error.message })
        }
      }
      return { items }
    }

    async function tasksByRequirement(requirementIds) {
      const wanted = [
        ...new Set(
          (Array.isArray(requirementIds) ? requirementIds : []).map(normalizeId).filter(Boolean),
        ),
      ].slice(0, 100)
      const items = []
      for (const id of wanted) {
        try {
          const value = await tree(id)
          items.push({ requirementId: id, tasks: value.tasks })
        } catch (error) {
          items.push({ requirementId: id, tasks: [], error: error.message })
        }
      }
      return { items }
    }

    async function worklogSummary(ids) {
      const wanted = [
        ...new Set((Array.isArray(ids) ? ids : []).map(normalizeId).filter(Boolean)),
      ].slice(0, 100)
      const items = []
      for (const id of wanted) {
        try {
          const value = await tree(id)
          items.push({ id, totalHours: value.totalHours })
        } catch (error) {
          items.push({ id, totalHours: 0, error: error.message })
        }
      }
      return { items }
    }

    async function updateRequirementStatus(params) {
      const id = normalizeId(params?.id)
      if (!id) throw ctx.error(1002, '缺少需求 id')
      const status = params?.status
      const data = await session.authorized((token) =>
        client.storyUpdate(
          {
            id,
            sourceStatus: status,
            status,
            ...(params?.comment ? { comment: params.comment } : {}),
          },
          { token },
        ),
      )
      clearReadCache()
      return { id, status, result: data ?? null }
    }

    async function updateTaskStatus(params) {
      const id = normalizeId(params?.id)
      if (!id) throw ctx.error(1002, '缺少任务 id')
      const status = params?.status
      const data = await session.authorized((token) =>
        client.taskUpdate(
          {
            id,
            sourceStatus: status,
            status,
            ...(params?.comment ? { comment: params.comment } : {}),
          },
          { token },
        ),
      )
      clearReadCache()
      return { id, status, result: data ?? null }
    }

    async function assignTask(params) {
      const id = normalizeId(params?.id)
      if (!id) throw ctx.error(1002, '缺少任务 id')
      const assigneeId = numberOrNull(params?.assigneeId)
      if (assigneeId === null) throw ctx.error(1002, '缺少 assigneeId')
      const data = await session.authorized((token) =>
        client.taskUpdate(
          {
            id,
            assignedToUserId: assigneeId,
          },
          { token },
        ),
      )
      clearReadCache()
      return { id, assigneeId, result: data ?? null }
    }

    async function previewMany(params = {}) {
      const items = dispatch.normalizeItems(params).slice(0, 50)
      if (!items.length) throw ctx.error(1002, '需要 items / businessIds / businessId')
      const results = []
      for (const item of items) {
        try {
          results.push({ ...item, ...(await dispatch.previewOne(item)) })
        } catch (error) {
          if (error?.authExpired) throw error
          results.push({ ...item, status: 'failed', reason: error.message })
        }
      }
      return { results }
    }

    async function authStatus() {
      return {
        ...session.status(),
        hasStoredPassword: await session.hasStoredPassword(),
        credentialSource: accountCredential ? 'accounts' : 'local',
        accountSystemId: config.accountSystemId,
        accountsError: accountsError || null,
      }
    }

    ctx.capabilities.register('witops.workitems', {
      mine: (params) => mine({ types: params?.types, force: params?.force === true }),
      'requirement.get': (params) => requirement(normalizeId(params?.id)),
      'requirement.query': (params) => requirementQuery(params?.ids),
      'requirement.resolve': (params) => resolveRequirements(params),
      'requirement.tree': (params) => tree(normalizeId(params?.id)),
      'task.listByRequirement': (params) => tasksByRequirement(params?.requirementIds),
      'task.get': (params) => taskDetail(normalizeId(params?.id)),
    })

    ctx.capabilities.register('witops.worklogs', {
      summary: (params) => worklogSummary(params?.ids),
    })

    ctx.capabilities.register('witops.actions', {
      'requirement.updateStatus': updateRequirementStatus,
      'task.updateStatus': updateTaskStatus,
      'task.assign': assignTask,
    })

    ctx.capabilities.register('witops.dispatch', {
      preview: (params) => previewMany(params),
      'task.create': (params) =>
        dispatch.createOne({
          type: params?.type,
          businessId: normalizeId(params?.businessId ?? params?.id),
          repositoryId: params?.repositoryId,
          baseBranch: params?.baseBranch,
          priority: params?.priority,
          assignee: params?.assignee,
          rememberBinding: params?.rememberBinding,
          includeChildren: params?.includeChildren,
        }),
      'developers.list': (params) =>
        dispatch.listDevelopers({ repositoryId: params?.repositoryId }),
      'developer.bind': (params) => dispatch.bindDeveloper(params ?? {}),
      'task.batchCreate': (params) => dispatch.createBatch(dispatch.normalizeItems(params ?? {})),
      'task.syncRecent': (params) =>
        dispatch.syncRecent({ size: params?.size, repositoryId: params?.repositoryId }),
      'imported.list': (params) => dispatch.importedList({ limit: params?.limit }),
      'auth.login': async (params) => {
        await session.login({
          account: params?.account,
          password: params?.password,
          remember: params?.remember === true,
          source: 'panel',
        })
        return authStatus()
      },
      'auth.logout': () => session.logout(),
      'auth.status': () => authStatus(),
    })

    function respond(status, body, type = 'application/json; charset=utf-8') {
      return { status, headers: { 'content-type': type }, body }
    }

    /** 平台 ID 多数是数字串，但项目白名单偶尔给字符串 id，统一按“能转就转”处理。 */
    function numericId(value) {
      const raw = text(value)
      return /^\d+$/.test(raw) ? Number(raw) : raw
    }

    // 空间分类：产品空间（RD***）和项目空间（PS***）用的是两套查询键，
    // 混着传不会报错，只会老老实实返回 0 条（RD411-2602 空列表就是这么来的）。
    // /project/list?type=0 是产品、type=2 是项目，两份清单缓存 10 分钟。
    const spaceKinds = new Map()
    const SPACE_KIND_TTL = 10 * 60 * 1000

    function rememberSpaceKind(id, kind) {
      const key = text(id)
      if (key) spaceKinds.set(key, { kind, at: Date.now() })
    }

    async function resolveSpaceKinds(ids) {
      const now = Date.now()
      const stale = ids.filter((id) => {
        const hit = spaceKinds.get(text(id))
        return !hit || now - hit.at > SPACE_KIND_TTL
      })
      if (stale.length) {
        const [products, projects] = await session.authorized((token) =>
          Promise.all([
            client.projects({ type: 0, size: 10000 }, { token }).catch(() => null),
            client.projects({ type: 2, size: 10000 }, { token }).catch(() => null),
          ]),
        )
        for (const [kind, payload] of [
          ['product', products],
          ['project', projects],
        ]) {
          for (const row of rowsOf(payload)) {
            rememberSpaceKind(pick(row, 'id', 'projectId'), kind)
          }
        }
      }
      return ids.map((id) => spaceKinds.get(text(id))?.kind ?? null)
    }

    async function planSpaceQueries(ids, explicit) {
      if (explicit === '0') return [{ kind: 'product', ids }]
      if (explicit === '2') return [{ kind: 'project', ids }]
      let kinds = await resolveSpaceKinds(ids).catch(() => ids.map(() => null))
      const unknown = ids.filter((_, index) => !kinds[index])
      if (unknown.length) {
        // 分类表不可用（接口失败/新建空间）：逐个 id 探一次，探到的结果同样缓存 10 分钟。
        // 探测故意不带筛选、size=1：只要看哪个空间键能命中，避免被筛选条件误导。
        await session
          .authorized(async (token) => {
            for (const id of unknown) await probeSpaceKind(id, token)
          })
          .catch(() => {})
        kinds = await resolveSpaceKinds(ids).catch(() => ids.map(() => null))
      }
      const buckets = { product: [], project: [] }
      ids.forEach((id, index) =>
        buckets[kinds[index] === 'product' ? 'product' : 'project'].push(id),
      )
      const plan = []
      if (buckets.product.length) plan.push({ kind: 'product', ids: buckets.product })
      if (buckets.project.length) plan.push({ kind: 'project', ids: buckets.project })
      return plan
    }

    async function probeSpaceKind(id, token) {
      const probe = (kind) => fetchSpacePage(kind, [id], { page: 1, size: 1, filters: {} }, token)
      const product = await probe('product')
      if (Number(product?.total ?? 0)) return rememberSpaceKind(id, 'product')
      const project = await probe('project')
      if (Number(project?.total ?? 0)) return rememberSpaceKind(id, 'project')
      return null
    }

    function fetchSpacePage(kind, ids, { page, size, filters }, token) {
      const singular = kind === 'product' ? 'productId' : 'projectId'
      const plural = kind === 'product' ? 'productIds' : 'projectIds'
      const key = ids.length === 1 ? singular : plural
      const value = ids.length === 1 ? numericId(ids[0]) : ids.map(numericId).join(',')
      const body = { current: page, size, last: 'true', ...filters, [key]: value }
      return client.projectTaskPage(body, { token })
    }

    // 任务行只带 parentCode/parentName，需求表头要的优先级/状态/负责人/截止只在 /story/page 里。
    // 按空间拉一份需求索引缓存 60 秒：翻页、改筛选不会反复打平台。
    const GROUP_STORY_TTL = 60 * 1000
    const GROUP_STORY_MAX_PER_SCOPE = 24
    const GROUP_STORY_MAX_SCOPES = 50
    const STORY_PAGE_SIZE = 200
    const STORY_PAGE_MAX = 3

    // 按 actor 分桶：bucket 的 key 是用户范围，内层是空间组合。
    function groupStoryBucket(scope) {
      const existing = groupStoryCaches.get(scope)
      if (existing) return existing
      if (groupStoryCaches.size >= GROUP_STORY_MAX_SCOPES) {
        groupStoryCaches.delete(groupStoryCaches.keys().next().value)
      }
      const bucket = new Map()
      groupStoryCaches.set(scope, bucket)
      return bucket
    }

    async function fetchGroupStoryRows(step, token) {
      // 需求列表和任务列表用同一套空间键：产品空间 projectProductId(s)，项目空间 projectId(s)。
      const singular = step.kind === 'product' ? 'projectProductId' : 'projectId'
      const plural = step.kind === 'product' ? 'projectProductIds' : 'projectIds'
      const key = step.ids.length === 1 ? singular : plural
      const value =
        step.ids.length === 1 ? numericId(step.ids[0]) : step.ids.map(numericId).join(',')
      const rows = []
      let current = 1
      let total = 0
      while (current <= STORY_PAGE_MAX) {
        const data = await client.storyPage(
          { current, size: STORY_PAGE_SIZE, last: 'true', [key]: value },
          { token },
        )
        const page = rowsOf(data)
        total = Number(data?.total ?? page.length)
        rows.push(...page)
        if (page.length < STORY_PAGE_SIZE || rows.length >= total) break
        current += 1
      }
      return rows
    }

    async function loadGroupStoryIndex(plan) {
      const cacheKey = plan.map((step) => `${step.kind}:${step.ids.join(',')}`).join('|')
      const scope = cacheScope()
      const bucket = scope ? groupStoryBucket(scope) : null
      const hit = bucket?.get(cacheKey)
      if (hit && Date.now() - hit.at < GROUP_STORY_TTL) return hit.map
      const map = new Map()
      await session.authorized(async (token) => {
        for (const step of plan) {
          for (const row of await fetchGroupStoryRows(step, token)) {
            const [story] = normalizeProjectTasks({ records: [row] })
            if (story?.id) map.set(text(story.id), story)
          }
        }
      })
      if (bucket) {
        bucket.delete(cacheKey)
        bucket.set(cacheKey, { at: Date.now(), map })
        while (bucket.size > GROUP_STORY_MAX_PER_SCOPE) {
          bucket.delete(bucket.keys().next().value)
        }
      }
      return map
    }

    /** 给需求分组补上优先级/状态/负责人/截止；拿不到就保留原来的空列。 */
    async function enrichRequirements(groups, plan) {
      const ids = groups.map((group) => text(group.requirement?.id)).filter(Boolean)
      if (!ids.length) return
      const index = await loadGroupStoryIndex(plan)
      for (const group of groups) {
        const story = index.get(text(group.requirement?.id))
        if (!story) continue
        group.requirement = { ...group.requirement, ...pickStoryFields(story, group.requirement) }
      }
    }

    function pickStoryFields(story, current) {
      return {
        priority: story.priority || current.priority,
        priorityCode: story.priorityCode ?? current.priorityCode,
        status: story.status || current.status,
        statusCode: story.statusCode ?? current.statusCode,
        assignee: story.assignee || current.assignee,
        assigneeId: story.assigneeId || current.assigneeId,
        dueDate: story.dueDate || current.dueDate,
        projectId: story.projectId || current.projectId,
      }
    }

    function failure(error, fallbackStatus = 502) {
      let status = fallbackStatus
      if (error?.code === 1001) status = 401
      else if (error?.code === 1002) status = 400
      // PluginError 把细节放在 detail 上；宿主靠 detail.reason 区分"密码错"和"连接断开"。
      const detail = error?.detail ?? error?.data ?? null
      return respond(status, { error: error.message, code: error.code ?? null, detail })
    }

    function asset(name, type) {
      try {
        return respond(200, fs.readFileSync(path.join(BASE_DIR, 'panel', name), 'utf8'), type)
      } catch {
        return respond(404, { error: 'not found' })
      }
    }

    ctx.http.route('GET', '/panel', () =>
      asset(teamMode ? 'team.html' : 'index.html', 'text/html; charset=utf-8'),
    )
    ctx.http.route('GET', '/panel/app.js', () => asset('app.js', 'text/javascript; charset=utf-8'))
    ctx.http.route('GET', '/panel/app.css', () => asset('app.css', 'text/css; charset=utf-8'))
    if (teamMode) {
      ctx.http.route('GET', '/panel/team.js', () =>
        asset('team.js', 'text/javascript; charset=utf-8'),
      )
    }

    if (teamMode) {
      // 宿主调用：账号密码只在这一个路由里出现，换完 token 立即丢弃。
      ctx.http.route('POST', '/session/open', async (request) => {
        const body = request.json() ?? {}
        try {
          return respond(
            200,
            await session.login({ account: body.account, password: body.password }),
          )
        } catch (error) {
          return failure(error)
        }
      })

      // 面板：我管理的 + 我参与的
      ctx.http.route('GET', '/project-space', async () => {
        try {
          const data = await session.authorized(async (token) => {
            const [managed, joined] = await Promise.all([
              client.projectByMaster({}, { token }).catch((error) => {
                if (error instanceof ApiError) throw error
                return null
              }),
              client.projectByParticipant({}, { token }),
            ])
            return {
              managed: normalizeProjectList(managed),
              joined: normalizeProjectList(joined),
            }
          })
          return respond(200, data)
        } catch (error) {
          return failure(error)
        }
      })

      // 面板：所选空间（可多选）下的任务列表。
      // 平台 POST /task/task/page 有两个坑，都用真实项目验证过：
      // 1. 产品空间（RD***）只认 productId/productIds，项目空间（PS***）只认 projectId/projectIds，
      //    传错键不报错，直接返回 0 条；所以先按 /project/list 分类，再分组查询合并。
      // 2. `types` 在 PageTaskReq 里是业务类型（0/1/5...），不是 需求3/任务4/缺陷2，
      //    传 3/4/2 会把结果筛成 0，因此这里不再下发（类型由面板按行展示）。
      // last:'true' 表示只看当前版本（与 witops-web 项目空间任务列表一致）。
      // 返回里同时给扁平 items 和按需求分组好的 groups：分组是纯函数，放服务端只为让面板少算一遍。
      ctx.http.route('GET', '/project-tasks', async (request) => {
        try {
          const ids = text(request.query.projectIds)
            .split(',')
            .map((part) => text(part))
            .filter(Boolean)
            .slice(0, 20)
          const single = text(request.query.projectId)
          if (!ids.length && !single) return respond(400, { error: '缺少 projectId' })
          const wanted = ids.length ? ids : [single]
          const page = Math.max(1, asPositiveInt(request.query.page, 1))
          const size = Math.min(200, Math.max(1, asPositiveInt(request.query.size, 50)))
          const filters = buildTaskFilters(request.query)
          // type: '0' 产品空间 / '2' 项目空间；不传则按空间清单自动判断。
          const plan = await planSpaceQueries(wanted, text(request.query.type))
          const items = []
          let total = 0
          await session.authorized(async (token) => {
            for (const step of plan) {
              const data = await fetchSpacePage(step.kind, step.ids, { page, size, filters }, token)
              total += Number(data?.total ?? 0)
              for (const row of normalizeProjectTasks(data, { flatten: true })) {
                items.push(withPanelLink(row))
              }
            }
          })
          const unique = []
          const seen = new Set()
          for (const item of items) {
            const key = `${item.type}:${item.id}`
            if (seen.has(key)) continue
            seen.add(key)
            unique.push(item)
          }
          const groups = groupByRequirement(unique)
          await enrichRequirements(groups, plan).catch(() => {})
          return respond(200, { page, size, total, items: unique, groups })
        } catch (error) {
          return failure(error)
        }
      })

      // 面板：某个需求（或任务/缺陷）下的直接子项。展开时按需调用，面板侧做缓存。
      ctx.http.route('GET', '/children', async (request) => {
        try {
          const id = text(request.query.id)
          const type = numberOrNull(request.query.type) ?? 4
          if (!id) return respond(400, { error: '缺少 id' })
          const key = `children:${type}:${id}`
          const hit = cached(key)
          if (hit) return respond(200, { items: hit, cached: true })
          const data = await session.authorized((token) =>
            client.childTask({ id: numericId(id), type }, { token }),
          )
          const items = normalizeProjectTasks(data, { flatten: true }).map(withPanelLink)
          remember(key, items)
          return respond(200, { items, cached: false })
        } catch (error) {
          return failure(error)
        }
      })

      // 负责人下拉：一次拉一份用户清单，面板展开多选时用。
      // 普通成员可能没有 sysUser 权限，失败时返回空列表让面板退回到“已出现的人”。
      ctx.http.route('GET', '/users', async () => {
        const hit = cached('users')
        if (hit) return respond(200, { items: hit })
        try {
          const data = await session.authorized((token) =>
            client.userPage({ current: 1, size: 2000, status: 1 }, { token }),
          )
          const items = rowsOf(data)
            .map((row) => ({
              id: text(pick(row, 'id', 'userId')),
              name: text(pick(row, 'username', 'nickname', 'name', 'displayName')),
            }))
            .filter((row) => row.id && row.name)
          remember('users', items)
          return respond(200, { items })
        } catch (error) {
          return respond(200, { items: [], error: error.message, degraded: true })
        }
      })

      // 迭代下拉：/iteration/list，按选中的项目过滤；失败同样降级为空。
      ctx.http.route('GET', '/iterations', async (request) => {
        const projectId = text(request.query.projectId)
        const key = `iterations:${projectId}`
        const hit = cached(key)
        if (hit) return respond(200, { items: hit })
        try {
          const body = {}
          if (projectId) body.projectId = numericId(projectId)
          const data = await session.authorized((token) => client.iterations(body, { token }))
          const items = rowsOf(data)
            .map((row) => ({
              id: text(pick(row, 'id', 'iterationId')),
              name: text(pick(row, 'name', 'iterationName', 'title')),
            }))
            .filter((row) => row.id && row.name)
          remember(key, items)
          return respond(200, { items })
        } catch (error) {
          return respond(200, { items: [], error: error.message, degraded: true })
        }
      })
    }

    // 面板偏好：team 下 ctx.store 已按用户分区（user:<id>:<key>），
    // 面板 iframe 是 sandbox 无 same-origin，localStorage 会抛 SecurityError，所以落服务端。
    const PREFS_KEY = 'panel:preferences'
    const prefsAvailable =
      typeof ctx.store?.get === 'function' && typeof ctx.store?.set === 'function'

    ctx.http.route('GET', '/prefs', async () => {
      if (!prefsAvailable) return respond(200, { prefs: {} })
      try {
        const prefs = (await ctx.store.get(PREFS_KEY)) ?? {}
        return respond(200, { prefs })
      } catch (error) {
        return respond(200, { prefs: {}, error: error.message })
      }
    })

    ctx.http.route('PUT', '/prefs', async (request) => {
      if (!prefsAvailable) return respond(200, { prefs: {} })
      const body = request.json() ?? {}
      try {
        const current = (await ctx.store.get(PREFS_KEY)) ?? {}
        const next = {
          ...current,
          ...sanitizePreferences(body),
          updatedAt: new Date().toISOString(),
        }
        await ctx.store.set(PREFS_KEY, next)
        return respond(200, { prefs: next })
      } catch (error) {
        return respond(200, { prefs: {}, error: error.message })
      }
    })

    ctx.http.route('GET', '/mine', async (request) => {
      try {
        const data = await mine({
          types: parseTypeList(request.query.types),
          filters: {
            code: request.query.code,
            name: request.query.name,
            priority: request.query.priority,
            status: request.query.status,
            categories: request.query.categories,
            iterationId: request.query.iterationId,
            allUsers: request.query.allUsers === '1',
          },
          force: request.query.refresh === '1',
        })
        return respond(200, data)
      } catch (error) {
        return failure(error)
      }
    })

    ctx.http.route('GET', '/filters', async (request) => {
      try {
        return respond(
          200,
          await dispatch.loadFilterOptions({ force: request.query.refresh === '1' }),
        )
      } catch (error) {
        return failure(error)
      }
    })

    ctx.http.route('GET', '/tasks', async (request) => {
      try {
        const data = await dispatch.tasksPage({
          page: request.query.page,
          size: request.query.size,
          status: request.query.status || config.status,
          type: request.query.type || config.type,
        })
        return respond(200, data)
      } catch (error) {
        return failure(error)
      }
    })

    ctx.http.route('POST', '/refresh', async () => {
      clearReadCache()
      links.invalidate()
      await dispatch.loadDictionaries({ force: true })
      return respond(200, { ok: true })
    })

    ctx.http.route('GET', '/auth', async () => respond(200, await authStatus()))

    // 供统一账号小组件使用：只暴露凭据来源与账号名，不暴露密码。
    ctx.http.route('GET', '/credentials', async () => {
      // 启动顺序可能让 accounts-core 晚于本插件就绪；读取时懒重试一次。
      if (accountsError && config.credentialSource !== 'local') {
        await refreshAccounts({ reason: 'credentials-retry' })
      }
      return respond(200, {
        available: accountsAvailable,
        source: accountCredential ? 'accounts' : accountsAvailable ? 'none' : 'local',
        systemId: config.accountSystemId,
        systemName: config.accountSystemName,
        accountId: accountCredential?.accountId ?? '',
        username: text(config.credentials.account),
        hasPassword:
          Boolean(text(config.credentials.password)) || Boolean(await session.hasStoredPassword()),
        // 统一账号插件未运行时只是回退本地配置，不把内部 capability 错误抛给面板。
        error: accountsAvailable && accountsError ? accountsError : '',
      })
    })

    // 面板会话入口：team.js 用 /session 读写登录态。
    ctx.http.route('GET', '/session', async () => {
      const current = await authStatus()
      return respond(200, {
        online: current.status === 'authenticated',
        account: current.account ?? null,
        source: current.source,
        credentialSource: current.credentialSource,
      })
    })

    ctx.http.route('POST', '/session', async (request) => {
      const body = request.json() ?? {}
      if (!text(body.account) || !text(body.password)) {
        return respond(400, { error: '需要 account 与 password' })
      }
      try {
        await session.login({
          account: body.account,
          password: body.password,
          remember: body.remember === true,
          source: 'panel',
        })
        clearReadCache()
        return respond(200, { ok: true, auth: await authStatus() })
      } catch (error) {
        return failure(error, 502)
      }
    })

    ctx.http.route('DELETE', '/session', async () => {
      await session.logout()
      return respond(200, { ok: true })
    })

    ctx.http.route('POST', '/login', async (request) => {
      const body = request.json() ?? {}
      if (!text(body.account) || !text(body.password)) {
        return respond(400, { error: '需要 account 与 password' })
      }
      try {
        await session.login({
          account: body.account,
          password: body.password,
          remember: body.remember === true,
          source: 'panel',
        })
        clearReadCache()
        return respond(200, { ok: true, auth: await authStatus() })
      } catch (error) {
        return failure(error, 502)
      }
    })

    ctx.http.route('POST', '/logout', async () => {
      await session.logout()
      return respond(200, { ok: true, auth: await authStatus() })
    })

    ctx.http.route('GET', '/projects', async () => {
      try {
        const result = await ctx.capabilities.call('trellis.projects', 'list')
        const projects = await Promise.all(
          (result?.projects ?? []).map(async (project) => {
            const base = {
              repositoryId: project.repositoryId,
              name: project.name ?? project.repositoryId,
              path: project.path ?? null,
              branch: null,
              branches: [],
            }
            try {
              const info = await ctx.capabilities.call('trellis.projects', 'branches', {
                repositoryId: project.repositoryId,
              })
              return {
                ...base,
                branch: info?.branch ?? null,
                branches: Array.isArray(info?.branches) ? info.branches : [],
              }
            } catch (error) {
              ctx.log.warn('本地分支读取失败', {
                repositoryId: project.repositoryId,
                message: error.message,
              })
              return base
            }
          }),
        )
        return respond(200, {
          projects,
          defaultRepositoryId: text(config.repositoryId) || projects[0]?.repositoryId || null,
        })
      } catch (error) {
        return failure(error)
      }
    })

    ctx.http.route('GET', '/developers', async (request) => {
      try {
        return respond(
          200,
          await dispatch.listDevelopers({ repositoryId: request.query?.repositoryId }),
        )
      } catch (error) {
        return failure(error)
      }
    })

    ctx.http.route('PUT', '/developer-bindings', async (request) => {
      try {
        return respond(200, await dispatch.bindDeveloper(request.json() ?? {}))
      } catch (error) {
        return failure(error)
      }
    })

    ctx.http.route('POST', '/dispatch/preview', async (request) => {
      try {
        return respond(200, await previewMany(request.json() ?? {}))
      } catch (error) {
        return failure(error)
      }
    })

    ctx.http.route('POST', '/dispatch', async (request) => {
      try {
        const items = dispatch.normalizeItems(request.json() ?? {})
        const result = await dispatch.createBatch(items)
        return respond(200, result)
      } catch (error) {
        return failure(error)
      }
    })

    ctx.http.route('POST', '/sync', async (request) => {
      try {
        const body = request.json() ?? {}
        const result = await dispatch.syncRecent({
          size: asPositiveInt(body.size, config.maxPerSync),
          repositoryId: body.repositoryId,
        })
        return respond(200, result)
      } catch (error) {
        return failure(error)
      }
    })

    ctx.http.route('GET', '/imported', async (request) => {
      try {
        return respond(200, await dispatch.importedList({ limit: request.query.limit }))
      } catch (error) {
        return failure(error)
      }
    })

    ctx.http.route('GET', '/executions', async (request) => {
      const limit = Math.min(100, Number(request.query.limit) || 20)
      const runs = await ctx.runs.list({ limit })
      return respond(200, { runs })
    })

    ctx.http.route('GET', '/status', async () => {
      const auth = await authStatus()
      const imported = await links.listImported({ limit: 500 }).catch(() => [])
      return respond(200, {
        configured: Boolean(config.baseUrl),
        authMode: session.mode,
        credentialSource: accountCredential ? 'accounts' : 'local',
        accountsError: accountsError || null,
        userId: auth.userId,
        cacheTtlMs: config.cacheTtlMs,
        repositoryId: config.repositoryId || null,
        auth,
        dispatch: {
          repositoryId: config.repositoryId || null,
          assignee: config.assignee || null,
          assignedToUserId: config.assignedToUserId,
          skipIfNoAssignee: config.skipIfNoAssignee !== false,
          keepRaw: Boolean(config.keepRaw),
          maxPerSync: config.maxPerSync,
          poll: config.poll,
          imported: imported.length,
        },
      })
    })

    if (config.poll?.enabled) {
      const intervalMs = asPositiveInt(config.poll.intervalMs, 1_800_000)
      const timer = ctx.schedule.every(intervalMs, async () => {
        try {
          const result = await dispatch.syncRecent()
          ctx.log.info('轮询同步完成', { ...result.summary, total: result.total })
        } catch (error) {
          ctx.log.error('轮询同步失败', { message: error.message })
        }
      })
      ctx.effect(() => ctx.schedule.cancel(timer))
    }

    ctx.log.info('witops-core 已启动', {
      baseUrl: config.baseUrl,
      authMode: session.mode,
      repositoryId: config.repositoryId || null,
      poll: config.poll?.enabled ?? false,
    })
  },
})
