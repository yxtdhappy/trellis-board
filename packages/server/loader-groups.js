import path from 'node:path'
import { deriveCurrentStageFromStages } from './loader-stage.js'

export function normalizePath(value) {
  return path.resolve(value).replaceAll('\\', '/').toLowerCase()
}

function archivePathVariants(value) {
  const normalized = String(value || '')
    .replaceAll('\\', '/')
    .replace(/\/+$/, '')
  const marker = '/.trellis/tasks/'
  const markerIndex = normalized.toLowerCase().indexOf(marker)
  if (markerIndex < 0) return []
  return [...normalized.matchAll(/\/archive\/\d{4}-\d{2}\//gi)].map((match) => {
    const archiveSegment = match[0]
    return {
      path:
        normalized.slice(0, match.index) +
        '/' +
        normalized.slice(match.index + archiveSegment.length),
      sourcePath: normalized,
      archiveSegment,
    }
  })
}

function taskAbsolutePath(task) {
  return path.resolve(task.repoPath, task.relativeDir)
}

const META_CHILD_TASK_KEYS = new Set([
  'backendtask',
  'backendtasks',
  'childtask',
  'childtasks',
  'frontendtask',
  'frontendtasks',
  'integrationtask',
  'integrationtasks',
  'uitask',
  'uitasks',
])

function resolveTaskReference(sourceTask, reference, resolvePath, byProjectRef) {
  const raw = String(reference || '').trim()
  if (!raw) return null
  if (path.isAbsolute(raw) || /[\\/]\.trellis[\\/]tasks[\\/]/i.test(raw)) {
    const direct = resolvePath(raw)
    if (direct) return direct
    const archiveVariants = archivePathVariants(raw)
    const archiveHits = archiveVariants.map((variant) => resolvePath(variant.path)).filter(Boolean)
    return new Set(archiveHits).size === 1 ? archiveHits[0] : null
  }
  const projectIndex = byProjectRef.get(sourceTask.projectId)
  const hits = projectIndex?.get(raw)
  return hits?.size === 1 ? [...hits][0] : null
}

function flattenReferences(value) {
  if (Array.isArray(value)) return value.flatMap(flattenReferences)
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return []
}

function collectRelationshipCandidates(task) {
  const candidates = []
  if (task.parent) {
    candidates.push({
      parentReference: task.parent,
      childTask: task,
      source: 'task-json',
      field: 'parent',
    })
  }
  flattenReferences(task.children).forEach((reference) => {
    candidates.push({
      parentTask: task,
      childReference: reference,
      source: 'task-json',
      field: 'children',
    })
  })
  Object.entries(task.meta || {}).forEach(([key, value]) => {
    const normalizedKey = key.toLowerCase()
    const references = flattenReferences(value)
    if (!references.length) return
    if (/(?:parenttask|parenttasks)$/i.test(key)) {
      references.forEach((reference) => {
        candidates.push({
          parentReference: reference,
          childTask: task,
          source: 'meta',
          field: `meta.${key}`,
        })
      })
      return
    }
    if (META_CHILD_TASK_KEYS.has(normalizedKey)) {
      references.forEach((reference) => {
        candidates.push({
          parentTask: task,
          childReference: reference,
          source: 'meta',
          field: `meta.${key}`,
        })
      })
    }
  })
  return candidates
}

function applyGroupProgress(parent, members) {
  const children = members.filter((task) => task.taskKey !== parent.taskKey)
  if (!children.length) return parent
  const stageMap = new Map(parent.stages.map((stage) => [stage.id, stage]))
  const childStageComplete = (id) =>
    children.every((child) => child.stages.find((stage) => stage.id === id)?.complete)
  const childStageEntered = (id) =>
    children.some((child) => child.stages.find((stage) => stage.id === id)?.complete)
  const assignments = [
    {
      id: 'review',
      complete: childStageEntered('review'),
      evidence: `${children.length} 个子任务中已有任务进入开发`,
    },
    {
      id: 'implement',
      complete: childStageComplete('implement'),
      evidence: `${children.length} 个子任务均已确认进入实现，父任务继承子任务组进度`,
    },
    {
      id: 'check',
      complete: childStageComplete('check'),
      evidence: `${children.length} 个子任务的检查阶段均已完成，父任务继承子任务组进度`,
    },
    {
      id: 'e2e',
      complete: childStageComplete('e2e'),
      evidence: `${children.length} 个子任务的真实 E2E 均已完成，父任务继承子任务组进度`,
    },
    {
      id: 'spec',
      complete: childStageComplete('spec'),
      evidence: `${children.length} 个子任务的规范回写均已确认，父任务继承子任务组进度`,
    },
    {
      id: 'commit',
      complete: childStageComplete('commit'),
      evidence: `${children.length} 个子任务的工作提交均已登记，父任务继承子任务组进度`,
    },
  ]
  assignments.forEach((assignment) => {
    const current = stageMap.get(assignment.id)
    if (assignment.complete && !current?.complete) {
      stageMap.set(assignment.id, {
        ...current,
        complete: true,
        source: 'group-child',
        evidence: assignment.evidence,
      })
    }
  })
  const stages = parent.stages.map((stage) => stageMap.get(stage.id))
  return {
    ...parent,
    stages,
    derivedStage: deriveCurrentStageFromStages(stages),
  }
}

