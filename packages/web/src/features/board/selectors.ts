import { groupActiveTasks, type BoardTask } from './task-view.ts'
import { branchMatches, findView, taskMatchesView, taskTagNames } from '@/lib/execution-filter.js'
import type { BoardFilters } from '@/hooks/board-types.ts'

export type BoardView = 'pipeline' | 'team' | 'archive' | 'plugins'

export function activeTasks(tasks: BoardTask[]) {
  return tasks.filter((task) => !task.archived)
}

export function archivedTasks(tasks: BoardTask[]) {
  return tasks.filter((task) => task.archived)
}

export function filterTasks(
  tasks: BoardTask[],
  filters: BoardFilters,
  projects: { id: string; developer?: string | null }[],
  savedViews: unknown[],
  options: { scopedByServer?: boolean } = {},
) {
  const search = filters.search.toLowerCase()
  const developerByProject = new Map(
    projects.map((project) => [project.id, project.developer || null]),
  )
  const now = new Date()
  const view =
    filters.executionView === 'all' ? null : findView(savedViews || [], filters.executionView)
  const matches = (task: BoardTask) => {
    const hit =
      !search ||
      [
        task.title,
        task.description,
        task.assignee,
        task.teamName,
        task.projectName,
        task.projectId,
        task.execution?.milestone,
        ...taskTagNames(task),
      ].some((value) =>
        String(value || '')
          .toLowerCase()
          .includes(search),
      )
    const projectHit = filters.projectId === 'all' || task.projectId === filters.projectId
    const branchHit = branchMatches(task.branchName, filters.branch)
    const ownerHit =
      filters.scope !== 'mine' ||
      options.scopedByServer === true ||
      Boolean(task.assignee && task.assignee === developerByProject.get(task.projectId))
    const assigneeHit = !filters.assignee || task.assignee === filters.assignee
    const priorityHit = !filters.priority || task.priority === filters.priority
    const stageHit = !filters.stage || task.derivedStage === filters.stage
    const blockedHit =
      filters.blocked === 'any' ||
      (filters.blocked === 'blocked'
        ? Boolean(task.execution?.isBlocked)
        : !task.execution?.isBlocked)
    const viewHit = !view || taskMatchesView(task, view, now)
    return (
      hit &&
      projectHit &&
      branchHit &&
      ownerHit &&
      assigneeHit &&
      priorityHit &&
      stageHit &&
      blockedHit &&
      viewHit
    )
  }
  return groupActiveTasks(activeTasks(tasks)).flatMap((group) => {
    const hitMembers = group.members.filter(matches)
    if (!hitMembers.length) return []
    const includeParent = hitMembers.some(
      (task) => task.groupRole === 'parent' || task.parentTaskKey === group.parent.taskKey,
    )
    return includeParent ? group.members : hitMembers
  })
}

export function filterGroups(
  tasks: BoardTask[],
  filters: BoardFilters,
  projects: { id: string; developer?: string | null }[],
  savedViews: unknown[],
  options: { scopedByServer?: boolean } = {},
) {
  return groupActiveTasks(filterTasks(tasks, filters, projects, savedViews, options))
}

export function tasksByOwner(tasks: BoardTask[]) {
  const grouped = new Map<string, BoardTask[]>()
  tasks.forEach((task) => {
    const owner = task.assignee || '未派发'
    if (!grouped.has(owner)) grouped.set(owner, [])
    grouped.get(owner)!.push(task)
  })
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
}
