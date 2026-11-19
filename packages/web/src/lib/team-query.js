export const TEAM_PAGE_LIMIT = 100

const ARRAY_FILTERS = [
  ['projectIds', 'projectIds'],
  ['priorities', 'priorities'],
  ['stages', 'stages'],
  ['tags', 'tags'],
]

export function buildTaskQuery(filters = {}, { limit = TEAM_PAGE_LIMIT, cursor = null } = {}) {
  const params = new URLSearchParams()
  const add = (key, value) => {
    if (value == null || value === '' || value === false) return
    params.set(key, String(value))
  }
  add('teamId', filters.teamId && filters.teamId !== 'all' ? filters.teamId : null)
  add(
    'taskSpaceId',
    filters.taskSpaceId && filters.taskSpaceId !== 'all' ? filters.taskSpaceId : null,
  )
  add('scope', filters.scope === 'mine' ? 'mine' : 'all')
  if (filters.projectId && filters.projectId !== 'all') {
    add('projectIds', filters.projectId)
  }
  for (const [key] of ARRAY_FILTERS) {
    const value = filters[key]
    if (Array.isArray(value) && value.length) add(key, value.join(','))
    else if (typeof value === 'string' && value.trim()) add(key, value.trim())
  }
  const priorities = filters.priorities ?? filters.priority
  const stages = filters.stages ?? filters.stage
  add('priorities', Array.isArray(priorities) ? priorities.join(',') : priorities?.trim())
  add('stages', Array.isArray(stages) ? stages.join(',') : stages?.trim())
  add('q', filters.q?.trim())
  add('branch', filters.branch?.trim())
  add('assignee', filters.assignee?.trim())
  add('dueWithinDays', filters.dueWithinDays)
  add('staleDays', filters.staleDays)
  add('blocked', filters.blocked && filters.blocked !== 'any' ? filters.blocked : null)
  add('archived', filters.archived === true ? '1' : null)
  add('preset', filters.preset)
  add('limit', Math.max(1, Math.min(200, Number(limit) || TEAM_PAGE_LIMIT)))
  add('cursor', cursor)
  return params.toString()
}

export function archiveAssigneeOptions(assignees = [], selected = '') {
  const values = [
    String(selected || '').trim(),
    ...(Array.isArray(assignees) ? assignees.map(String) : []),
  ].filter(Boolean)
  return [
    { value: '__all', label: '全部负责人' },
    ...[...new Set(values)].map((value) => ({ value, label: value })),
  ]
}

function projectBoardVersion(status, projectId) {
  if (!projectId || projectId === 'all') return null
  const versions = status?.boardVersions ?? status?.board_versions
  if (versions && Object.hasOwn(versions, projectId)) return versions[projectId]
  const projects = status?.projects ?? status?.items
  if (!Array.isArray(projects)) return null
  const project = projects.find(
    (item) => (item.id ?? item.projectId ?? item.project_id) === projectId,
  )
  return project?.boardVersion ?? project?.board_version ?? null
}

export function shouldReloadTasks(previous, next, projectId = 'all') {
  if (!previous || !next) return true
  const previousRevision = previous.queryRevision ?? previous.query_revision
  const nextRevision = next.queryRevision ?? next.query_revision
  if (previousRevision !== nextRevision) return true
  const previousDay = previous.queryDay ?? previous.query_day
  const nextDay = next.queryDay ?? next.query_day
  if (previousDay !== nextDay) return true
  return projectBoardVersion(previous, projectId) !== projectBoardVersion(next, projectId)
}