export function linkTaskGroups(results) {
  const tasks = results.flatMap((result) => result.tasks)
  const byPath = new Map()
  const registerPath = (value, task) => {
    const key = normalizePath(value)
    if (!byPath.has(key)) byPath.set(key, new Set())
    byPath.get(key).add(task)
  }
  tasks.forEach((task) => {
    const absolutePath = taskAbsolutePath(task)
    registerPath(absolutePath, task)
    archivePathVariants(absolutePath).forEach((variant) => registerPath(variant.path, task))
  })
  const resolvePath = (value) => {
    const hits = byPath.get(normalizePath(value))
    return hits?.size === 1 ? [...hits][0] : null
  }
  const byProjectRef = new Map()
  tasks.forEach((task) => {
    if (!byProjectRef.has(task.projectId)) byProjectRef.set(task.projectId, new Map())
    const projectIndex = byProjectRef.get(task.projectId)
    ;[task.id, task.dirName, task.name].filter(Boolean).forEach((reference) => {
      if (!projectIndex.has(reference)) projectIndex.set(reference, new Set())
      projectIndex.get(reference).add(task)
    })
  })

  const tasksByKey = new Map(tasks.map((task) => [task.taskKey, task]))
  const edges = new Map()
  const warningsByTask = new Map()
  const addWarning = (taskKey, warning) => {
    if (!warningsByTask.has(taskKey)) warningsByTask.set(taskKey, [])
    const existing = warningsByTask.get(taskKey)
    if (!existing.some((item) => item.code === warning.code && item.message === warning.message)) {
      existing.push(warning)
    }
  }
  tasks.forEach((task) => {
    collectRelationshipCandidates(task).forEach((candidate) => {
      const parent =
        candidate.parentTask ||
        resolveTaskReference(task, candidate.parentReference, resolvePath, byProjectRef)
      const child =
        candidate.childTask ||
        resolveTaskReference(task, candidate.childReference, resolvePath, byProjectRef)
      const missingReference = candidate.parentTask
        ? candidate.childReference
        : candidate.parentReference
      if (!parent || !child) {
        addWarning(task.taskKey, {
          code: 'RELATION_MISSING',
          field: candidate.field,
          message: `${candidate.field} 引用的任务无法唯一解析：${missingReference}`,
        })
        return
      }
      if (parent.taskKey === child.taskKey) {
        addWarning(task.taskKey, {
          code: 'RELATION_SELF',
          field: candidate.field,
          message: `${candidate.field} 形成了任务自引用`,
        })
        return
      }
      const edgeKey = `${parent.taskKey}\0${child.taskKey}`
      if (!edges.has(edgeKey)) {
        edges.set(edgeKey, {
          parentKey: parent.taskKey,
          childKey: child.taskKey,
          sources: [],
        })
      }
      const sourceLabel = `${candidate.source}:${candidate.field}`
      const edge = edges.get(edgeKey)
      if (!edge.sources.includes(sourceLabel)) edge.sources.push(sourceLabel)
    })
  })

  const parentsByChild = new Map()
  const directChildren = new Map()
  edges.forEach((edge) => {
    if (!parentsByChild.has(edge.childKey)) parentsByChild.set(edge.childKey, new Set())
    parentsByChild.get(edge.childKey).add(edge.parentKey)
    if (!directChildren.has(edge.parentKey)) directChildren.set(edge.parentKey, new Set())
    directChildren.get(edge.parentKey).add(edge.childKey)
  })

  parentsByChild.forEach((parentKeys, childKey) => {
    if (parentKeys.size <= 1) return
    addWarning(childKey, {
      code: 'RELATION_CONFLICT',
      message: `同一任务被 ${parentKeys.size} 个父任务引用：${[...parentKeys].join('、')}`,
    })
  })

  const undirected = new Map(tasks.map((task) => [task.taskKey, new Set()]))
  edges.forEach((edge) => {
    undirected.get(edge.parentKey)?.add(edge.childKey)
    undirected.get(edge.childKey)?.add(edge.parentKey)
  })

  const componentByTask = new Map()
  const components = []
  tasks.forEach((task) => {
    if (componentByTask.has(task.taskKey)) return
    const memberKeys = []
    const pending = [task.taskKey]
    while (pending.length) {
      const key = pending.pop()
      if (componentByTask.has(key)) continue
      componentByTask.set(key, components.length)
      memberKeys.push(key)
      undirected.get(key)?.forEach((neighbor) => {
        if (!componentByTask.has(neighbor)) pending.push(neighbor)
      })
    }
    components.push(memberKeys)
  })

  function findCycleNodes(memberKeys) {
    const memberSet = new Set(memberKeys)
    const colors = new Map()
    const stack = []
    const cycleNodes = new Set()
    const visit = (key) => {
      colors.set(key, 1)
      stack.push(key)
      for (const childKey of directChildren.get(key) || []) {
        if (!memberSet.has(childKey)) continue
        if (colors.get(childKey) === 1) {
          const start = stack.indexOf(childKey)
          stack.slice(start).forEach((cycleKey) => cycleNodes.add(cycleKey))
        } else if (!colors.has(childKey)) {
          visit(childKey)
        }
      }
      stack.pop()
      colors.set(key, 2)
    }
    memberKeys.forEach((key) => {
      if (!colors.has(key)) visit(key)
    })
    return cycleNodes
  }

  const groupRootByTask = new Map()
  components.forEach((memberKeys) => {
    const cycleNodes = findCycleNodes(memberKeys)
    cycleNodes.forEach((key) => {
      addWarning(key, {
        code: 'RELATION_CYCLE',
        message: '任务父子关系形成循环，已停止父任务阶段继承，需修正 task.json',
      })
    })
    const rootCandidates = memberKeys
      .filter((key) => !parentsByChild.get(key)?.size)
      .sort((a, b) => {
        const taskA = tasksByKey.get(a)
        const taskB = tasksByKey.get(b)
        return (
          String(taskA?.createdAt || '').localeCompare(String(taskB?.createdAt || '')) ||
          a.localeCompare(b)
        )
      })
    const rootKey = rootCandidates[0] || [...memberKeys].sort()[0]
    memberKeys.forEach((key) => groupRootByTask.set(key, rootKey))
  })

  const groups = new Map()
  tasks.forEach((task) => {
    const rootKey = groupRootByTask.get(task.taskKey) || task.taskKey
    if (!groups.has(rootKey)) groups.set(rootKey, [])
    groups.get(rootKey).push(task)
  })

  const linked = []
  groups.forEach((members, groupKey) => {
    const parent = tasksByKey.get(groupKey) || members[0]
    const groupWarnings = [
      ...new Set(
        members.flatMap((task) =>
          (warningsByTask.get(task.taskKey) || []).map((warning) => warning.message),
        ),
      ),
    ]
    const canRollup = members.length > 1 && groupWarnings.length === 0
    const rollupParent = canRollup ? applyGroupProgress(parent, members) : parent
    if (rollupParent !== parent) {
      const index = members.findIndex((task) => task.taskKey === parent.taskKey)
      members[index] = rollupParent
    }
    const groupKeys = members.map((task) => task.taskKey)
    members.forEach((task) => {
      const parentKeys = [...(parentsByChild.get(task.taskKey) || [])]
      const parentKey = parentKeys.length === 1 ? parentKeys[0] : null
      linked.push({
        ...task,
        parentTaskKey: parentKey,
        parentTaskKeys: parentKeys,
        childTaskKeys: [...(directChildren.get(task.taskKey) || [])],
        groupKey,
        groupRole: task.taskKey === groupKey ? 'parent' : 'child',
        groupTaskKeys: groupKeys,
        groupSize: groupKeys.length,
        relationshipWarnings: warningsByTask.get(task.taskKey) || [],
        groupWarnings,
        groupRelationsValid: groupWarnings.length === 0,
      })
    })
  })
  const executionKeyCounts = new Map()
  linked.forEach((task) => {
    const key = String(task.executionTaskKey || '').trim()
    if (!key) return
    executionKeyCounts.set(key, (executionKeyCounts.get(key) || 0) + 1)
  })
  return linked.map((task) => {
    const key = String(task.executionTaskKey || '').trim()
    const identityConflict = !key || (executionKeyCounts.get(key) || 0) > 1
    return {
      ...task,
      executionIdentityValid: Boolean(key) && !identityConflict,
      executionIdentityConflict: identityConflict,
    }
  })
}
