import { STAGES } from './metadata.js'

const STAGE_INDEX = new Map(STAGES.map((stage, index) => [stage.id, index]))
const STAGE_LABELS = new Map(STAGES.map((stage) => [stage.id, stage.label]))

function timestamp(value) {
  const parsed = Date.parse(value || '')
  return Number.isFinite(parsed) ? parsed : null
}

function compareEvents(left, right) {
  return (
    String(left.occurredAt || '').localeCompare(String(right.occurredAt || '')) ||
    Number(left.id || 0) - Number(right.id || 0)
  )
}

function undoneEventIds(events) {
  const result = new Set()
  events.forEach((event) => {
    if (event.type !== 'operation_undone') return
    const ids = Array.isArray(event.payload?.targetEventIds) ? event.payload.targetEventIds : []
    ids.forEach((id) => result.add(String(id)))
  })
  return result
}

function stageEventNodes(events) {
  const undone = undoneEventIds(events)
  const nodes = []
  let unreadable = 0
  ;[...events].sort(compareEvents).forEach((event) => {
    if (undone.has(String(event.id))) return
    let stageId = null
    if (event.type === 'stage_observed') {
      stageId = event.payload?.after?.derivedStage || null
    } else if (event.type === 'stage_manual_confirmed') {
      stageId = event.payload?.after?.stage || null
    } else {
      return
    }
    const occurredAt = event.occurredAt || null
    const occurredMs = timestamp(occurredAt)
    if (!STAGE_INDEX.has(stageId) || occurredMs == null) {
      unreadable += 1
      return
    }
    const node = {
      stageId,
      label: STAGE_LABELS.get(stageId),
      stageIndex: STAGE_INDEX.get(stageId),
      source: event.source,
      eventId: Number(event.id),
      occurredAt,
      occurredMs,
    }
    const previous = nodes.at(-1)
    if (previous?.stageId === stageId) {
      if (previous.occurredMs === occurredMs) nodes[nodes.length - 1] = node
      return
    }
    nodes.push(node)
  })
  return { nodes, unreadable }
}

function mergedBlockedIntervals(dependencies, windowStart, windowEnd) {
  const intervals = dependencies
    .map((dependency) => {
      const created = timestamp(dependency.createdAt)
      const resolved = dependency.resolvedAt ? timestamp(dependency.resolvedAt) : windowEnd
      if (created == null || resolved == null) return null
      const start = Math.max(windowStart, created)
      const end = Math.min(windowEnd, resolved)
      if (end <= start) return null
      return { start, end, id: dependency.id }
    })
    .filter(Boolean)
    .sort((left, right) => left.start - right.start || left.end - right.end)

  const merged = []
  intervals.forEach((interval) => {
    const previous = merged.at(-1)
    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end)
      previous.ids.push(interval.id)
      return
    }
    merged.push({
      start: interval.start,
      end: interval.end,
      ids: [interval.id],
    })
  })
  return merged
}

function emptyMetrics({
  missingReasons,
  observedSince = null,
  eventTotal = 0,
  eventLimit = 1000,
  eventTruncated = false,
  eventWindowStartAt = null,
}) {
  return {
    completeness: 'missing',
    missingReasons,
    observedSince,
    observedWindowMs: null,
    leadTimeMs: null,
    leadTimeOpen: false,
    cycleTimeMs: null,
    cycleTimeOpen: false,
    stageDurations: [],
    reworkCount: 0,
    blockedTimeMs: null,
    blockedRatio: null,
    blockedEvidenceEventIds: [],
    evidenceEventIds: [],
    eventWindow: {
      total: eventTotal,
      limit: eventLimit,
      truncated: Boolean(eventTruncated),
      startAt: eventWindowStartAt,
    },
  }
}

export function missingExecutionMetrics({
  reasons = ['没有可用事件'],
  observedSince = null,
  eventTotal = 0,
  eventLimit = 1000,
  eventTruncated = false,
  eventWindowStartAt = null,
} = {}) {
  return emptyMetrics({
    missingReasons: reasons,
    observedSince,
    eventTotal,
    eventLimit,
    eventTruncated,
    eventWindowStartAt,
  })
}

export function summarizeExecutionMetrics(metrics) {
  return {
    completeness: metrics?.completeness || 'missing',
    leadTimeMs: metrics?.leadTimeMs ?? null,
    leadTimeOpen: Boolean(metrics?.leadTimeOpen),
    cycleTimeMs: metrics?.cycleTimeMs ?? null,
    cycleTimeOpen: Boolean(metrics?.cycleTimeOpen),
    reworkCount: Number(metrics?.reworkCount || 0),
    blockedRatio: metrics?.blockedRatio ?? null,
    missingReasonCount: Array.isArray(metrics?.missingReasons) ? metrics.missingReasons.length : 0,
  }
}

