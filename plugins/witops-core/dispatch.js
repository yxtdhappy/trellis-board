/**
 * 下发 WitOps 任务到 Trellis。
 *
 * 去重真源是 `task.json.meta.witops.businessId`（见 links.js），插件 store 只作缓存，
 * 因此 store 丢失不会重复建任务。
 *
 * 平台原文写 `task.md`；`prd.md` 只放一行占位事实，正式内容由 Trellis 当前的规划流程生成。
 * 需求（type=3）下发时，平台的已拆分子任务会作为 Trellis 子任务挂在父任务下。
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  buildTaskDraft,
  dictionaryToMap,
  resolveAssignee,
  summarizeRecord,
  typeLabel,
} from './mapper.js'
import { asPositiveInt, detailOf, pick, stripAnsi, text } from './util.js'

const DICTIONARY_TYPES = ['priority', 'taskStatus', 'taskCategory', 'systemEnv']
const MAX_BATCH = 50
const MAX_CHILDREN = 30
const CHILD_TYPES = new Set([0, 2, 3, 4])
const PRIORITY_PATTERN = /^P[0-3]$/
const DEVELOPER_BINDINGS_PREFIX = 'developerBindings:'
const LEGACY_DEVELOPER_CONFIG_KEY = 'legacyDeveloperConfig'

/** 读取任务目录内的文件；relativeDir 已由 task-service 校验，这里再做一次越界保护。 */
function readTaskFile(task, name) {
  const projectPath = text(task?.projectPath)
  const relativeDir = text(task?.relativeDir)
  if (!projectPath || !relativeDir) return ''
  const root = path.resolve(projectPath, '.trellis', 'tasks')
  const dir = path.resolve(root, relativeDir)
  if (dir !== root && !dir.startsWith(root + path.sep)) return ''
  try {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) return ''
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * 把宿主 RPC 的 stderr 翻成能直接照做的提示。
 *
 * task.py 的 argparse 先打 usage 再打 `error: ...`；usage 因 choices 太长会折行，
 * 只取第一行会只剩 `usage: task.py [-h]`，真正的原因被丢掉，所以优先挑带
 * `error:` 的那一行。
 */
export function describeTaskError(message, slug = '') {
  const raw = stripAnsi(message ?? '')
  if (/Task already exists/i.test(raw)) {
    const dir = (raw.match(/Task already exists:\s*(\S+)/) || [])[1] || slug
    return `任务目录已存在但缺少 task.json：.trellis/tasks/${dir}；删除该空目录后重试同步`
  }
  const lines = raw
    .split('\n')
    .map((line) => line.replace(/\r+$/, '').trim())
    .filter((line) => line)
  const errorLine = lines.find((line) => /error\s*[:：]/i.test(line))
  return errorLine || lines[0] || '下发失败'
}

export function createDispatch({ ctx, config, client, session, links, onChanged = () => {} }) {
  const dictionaryCache = new Map()
  const dictionaryTtl = Number(config.cacheTtlMs || 0)
  let categoryNames = new Map()
  let legacyConfigCache

  function legacyKey(type, businessId) {
    return `task:${type}:${businessId}`
  }

  function bindingsKey(repositoryId) {
    return `${DEVELOPER_BINDINGS_PREFIX}${text(repositoryId) || 'default'}`
  }

  async function loadLegacyDeveloperConfig() {
    if (legacyConfigCache !== undefined) return legacyConfigCache
    try {
      const stored = await ctx.store.get(LEGACY_DEVELOPER_CONFIG_KEY)
      legacyConfigCache = stored && typeof stored === 'object' ? stored : null
    } catch {
      legacyConfigCache = null
    }
    return legacyConfigCache
  }

  async function loadDeveloperBindings(repositoryId) {
    try {
      const stored = await ctx.store.get(bindingsKey(repositoryId))
      return stored && typeof stored === 'object' ? stored : {}
    } catch {
      return {}
    }
  }

  async function saveDeveloperBinding(repositoryId, witopsUserId, assignee) {
    const dev = text(assignee)
    const key = text(witopsUserId)
    if (!dev || !key) return null
    const storeKey = bindingsKey(repositoryId)
    const existing = await loadDeveloperBindings(repositoryId)
    const next = { ...existing, [key]: dev }
    await ctx.store.set(storeKey, next)
    return next
  }

  async function loadProjectDevelopers(repositoryId) {
    const target = text(repositoryId)
    try {
      const result = await ctx.capabilities.call(
        'trellis.projects',
        'developers',
        target ? { repositoryId: target } : {},
      )
      return {
        repositoryId: text(result?.repositoryId) || target || null,
        currentDeveloper: text(result?.currentDeveloper) || null,
        developers: Array.isArray(result?.developers) ? result.developers.filter(Boolean) : [],
      }
    } catch {
      return { repositoryId: target || null, currentDeveloper: null, developers: [] }
    }
  }

  async function loadCurrentTrellisUser() {
    try {
      const result = await ctx.capabilities.call('trellis.user', 'current', {})
      return result?.user && typeof result.user === 'object' ? result.user : null
    } catch {
      return null
    }
  }

  async function currentWitopsUserId() {
    if (session.state.userId !== null && session.state.userId !== undefined) {
      return text(session.state.userId)
    }
    if (session.state.status === 'authenticated' && typeof session.resolveUserId === 'function') {
      try {
        return text(await session.resolveUserId())
      } catch {
        return ''
      }
    }
    return ''
  }

  function matchDeveloperName(candidate, developers) {
    const target = text(candidate).toLowerCase()
    if (!target || !Array.isArray(developers)) return ''
    return developers.find((dev) => text(dev).toLowerCase() === target) || ''
  }

  async function resolveTaskAssignee({
    draft,
    repositoryId,
    explicitAssignee = '',
    fallbackAssignee = '',
    persistAutoBinding = true,
  }) {
    const targetRepo = text(repositoryId) || text(config.repositoryId)
    const witopsDevId = text(draft.rawDeveloper)

    const explicit = text(explicitAssignee)
    if (explicit) {
      return { assignee: explicit, source: 'explicit', projectDevs: null }
    }

    const bindings = await loadDeveloperBindings(targetRepo)
    const bound = witopsDevId ? text(bindings[witopsDevId]) : ''
    if (bound) {
      return { assignee: bound, source: 'store', projectDevs: null }
    }

    const [projectDevs, trellisUser, sessionUserId] = await Promise.all([
      loadProjectDevelopers(targetRepo),
      loadCurrentTrellisUser(),
      currentWitopsUserId(),
    ])

    if (
      witopsDevId &&
      sessionUserId &&
      witopsDevId === sessionUserId &&
      projectDevs.currentDeveloper
    ) {
      if (persistAutoBinding) {
        await saveDeveloperBinding(targetRepo, witopsDevId, projectDevs.currentDeveloper).catch(
          () => {},
        )
      }
      return { assignee: projectDevs.currentDeveloper, source: 'auto-developer', projectDevs }
    }

    if ((!witopsDevId || !sessionUserId || witopsDevId === sessionUserId) && trellisUser) {
      const matchedTrellisUser =
        matchDeveloperName(trellisUser.username, projectDevs.developers) ||
        matchDeveloperName(trellisUser.displayName, projectDevs.developers)
      if (matchedTrellisUser) {
        return { assignee: matchedTrellisUser, source: 'auto-trellis-user', projectDevs }
      }
    }

    const matchedByName = matchDeveloperName(draft.rawDeveloperName, projectDevs.developers)
    if (matchedByName) {
      return { assignee: matchedByName, source: 'name-match', projectDevs }
    }

    const fromConfig = text(draft.assignee)
    if (fromConfig) {
      return { assignee: fromConfig, source: 'config', projectDevs }
    }

    const legacyConfig = await loadLegacyDeveloperConfig()
    if (legacyConfig) {
      const fromLegacy = text(resolveAssignee(witopsDevId || null, legacyConfig))
      if (fromLegacy) {
        return { assignee: fromLegacy, source: 'legacy-config', projectDevs }
      }
    }

    const fallback = text(fallbackAssignee)
    if (fallback) {
      return { assignee: fallback, source: 'fallback', projectDevs }
    }

    return { assignee: '', source: null, projectDevs }
  }

  function missingAssigneeOutcome({ businessId, repositoryId, draft, projectDevs }) {
    const reason = 'missing-assignee'
    const availableDevelopers = projectDevs?.developers ?? []
    const details = {
      businessId,
      repositoryId: text(repositoryId) || null,
      witopsUserId: draft.rawDeveloper || null,
      witopsAssigneeName: draft.rawDeveloperName || null,
      currentDeveloper: projectDevs?.currentDeveloper || null,
      availableDevelopers,
    }
    const developerHint = availableDevelopers.length
      ? `可选 Trellis 成员：${availableDevelopers.join('、')}`
      : '当前仓库暂无 .trellis/workspace 成员记录'
    const sourceLabel = draft.rawDeveloperName || draft.rawDeveloper || '未知'
    const message = `任务缺少 Trellis 负责人映射（WitOps 负责人：${sourceLabel}，${developerHint}），请在创建弹窗中选择负责人`
    const status = config.skipIfNoAssignee !== false ? 'skipped' : 'failed'
    return { status, reason, details, message }
  }

  async function listDevelopers({ repositoryId } = {}) {
    const targetRepo = text(repositoryId) || text(config.repositoryId) || null
    const [projectDevs, trellisUser, bindings, sessionUserId] = await Promise.all([
      loadProjectDevelopers(targetRepo),
      loadCurrentTrellisUser(),
      loadDeveloperBindings(targetRepo),
      currentWitopsUserId(),
    ])
    const defaultAssignee =
      (sessionUserId && text(bindings[sessionUserId])) ||
      projectDevs.currentDeveloper ||
      matchDeveloperName(trellisUser?.username, projectDevs.developers) ||
      matchDeveloperName(trellisUser?.displayName, projectDevs.developers) ||
      text(config.assignee) ||
      ''
    return {
      repositoryId: projectDevs.repositoryId || targetRepo,
      currentDeveloper: projectDevs.currentDeveloper,
      developers: projectDevs.developers,
      trellisUser,
      witopsUserId: sessionUserId || null,
      bindings,
      defaultAssignee: defaultAssignee || null,
    }
  }

  async function bindDeveloper({ repositoryId, witopsUserId, assignee } = {}) {
    const dev = text(assignee)
    if (!dev) throw ctx.error(1002, '需要 assignee')
    const targetRepo = text(repositoryId) || text(config.repositoryId) || 'default'
    const targetWitopsId = text(witopsUserId) || (await currentWitopsUserId())
    if (!targetWitopsId) throw ctx.error(1002, '缺少 WitOps 用户 ID（请先登录或传入 witopsUserId）')
    const bindings = await saveDeveloperBinding(targetRepo, targetWitopsId, dev)
    return {
      ok: true,
      repositoryId: targetRepo,
      witopsUserId: targetWitopsId,
      assignee: dev,
      bindings,
    }
  }

  function requireRepository() {
    const repositoryId = text(config.repositoryId)
    if (!repositoryId) throw ctx.error(1001, '缺少 repositoryId 配置')
    return repositoryId
  }

  async function loadDictionaries({ force = false } = {}) {
    const result = {}
    for (const type of DICTIONARY_TYPES) {
      const hit = dictionaryCache.get(type)
      if (!force && hit && Date.now() - hit.at <= dictionaryTtl) {
        result[type] = hit.value
        continue
      }
      try {
        const rows = await session.authorized((token) =>
          client.dictionary({ type, status: 1, size: 100 }, { token }),
        )
        const map = dictionaryToMap(Array.isArray(rows) ? rows : rows?.records)
        dictionaryCache.set(type, { at: Date.now(), value: map })
        result[type] = map
      } catch (error) {
        ctx.log.warn('字典加载失败，使用内置映射', { type, message: error.message })
        result[type] = new Map()
      }
    }
    return result
  }

  /** 面板筛选项：优先级、状态、缺陷分类、节点类型。 */
  async function loadFilterOptions({ force = false } = {}) {
    const dictionaries = await loadDictionaries({ force })
    const priorityMap = dictionaries.priority?.size
      ? dictionaries.priority
      : new Map([
          [1, 'P0'],
          [2, 'P1'],
          [3, 'P2'],
          [4, 'P3'],
        ])
    let categories = []
    const cachedCategories = dictionaryCache.get('bugCategory')
    try {
      if (!force && cachedCategories && Date.now() - cachedCategories.at <= dictionaryTtl) {
        categories = cachedCategories.value
      } else {
        const rows = await session.authorized((token) =>
          client.dictionary({ type: 'bugCategory', status: 1, size: 200 }, { token }),
        )
        const records = Array.isArray(rows) ? rows : (rows?.records ?? [])
        // 缺陷分类的 code 可能是字符串，不能用 dictionaryToMap 的 Number 转换。
        categories = records
          .map((row) => ({
            code: text(row?.code ?? row?.dicConfigCode ?? row?.value ?? row?.key),
            name: text(row?.name ?? row?.dicConfigName ?? row?.label ?? row?.text),
          }))
          .filter((item) => item.code && item.name)
        dictionaryCache.set('bugCategory', { at: Date.now(), value: categories })
      }
    } catch (error) {
      ctx.log.warn('缺陷分类加载失败，筛选项退化为空', { message: error.message })
    }
    categoryNames = new Map(categories.map((item) => [String(item.code), String(item.name)]))
    return {
      types: [3, 4, 2, 0].map((type) => ({ type, name: typeLabel(type) })),
      priorities: [...priorityMap.entries()]
        .map(([code, name]) => ({ code: String(code), name }))
        .sort((left, right) => left.code.localeCompare(right.code)),
      statuses: [
        { code: '1', name: '待处理' },
        { code: '3', name: '进行中' },
        { code: '2', name: '已完成' },
        { code: '4', name: '已取消' },
        { code: '97', name: '待提交' },
        { code: '99', name: '已关闭' },
      ],
      categories,
    }
  }

  function filterValue(value) {
    if (Array.isArray(value))
      return value
        .map((item) => text(item))
        .filter(Boolean)
        .join(',')
    return text(value)
  }

  /** 类型 0（工单）是合法值，不能用 `Number(x) || fallback` 判断。 */
  function asTypeCode(value, fallback = 4) {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
    const base = Number(fallback)
    return Number.isFinite(base) && String(fallback ?? '').trim() !== '' ? base : 4
  }

  async function fetchPage({ page = 1, size, status, type, filters = {} } = {}) {
    const categoryFilter = filterValue(filters.categories)
    const payload = {
      current: asPositiveInt(page, 1),
      size: asPositiveInt(size, config.pageSize),
      status: filterValue(filters.status) || status || config.status,
      type: asTypeCode(type, config.type),
    }
    // 平台把 categories 映射到 business.category，但该列在部分部署不存在（SQL 500）。
    // 缺陷分类改为本地过滤：多取一些记录，按 categoryDicConfigCode / 名称匹配。
    const localCategory = Boolean(categoryFilter) && payload.type === 2
    if (localCategory) {
      payload.size = Math.max(payload.size, Math.min(200, Number(config.categoryScanSize) || 200))
    }
    const assignedToUserId = filters.assignedToUserId
    if (assignedToUserId === 'all') {
      // 用户显式选择「全部负责人」：不再注入当前用户。
    } else if (
      assignedToUserId !== undefined &&
      assignedToUserId !== null &&
      assignedToUserId !== ''
    ) {
      payload.assignedToUserId = assignedToUserId
    } else {
      const fallback = config.assignedToUserId ?? session.state.userId ?? null
      if (fallback !== null && fallback !== undefined && fallback !== '') {
        payload.assignedToUserId = fallback
      }
    }
    for (const key of ['code', 'name', 'priority', 'iterationId', 'productIds']) {
      const value = filterValue(filters[key])
      if (value) payload[key] = value
    }
    if (config.extraQuery && typeof config.extraQuery === 'object') {
      Object.assign(payload, config.extraQuery)
    }
    const data = await session.authorized((token) => client.page(payload, { token }))
    let records = Array.isArray(data) ? data : data?.records || data?.list || []
    if (localCategory) {
      const wantedCodes = new Set(
        categoryFilter
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      )
      const wantedNames = new Set(
        [...wantedCodes].map((code) => categoryNames.get(code)).filter(Boolean),
      )
      records = records.filter((record) => {
        const code = text(pick(record, 'categoryDicConfigCode', 'categoryCode'))
        if (code) return wantedCodes.has(code)
        const name = text(pick(record, 'categoryDicConfigName', 'taskCategoryName', 'category'))
        return Boolean(name) && wantedNames.has(name)
      })
    }
    return {
      records,
      total: localCategory ? records.length : Number(data?.total ?? records.length),
      pages: localCategory ? 1 : Number(data?.pages ?? 1),
      current: Number(data?.current ?? payload.current),
      size: Number(data?.size ?? payload.size),
    }
  }

  /**
   * 去重只认 `task.json.meta.witops`（含归档任务）。
   * 不再读插件 store：任务被删掉后 store 里的旧记录会让平台任务永远无法重新下发。
   */
  async function findExisting(type, businessId) {
    const found = await links.find({ type, businessId })
    return found.length ? found[0] : null
  }

  /**
   * 统一详情接口 nodeTask/detail 覆盖需求/任务/缺陷/工单；
   * 旧环境没有这个接口时回退到 task/detail、story/detail。
   */
  async function fetchDetail(type, businessId) {
    const typeCode = Number(type)
    const attempts = [
      (token) => client.nodeTaskDetail({ id: businessId, type: typeCode }, { token }),
      ...(typeCode === 3
        ? [(token) => client.story({ id: businessId, type: 3 }, { token })]
        : [(token) => client.detail({ id: businessId, type: typeCode }, { token })]),
    ]
    for (const attempt of attempts) {
      try {
        const raw = await session.authorized(attempt)
        const detail = detailOf(raw)
        if (detail && Object.keys(detail).length) return detail
      } catch (error) {
        if (error?.authExpired || error?.code === 1001) throw error
        // 继续尝试下一个详情接口。
      }
    }
    return null
  }

  /** 拉详情 + 字典 + 父需求回退，产出完整 draft（不落盘）。 */
  async function prepare({
    type,
    businessId,
    storyId = null,
    repositoryId = '',
    assignee = '',
    fallbackAssignee = '',
    persistAutoBinding = false,
  }) {
    const typeCode = asTypeCode(type, config.type)
    const id = text(businessId)
    if (!id) return { status: 'failed', reason: 'missing-business-id' }
    const detail = await fetchDetail(typeCode, id)
    if (!detail) return { status: 'failed', reason: `平台任务不存在: ${id}` }

    const dictionaries = await loadDictionaries()
    let story = null
    const hasTaskDescription = Boolean(
      String(pick(detail, 'description', 'content', 'remark') || '').trim(),
    )
    const parentStoryId = storyId ?? detail.parentStoryId ?? detail.storyId ?? null
    if (!hasTaskDescription && parentStoryId && text(parentStoryId) !== id) {
      try {
        const raw = await session.authorized((token) =>
          client.story({ id: parentStoryId, type: 3 }, { token }),
        )
        story = detailOf(raw)
      } catch (error) {
        ctx.log.warn('父需求描述加载失败', {
          businessId: id,
          storyId: String(parentStoryId),
          message: error.message,
        })
      }
    }

    const draft = buildTaskDraft({
      detail,
      story,
      type: typeCode,
      businessId: id,
      config,
      dictionaries,
      baseUrl: config.baseUrl,
      webRoot: config.webRoot,
      parentBusinessId: storyId,
    })
    const resolution = await resolveTaskAssignee({
      draft,
      repositoryId,
      explicitAssignee: assignee,
      fallbackAssignee,
      persistAutoBinding,
    })
    draft.assignee = resolution.assignee
    draft.assigneeSource = resolution.source
    return { status: 'ready', draft, detail, resolution }
  }

  /** 需求下已拆分的直接子任务。 */
  async function childrenOf(requirementId) {
    try {
      const data = await session.authorized((token) =>
        client.childTask({ id: requirementId, type: 3 }, { token }),
      )
      const children = Array.isArray(data?.children)
        ? data.children
        : Array.isArray(data)
          ? data
          : []
      return children.filter((child) => child && typeof child === 'object')
    } catch (error) {
      if (error?.authExpired || error?.code === 1001) throw error
      ctx.log.warn('子任务列表加载失败', {
        requirementId: String(requirementId),
        message: error.message,
      })
      return []
    }
  }

  function childEntry(child) {
    return {
      businessId: text(pick(child, 'businessId', 'sourceId', 'id')),
      type: asTypeCode(child.type, 4),
      code: text(child.code) || '',
      title: text(pick(child, 'name', 'title')) || '',
      assignee: text(pick(child, 'assignedToUserName', 'assigneeName', 'assignee')),
      status: text(pick(child, 'sourceStatusName', 'statusName', 'status')),
    }
  }

  async function previewChildren(requirementId) {
    const children = await childrenOf(requirementId)
    return children
      .map(childEntry)
      .filter((child) => child.businessId && CHILD_TYPES.has(child.type))
  }

  /** 已存在任务也允许预览：优先 task.md，旧任务回退 prd.md / task.json.description。 */
  async function existingDraft(link, typeCode) {
    try {
      const task = await ctx.tasks.get({ taskKey: link.taskKey })
      let sourceName = 'task.md'
      let taskMarkdown = readTaskFile(task, 'task.md')
      if (!taskMarkdown.trim()) {
        const prd = readTaskFile(task, 'prd.md')
        if (prd.trim() && !/prd\.md 尚未生成|平台原文在 `task\.md`/.test(prd)) {
          sourceName = 'prd.md'
          taskMarkdown = prd
        }
      }
      if (!taskMarkdown.trim()) {
        const raw = readTaskFile(task, 'task.json')
        try {
          const description = text(JSON.parse(raw)?.description)
          if (description) {
            sourceName = 'task.json'
            taskMarkdown = description
          }
        } catch {
          // task.json 损坏时保持空内容，预览只显示 duplicated 提示。
        }
      }
      if (!taskMarkdown.trim()) return null
      if (taskMarkdown.length > 20_000) {
        taskMarkdown = `${taskMarkdown.slice(0, 20_000)}\n\n…（内容过长，已截断）`
      }
      const meta = task.meta?.witops ?? {}
      const draftType = asTypeCode(meta.type ?? typeCode, typeCode)
      return {
        title: task.title ?? link.title ?? null,
        slug: path.basename(String(task.relativeDir ?? '')),
        code: meta.code ?? link.code ?? '',
        type: draftType,
        typeName: typeLabel(draftType),
        assignee: task.assignee ?? null,
        priority: task.priority ?? 'P2',
        dueDate: meta.dueDate ?? null,
        sourceName,
        taskMarkdown,
      }
    } catch {
      return null
    }
  }

  async function previewOne({ type, businessId, repositoryId = '', assignee = '' }) {
    const typeCode = asTypeCode(type, config.type)
    const id = text(businessId)
    if (!id) return { status: 'failed', reason: 'missing-business-id' }
    const children = typeCode === 3 ? await previewChildren(id) : []
    const existing = await findExisting(typeCode, id)
    if (existing) {
      const draft = await existingDraft(existing, typeCode)
      return {
        status: 'duplicated',
        type: typeCode,
        businessId: id,
        taskKey: existing.taskKey,
        title: existing.title ?? null,
        ...(draft ? { draft } : {}),
        children,
      }
    }
    const prepared = await prepare({
      type: typeCode,
      businessId: id,
      repositoryId,
      assignee,
      persistAutoBinding: false,
    })
    if (prepared.status !== 'ready') {
      return { type: typeCode, businessId: id, ...prepared, children }
    }
    const { draft, resolution } = prepared
    return {
      status: 'ready',
      type: typeCode,
      businessId: id,
      draft: {
        title: draft.title,
        slug: draft.slug,
        code: draft.code,
        type: draft.type,
        typeName: draft.typeName,
        assignee: draft.assignee,
        assigneeSource: draft.assigneeSource ?? null,
        priority: draft.priority,
        dueDate: draft.dueDate ?? null,
        description: draft.description,
        taskMarkdown: draft.taskMarkdown,
        prd: draft.prd,
        meta: draft.meta,
        extraFiles: Object.keys(draft.extraFiles ?? {}),
      },
      developers: resolution?.projectDevs?.developers ?? [],
      children,
    }
  }

  /** 把宿主 RPC 的原始错误翻成能直接照做的中文提示。 */
  function describeError(error, slug = '') {
    return describeTaskError(error?.message, slug)
  }

  function chosenPriority(priority, fallback) {
    const value = text(priority).toUpperCase()
    return PRIORITY_PATTERN.test(value) ? value : fallback
  }

  /** 创建单个 Trellis 任务（父任务或子任务），返回 taskKey / relativeDir。 */
  async function createTaskRecord({
    draft,
    repositoryId,
    dueDate,
    baseBranch,
    priority,
    parentDir,
    parentBusinessId,
  }) {
    const taskType = draft.taskType || undefined
    const meta = parentBusinessId
      ? {
          ...draft.meta,
          witops: { ...draft.meta.witops, parentBusinessId: String(parentBusinessId) },
        }
      : { ...draft.meta }
    if (draft.workType) {
      meta.label_source = meta.label_source || 'user-explicit'
      meta.label_default_from = meta.label_default_from || 'witops-category'
    }
    const created = await ctx.tasks.create({
      repositoryId,
      title: draft.title,
      description: draft.description,
      prd: draft.prd,
      assignee: draft.assignee,
      priority: chosenPriority(priority, draft.priority),
      slug: draft.slug,
      taskType,
      workType: draft.workType || undefined,
      meta,
      extraFiles: draft.extraFiles,
      baseBranch: text(baseBranch) || undefined,
      parentDir: parentDir || undefined,
    })
    const taskKey = created?.taskKey ?? created?.task?.taskKey ?? null
    const relativeDir = created?.relativeDir ?? (taskKey ? String(taskKey).split('::')[1] : null)
    let appliedDueDate = text(dueDate) || draft.dueDate || null
    if (taskKey && appliedDueDate) {
      try {
        const plan = await ctx.tasks.setPlan({ taskKey, dueDate: appliedDueDate })
        appliedDueDate = plan?.dueDate ?? appliedDueDate
      } catch (error) {
        ctx.log.warn('截止日期写入看板失败', {
          taskKey,
          dueDate: appliedDueDate,
          message: error.message,
        })
      }
    }
    return { taskKey, relativeDir, appliedDueDate }
  }

  /** 需求下的已拆分子任务 → Trellis 子任务。已存在的子任务跳过，支持补建。 */
  async function createChildren({
    requirementId,
    parentDir,
    repositoryId,
    baseBranch,
    priority,
    dueDate,
    fallbackAssignee = '',
    rememberBinding = false,
    taskType = '',
    workType = '',
  }) {
    if (!parentDir) return []
    const children = await childrenOf(requirementId)
    const results = []
    for (const child of children.slice(0, MAX_CHILDREN)) {
      const entry = childEntry(child)
      if (!entry.businessId || !CHILD_TYPES.has(entry.type)) continue
      const existing = await findExisting(entry.type, entry.businessId)
      if (existing?.taskKey) {
        results.push({ ...entry, status: 'duplicated', taskKey: existing.taskKey })
        continue
      }
      const prepared = await prepare({
        type: entry.type,
        businessId: entry.businessId,
        storyId: requirementId,
        repositoryId,
        fallbackAssignee,
        persistAutoBinding: true,
      })
      if (prepared.status !== 'ready') {
        results.push({ ...entry, ...prepared })
        continue
      }
      const { draft, resolution } = prepared
      if (text(taskType)) draft.taskType = text(taskType)
      if (text(workType)) draft.workType = text(workType)
      if (!draft.assignee) {
        results.push({
          ...entry,
          ...missingAssigneeOutcome({
            businessId: entry.businessId,
            repositoryId,
            draft,
            projectDevs: resolution?.projectDevs,
          }),
        })
        continue
      }
      if (
        rememberBinding &&
        text(fallbackAssignee) &&
        draft.rawDeveloper &&
        draft.assigneeSource === 'fallback'
      ) {
        await saveDeveloperBinding(repositoryId, draft.rawDeveloper, draft.assignee).catch(() => {})
      }
      try {
        const created = await createTaskRecord({
          draft,
          repositoryId,
          dueDate,
          baseBranch,
          priority,
          parentDir,
          parentBusinessId: requirementId,
        })
        results.push({
          ...entry,
          status: 'imported',
          taskKey: created.taskKey,
          title: draft.title,
          dueDate: created.appliedDueDate,
        })
        ctx.log.info('下发平台子任务', {
          businessId: entry.businessId,
          taskKey: created.taskKey,
          parent: parentDir,
        })
      } catch (error) {
        const reason = describeError(error, draft.slug)
        ctx.log.error('子任务下发失败', {
          businessId: entry.businessId,
          message: reason,
          code: error.code ?? null,
        })
        results.push({ ...entry, status: 'failed', reason })
      }
    }
    return results
  }

  async function createOne({
    type,
    businessId,
    repositoryId,
    dueDate,
    baseBranch,
    priority,
    includeChildren,
    assignee,
    rememberBinding,
    taskType,
    workType,
  }) {
    const typeCode = asTypeCode(type, config.type)
    const id = text(businessId)
    if (!id) return { status: 'failed', reason: 'missing-business-id' }
    const wantsChildren = typeCode === 3 && includeChildren !== false

    const existing = await findExisting(typeCode, id)
    if (existing?.taskKey) {
      const result = {
        status: 'duplicated',
        taskKey: existing.taskKey,
        title: existing.title ?? null,
        code: existing.code ?? null,
      }
      if (wantsChildren) {
        try {
          result.children = await createChildren({
            requirementId: id,
            parentDir: String(existing.taskKey).split('::')[1] || null,
            repositoryId: text(repositoryId) || requireRepository(),
            baseBranch,
            priority,
            dueDate,
            fallbackAssignee: assignee,
            rememberBinding: rememberBinding === true,
            taskType: text(taskType),
            workType: text(workType),
          })
          result.childSummary = summarizeResults(result.children)
        } catch (error) {
          result.children = []
          result.childrenError = describeError(error)
        }
      }
      return result
    }

    let slug = ''
    try {
      const targetRepository = text(repositoryId) || requireRepository()
      const prepared = await prepare({
        type: typeCode,
        businessId: id,
        repositoryId: targetRepository,
        assignee,
        persistAutoBinding: true,
      })
      if (prepared.status !== 'ready') return prepared
      const { draft, resolution } = prepared
      if (text(taskType)) draft.taskType = text(taskType)
      if (text(workType)) draft.workType = text(workType)
      slug = draft.slug

      if (!draft.assignee) {
        const outcome = missingAssigneeOutcome({
          businessId: id,
          repositoryId: targetRepository,
          draft,
          projectDevs: resolution?.projectDevs,
        })
        ctx.log.warn('任务缺少负责人，跳过下发', {
          businessId: id,
          developer: draft.rawDeveloper,
          developerName: draft.rawDeveloperName,
          repositoryId: targetRepository,
          availableDevelopers: outcome.details.availableDevelopers,
        })
        return outcome
      }

      if (rememberBinding === true && text(assignee) && draft.rawDeveloper) {
        await saveDeveloperBinding(targetRepository, draft.rawDeveloper, draft.assignee).catch(
          () => {},
        )
      }

      const created = await createTaskRecord({
        draft,
        repositoryId: targetRepository,
        dueDate,
        baseBranch,
        priority,
        parentDir: null,
      })
      const record = {
        taskKey: created.taskKey,
        title: draft.title,
        code: draft.code,
        dueDate: created.appliedDueDate,
        importedAt: new Date().toISOString(),
      }
      // 仅作审计记录，不参与去重。
      await ctx.store.set(legacyKey(typeCode, id), record).catch((error) => {
        ctx.log.warn('下发记录写入失败', { businessId: id, message: error.message })
      })
      links.invalidate()
      onChanged()
      ctx.log.info('下发平台任务', {
        businessId: id,
        taskKey: created.taskKey,
        assignee: draft.assignee,
        assigneeSource: draft.assigneeSource ?? null,
      })
      const result = {
        status: 'imported',
        taskKey: created.taskKey,
        title: draft.title,
        code: draft.code,
        dueDate: created.appliedDueDate,
      }
      if (wantsChildren && created.relativeDir) {
        try {
          result.children = await createChildren({
            requirementId: id,
            parentDir: created.relativeDir,
            repositoryId: targetRepository,
            baseBranch,
            priority,
            dueDate,
            fallbackAssignee: draft.assignee,
            rememberBinding: rememberBinding === true,
            taskType: text(draft.taskType),
            workType: text(draft.workType),
          })
          result.childSummary = summarizeResults(result.children)
        } catch (error) {
          result.children = []
          result.childrenError = describeError(error)
        }
      }
      return result
    } catch (error) {
      if (error?.code === 1001 || error?.authExpired) throw error
      const reason = describeError(error, slug)
      ctx.log.error('下发失败', { businessId: id, message: reason, code: error.code ?? null })
      return { status: 'failed', reason }
    }
  }

  function summarizeResults(results) {
    const summary = { imported: 0, duplicated: 0, skipped: 0, failed: 0 }
    for (const item of results) summary[item.status] = (summary[item.status] ?? 0) + 1
    return summary
  }

  function normalizeItems(body = {}) {
    const repositoryId = text(body.repositoryId)
    const baseBranch = text(body.baseBranch)
    const priority = text(body.priority)
    const assignee = text(body.assignee)
    const rememberBinding = body.rememberBinding === true
    const includeChildren = body.includeChildren
    const decorate = (item) => ({
      baseBranch: text(item.baseBranch) || baseBranch,
      priority: text(item.priority) || priority,
      assignee: text(item.assignee) || assignee,
      rememberBinding: item.rememberBinding ?? rememberBinding,
      includeChildren: item.includeChildren ?? includeChildren,
      taskType: text(item.taskType) || text(body.taskType),
      workType: text(item.workType) || text(body.workType),
    })
    if (Array.isArray(body.items)) {
      return body.items
        .map((item) => ({
          type: asTypeCode(item.type ?? body.type, config.type),
          businessId: text(item.businessId ?? item.id),
          repositoryId: text(item.repositoryId) || repositoryId,
          dueDate: text(item.dueDate),
          ...decorate(item),
        }))
        .filter((item) => item.businessId)
    }
    const ids = Array.isArray(body.businessIds) ? body.businessIds : []
    if (ids.length) {
      return ids
        .map((id) => ({
          type: asTypeCode(body.type, config.type),
          businessId: text(id),
          repositoryId,
          dueDate: text(body.dueDate),
          ...decorate({}),
        }))
        .filter((item) => item.businessId)
    }
    if (body.businessId) {
      return [
        {
          type: asTypeCode(body.type, config.type),
          businessId: text(body.businessId),
          repositoryId,
          dueDate: text(body.dueDate),
          ...decorate({}),
        },
      ]
    }
    return []
  }

  async function createBatch(items) {
    const list = (Array.isArray(items) ? items : []).slice(0, MAX_BATCH)
    if (!list.length) throw ctx.error(1002, '需要 items / businessIds / businessId')
    const results = []
    for (const item of list) {
      results.push({ ...item, ...(await createOne(item)) })
    }
    return { results, summary: summarizeResults(results) }
  }

  async function syncRecent({
    size = config.maxPerSync,
    repositoryId,
    taskType = '',
    workType = '',
  } = {}) {
    const limit = asPositiveInt(size, config.maxPerSync)
    const run = await ctx.runs.start({
      taskKey: 'sync',
      request: { size: limit, account: session.state.account ?? null },
    })
    if (!run.started) return { skipped: 'run-active', runId: run.runId }
    try {
      const candidates = []
      let total = 0
      let pages = 1
      for (let page = 1; page <= pages && candidates.length < limit; page += 1) {
        const data = await fetchPage({ page, size: Math.min(Number(config.pageSize) || 20, limit) })
        total = data.total
        pages = Math.max(1, data.pages)
        for (const record of data.records) {
          if (candidates.length >= limit) break
          const businessId = text(record.businessId ?? record.id)
          if (!businessId) continue
          if (candidates.some((item) => item.businessId === businessId)) continue
          candidates.push({
            businessId,
            type: asTypeCode(record.type, config.type),
            repositoryId,
            taskType: text(taskType),
            workType: text(workType),
          })
        }
      }
      const results = []
      for (const item of candidates) {
        results.push({ ...item, ...(await createOne(item)) })
      }
      const summary = { total, pages, results, summary: summarizeResults(results) }
      await ctx.runs
        .finish(run.runId, { status: 'succeeded', result: summary })
        .catch((failure) =>
          ctx.log.warn('回写 run 失败', { runId: run.runId, message: failure.message }),
        )
      return summary
    } catch (error) {
      await ctx.runs
        .finish(run.runId, { status: 'failed', result: { error: error.message } })
        .catch(() => {})
      throw error
    }
  }

  async function importedList({ limit = 200 } = {}) {
    const items = await links.listImported({ limit })
    return { items, total: items.length }
  }

  async function tasksPage({ page = 1, size, status, type } = {}) {
    const result = await fetchPage({ page, size, status, type })
    const tasks = []
    for (const record of result.records) {
      const recordType = asTypeCode(record.type, config.type)
      const businessId = text(record.businessId ?? record.id)
      const imported = businessId ? await findExisting(recordType, businessId) : null
      tasks.push(summarizeRecord(record, { type: recordType, imported }))
    }
    return {
      total: result.total,
      page: result.current,
      size: result.size,
      pages: result.pages,
      tasks,
    }
  }

  return {
    loadDictionaries,
    loadFilterOptions,
    fetchPage,
    prepare,
    previewOne,
    previewChildren,
    childrenOf,
    createOne,
    createChildren,
    createBatch,
    normalizeItems,
    summarizeResults,
    syncRecent,
    importedList,
    tasksPage,
    listDevelopers,
    bindDeveloper,
  }
}
