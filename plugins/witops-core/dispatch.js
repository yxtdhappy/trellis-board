/**
 * 下发 WitOps 任务到 Trellis。
 *
 * 去重真源是 `task.json.meta.witops.businessId`（见 links.js），插件 store 只作缓存，
 * 因此 store 丢失不会重复建任务。
 */
import { buildTaskDraft, dictionaryToMap, summarizeRecord } from './mapper.js'
import { asPositiveInt, detailOf, pick, stripAnsi, text } from './util.js'

const DICTIONARY_TYPES = ['priority', 'taskStatus', 'taskCategory', 'systemEnv']
const MAX_BATCH = 50

export function createDispatch({ ctx, config, client, session, links, onChanged = () => {} }) {
  const dictionaryCache = new Map()
  const dictionaryTtl = Number(config.cacheTtlMs || 0)

  function legacyKey(type, businessId) {
    return `task:${type}:${businessId}`
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

  async function fetchPage({ page = 1, size, status, type } = {}) {
    const payload = {
      current: asPositiveInt(page, 1),
      size: asPositiveInt(size, config.pageSize),
      status: status ?? config.status,
      type: Number(type ?? config.type) || config.type,
    }
    const assignedToUserId = config.assignedToUserId ?? session.state.userId ?? null
    if (assignedToUserId !== null && assignedToUserId !== undefined && assignedToUserId !== '') {
      payload.assignedToUserId = assignedToUserId
    }
    if (config.extraQuery && typeof config.extraQuery === 'object') {
      Object.assign(payload, config.extraQuery)
    }
    const data = await session.authorized((token) => client.page(payload, { token }))
    const records = Array.isArray(data) ? data : data?.records || data?.list || []
    return {
      records,
      total: Number(data?.total ?? records.length),
      pages: Number(data?.pages ?? 1),
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

  async function fetchDetail(type, businessId) {
    const raw = await session.authorized((token) =>
      client.detail({ id: businessId, type }, { token }),
    )
    const detail = detailOf(raw)
    return detail && Object.keys(detail).length ? detail : null
  }

  /** 拉详情 + 字典 + 父需求回退，产出完整 draft（不落盘）。 */
  async function prepare({ type, businessId }) {
    const typeCode = Number(type) || Number(config.type) || 4
    const id = text(businessId)
    if (!id) return { status: 'failed', reason: 'missing-business-id' }
    const detail = await fetchDetail(typeCode, id)
    if (!detail) return { status: 'failed', reason: `平台任务不存在: ${id}` }

    const dictionaries = await loadDictionaries()
    let story = null
    const hasTaskDescription = Boolean(
      String(pick(detail, 'description', 'content', 'remark') || '').trim(),
    )
    const parentStoryId = detail.parentStoryId ?? detail.storyId ?? null
    if (!hasTaskDescription && parentStoryId) {
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
    })
    return { status: 'ready', draft, detail }
  }

  async function previewOne({ type, businessId }) {
    const typeCode = Number(type) || Number(config.type) || 4
    const id = text(businessId)
    if (!id) return { status: 'failed', reason: 'missing-business-id' }
    const existing = await findExisting(typeCode, id)
    if (existing) {
      return {
        status: 'duplicated',
        type: typeCode,
        businessId: id,
        taskKey: existing.taskKey,
        title: existing.title ?? null,
      }
    }
    const prepared = await prepare({ type: typeCode, businessId: id })
    if (prepared.status !== 'ready') {
      return { type: typeCode, businessId: id, ...prepared }
    }
    const { draft } = prepared
    return {
      status: 'ready',
      type: typeCode,
      businessId: id,
      draft: {
        title: draft.title,
        slug: draft.slug,
        code: draft.code,
        assignee: draft.assignee,
        priority: draft.priority,
        dueDate: draft.dueDate ?? null,
        description: draft.description,
        prd: draft.prd,
        meta: draft.meta,
        extraFiles: Object.keys(draft.extraFiles ?? {}),
      },
    }
  }

  /** 把宿主 RPC 的原始错误翻成能直接照做的中文提示。 */
  function describeError(error, slug = '') {
    const raw = stripAnsi(error?.message ?? '')
    if (/Task already exists/i.test(raw)) {
      const dir = (raw.match(/Task already exists:\s*(\S+)/) || [])[1] || slug
      return `任务目录已存在但缺少 task.json：.trellis/tasks/${dir}；删除该空目录后重试同步`
    }
    return raw.split('\n').find((line) => line.trim()) || '下发失败'
  }

  async function createOne({ type, businessId, repositoryId, dueDate }) {
    const typeCode = Number(type) || Number(config.type) || 4
    const id = text(businessId)
    if (!id) return { status: 'failed', reason: 'missing-business-id' }

    const existing = await findExisting(typeCode, id)
    if (existing?.taskKey) {
      return { status: 'duplicated', taskKey: existing.taskKey, title: existing.title ?? null }
    }

    let slug = ''
    try {
      const targetRepository = text(repositoryId) || requireRepository()
      const prepared = await prepare({ type: typeCode, businessId: id })
      if (prepared.status !== 'ready') return prepared
      const { draft } = prepared
      slug = draft.slug

      if (!draft.assignee) {
        const reason = 'missing-assignee'
        if (config.skipIfNoAssignee !== false) {
          ctx.log.warn('任务缺少负责人，跳过下发', {
            businessId: id,
            developer: draft.rawDeveloper,
          })
          return { status: 'skipped', reason }
        }
        return { status: 'failed', reason }
      }

      const created = await ctx.tasks.create({
        repositoryId: targetRepository,
        title: draft.title,
        description: draft.description,
        prd: draft.prd,
        assignee: draft.assignee,
        priority: draft.priority,
        slug: draft.slug,
        meta: draft.meta,
        extraFiles: draft.extraFiles,
      })
      const taskKey = created?.taskKey ?? created?.task?.taskKey ?? null
      let appliedDueDate = text(dueDate) || draft.dueDate || null
      if (taskKey && appliedDueDate) {
        try {
          const plan = await ctx.tasks.setPlan({ taskKey, dueDate: appliedDueDate })
          appliedDueDate = plan?.dueDate ?? appliedDueDate
        } catch (error) {
          ctx.log.warn('截止日期写入看板失败', {
            businessId: id,
            taskKey,
            dueDate: appliedDueDate,
            message: error.message,
          })
        }
      }
      const record = {
        taskKey,
        title: draft.title,
        code: draft.code,
        dueDate: appliedDueDate,
        importedAt: new Date().toISOString(),
      }
      // 仅作审计记录，不参与去重。
      await ctx.store.set(legacyKey(typeCode, id), record).catch((error) => {
        ctx.log.warn('下发记录写入失败', { businessId: id, message: error.message })
      })
      links.invalidate()
      onChanged()
      ctx.log.info('下发平台任务', { businessId: id, taskKey, assignee: draft.assignee })
      return {
        status: 'imported',
        taskKey,
        title: draft.title,
        code: draft.code,
        dueDate: appliedDueDate,
      }
    } catch (error) {
      if (error?.code === 1001) throw error
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
    if (Array.isArray(body.items)) {
      return body.items
        .map((item) => ({
          type: Number(item.type ?? body.type ?? config.type) || 4,
          businessId: text(item.businessId ?? item.id),
          repositoryId: text(item.repositoryId) || repositoryId,
          dueDate: text(item.dueDate),
        }))
        .filter((item) => item.businessId)
    }
    const ids = Array.isArray(body.businessIds) ? body.businessIds : []
    if (ids.length) {
      return ids
        .map((id) => ({
          type: Number(body.type ?? config.type) || 4,
          businessId: text(id),
          repositoryId,
        }))
        .filter((item) => item.businessId)
    }
    if (body.businessId) {
      return [
        {
          type: Number(body.type ?? config.type) || 4,
          businessId: text(body.businessId),
          repositoryId,
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

  async function syncRecent({ size = config.maxPerSync, repositoryId } = {}) {
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
            type: Number(record.type ?? config.type) || 4,
            repositoryId,
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
      const recordType = Number(record.type ?? config.type) || 4
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
    fetchPage,
    prepare,
    previewOne,
    createOne,
    createBatch,
    normalizeItems,
    summarizeResults,
    syncRecent,
    importedList,
    tasksPage,
  }
}