export function computeExecutionMetrics({
  events = [],
  dependencies = [],
  archived = false,
  archivedAt = null,
  now = new Date(),
  eventTotal = events.length,
  eventLimit = 1000,
  eventTruncated = false,
  eventWindowStartAt = null,
} = {}) {
  const sorted = [...events].sort(compareEvents)
  const trackingEvent = sorted.find((event) => event.type === 'tracking_started') || null
  const trackingStartedAt = trackingEvent?.occurredAt || null
  const trackingMs = timestamp(trackingStartedAt)
  const { nodes, unreadable } = stageEventNodes(sorted)
  if (!nodes.length) {
    return emptyMetrics({
      missingReasons: [
        sorted.length ? '没有阶段变化事件；tracking_started 不计作阶段停留' : '没有可用事件',
      ],
      observedSince: trackingStartedAt,
      eventTotal,
      eventLimit,
      eventTruncated,
      eventWindowStartAt,
    })
  }

  const nowMs = now instanceof Date ? now.getTime() : timestamp(now)
  const archiveMs = archived ? timestamp(archivedAt) : null
  let endMs = archiveMs ?? nowMs
  const observedSince = trackingStartedAt || nodes[0].occurredAt
  const observedStartMs = trackingMs ?? nodes[0].occurredMs
  const missingReasons = []
  if (eventTruncated) {
    missingReasons.push('事件超过 1,000 条，指标只覆盖最近窗口')
  }
  if (trackingMs == null) {
    missingReasons.push('缺少 tracking_started 追踪起点')
  }
  if (unreadable) {
    missingReasons.push(`有 ${unreadable} 条阶段事件无法解析`)
  }
  if (archived && (archiveMs == null || archiveMs < nodes.at(-1).occurredMs)) {
    missingReasons.push(
      archiveMs == null ? '缺少可信归档终点' : '归档时间早于最后阶段事件，无法确认结束区间',
    )
    endMs = nodes.at(-1).occurredMs
  }

  let reworkCount = 0
  let previousStageIndex = null
  nodes.forEach((node) => {
    if (previousStageIndex == null) {
      previousStageIndex = node.stageIndex
      return
    }
    const difference = node.stageIndex - previousStageIndex
    if (difference < 0) reworkCount += 1
    if (difference > 1) {
      missingReasons.push(
        `扫描从 ${STAGES[previousStageIndex].label} 跨到 ${node.label}，中间阶段停留无法精确拆分`,
      )
    }
    previousStageIndex = node.stageIndex
  })

  const implementNode = nodes.find((node) => node.stageId === 'implement') || null
  const checkNode = implementNode
    ? nodes.find(
        (node) => node.stageId === 'check' && node.occurredMs >= implementNode.occurredMs,
      ) || null
    : null
  if (!implementNode) missingReasons.push('缺少实现阶段事件')
  if (!checkNode) missingReasons.push('缺少检查阶段完成事件')

  const completeness = missingReasons.length ? 'partial' : 'tracked'
  const leadTimeMs =
    endMs != null && endMs >= nodes[0].occurredMs ? endMs - nodes[0].occurredMs : null
  const cycleTimeMs =
    implementNode && endMs != null
      ? Math.max(0, (checkNode?.occurredMs ?? endMs) - implementNode.occurredMs)
      : null
  const stageDurations = nodes.map((node, index) => {
    const next = nodes[index + 1]
    const durationEnd = next?.occurredMs ?? endMs
    return {
      stageId: node.stageId,
      label: node.label,
      durationMs:
        durationEnd != null && durationEnd >= node.occurredMs
          ? durationEnd - node.occurredMs
          : null,
      open: !next && !archived,
      startedAt: node.occurredAt,
      eventId: node.eventId,
    }
  })

  let blockedTimeMs = null
  let blockedRatio = null
  let blockedEvidenceEventIds = []
  if (observedStartMs != null && endMs != null && endMs >= observedStartMs) {
    const merged = mergedBlockedIntervals(dependencies, observedStartMs, endMs)
    blockedTimeMs = merged.reduce((total, interval) => total + interval.end - interval.start, 0)
    const observedWindowMs = endMs - observedStartMs
    blockedRatio = observedWindowMs > 0 ? Math.min(1, blockedTimeMs / observedWindowMs) : 0
    const dependencyIds = new Set(merged.flatMap((interval) => interval.ids))
    blockedEvidenceEventIds = sorted
      .filter(
        (event) =>
          ['dependency_created', 'dependency_resolved'].includes(event.type) &&
          dependencyIds.has(event.payload?.dependencyId),
      )
      .map((event) => Number(event.id))
  }

  const evidenceEventIds = [
    ...new Set([
      ...(trackingEvent ? [Number(trackingEvent.id)] : []),
      ...nodes.map((node) => node.eventId),
      ...blockedEvidenceEventIds,
    ]),
  ].sort((left, right) => left - right)

  return {
    completeness,
    missingReasons: [...new Set(missingReasons)],
    observedSince,
    observedWindowMs:
      observedStartMs != null && endMs != null && endMs >= observedStartMs
        ? endMs - observedStartMs
        : null,
    leadTimeMs,
    leadTimeOpen: !archived,
    cycleTimeMs,
    cycleTimeOpen: !checkNode,
    stageDurations,
    reworkCount,
    blockedTimeMs,
    blockedRatio,
    blockedEvidenceEventIds,
    evidenceEventIds,
    eventWindow: {
      total: eventTotal,
      limit: eventLimit,
      truncated: Boolean(eventTruncated),
      startAt: eventWindowStartAt,
    },
  }
}
