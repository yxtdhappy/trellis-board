import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  api,
  acceptTask,
  addRepositories,
  assignTaskRequest,
  createTaskRequest,
  fetchAssignments,
  fetchBoardSettings,
  fetchRepositories,
  fetchSavedViews,
  fetchTeamStatus,
  pickFolders,
  queryTeamTasks,
  removeRepository,
  saveWipLimit,
  saveSavedView,
  deleteSavedView,
  createDependency,
  removeDependency,
  fetchTaskOperation,
  fetchTaskOperations,
  retryTaskOperation,
  cancelTaskOperation,
} from '@/api/board'
import type { BoardPayload, BoardStatus, Project, TeamQueryPage, TeamRuntime } from '@/api/board'
import { teamRowToBoardTask, type BoardTask } from '@/features/board/task-view'
import { ApiError } from '@/api/request'
import { withBasePath } from '@/lib/base-path.js'
import { normalizeOwnershipInboxCount, summarizeOwnershipInbox } from '@/lib/ownership-inbox.js'

import {
  buildTaskQuery,
  createIdempotencyKey,
  normalizeOperation,
  isActiveOperation,
  isCompleteOperation,
  operationPollDelay,
} from '@/lib/team-client.js'
import { createRefreshCoordinator } from '@/lib/refresh-coordinator.js'
import { useOwnershipInbox } from './useOwnershipInbox.ts'
import type { BoardController, BoardFilters, PublishOperation } from './board-types.ts'

const BUILTIN_VIEW_IDS = ['all', 'p0p1', 'due', 'stale', 'implementing', 'blocked'] as const

export function useBoard(): BoardController {
  const [board, setBoard] = useState<BoardPayload | null>(null)
  const [status] = useState<BoardStatus | null>(null)
  const [runtime, setRuntime] = useState<TeamRuntime | null>(null)
  const [teamPage, setTeamPage] = useState<TeamQueryPage | null>(null)
  const [teamStatus, setTeamStatus] = useState<Record<string, unknown> | null>(null)
  const [assignments, setAssignments] = useState<unknown[]>([])
  const [operation, setOperation] = useState<PublishOperation | null>(null)
  const [operations, setOperations] = useState<PublishOperation[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [filters, setFiltersState] = useState<BoardFilters>({
    teamId: 'all',
    projectId: 'all',
    taskSpaceId: 'all',
    scope: 'all',
    search: '',
    branch: '',
    assignee: '',
    priority: '',
    stage: '',
    blocked: 'any',
    executionView: 'all',
  })

  const operationAttempt = useRef(0)
  const boardEtag = useRef<string | null>(null)
  const teamStatusEtag = useRef<string | null>(null)
  const teamStatusSignature = useRef('')
  const teamCursors = useRef<(string | null)[]>([null])
  const teamPageIndex = useRef(0)
  const teamPageRequest = useRef(0)
  const operationsRequest = useRef(0)
  const operationsSignature = useRef('[]')
  const teamPreferenceRequest = useRef(0)
  const teamStatusRefresh = useMemo(
    () =>
      createRefreshCoordinator(async () => {
        try {
          const result = await fetchTeamStatus(teamStatusEtag.current)
          if (result.notModified || !result.status) return
          teamStatusEtag.current = result.etag
          const signature = JSON.stringify(result.status)
          if (signature === teamStatusSignature.current) return
          teamStatusSignature.current = signature
          setTeamStatus(result.status)
        } catch {
          /* 状态刷新失败不打断主流程 */
        }
      }),
    [],
  )

  const inbox = useOwnershipInbox({
    teamId: filters.teamId,
    projectId: filters.projectId,
  })

  useEffect(() => {
    teamStatusRefresh.activate()
    return () => teamStatusRefresh.dispose()
  }, [teamStatusRefresh])

  const loadTeamPage = useCallback(
    async (quiet = false) => {
      const request = ++teamPageRequest.current
      if (!quiet) setLoading(true)
      try {
        const cursor = teamCursors.current[teamPageIndex.current] || null
        const query = buildTaskQuery({ ...filters, q: filters.search }, { limit: 100, cursor })
        const result = await queryTeamTasks(String(query), boardEtag.current)
        if (request !== teamPageRequest.current) return
        if (result.notModified || !result.page) return
        boardEtag.current = result.etag
        setTeamPage(result.page)
        if (result.page.nextCursor) {
          teamCursors.current[teamPageIndex.current + 1] = result.page.nextCursor
        }
        setError('')
      } catch (err) {
        if (request !== teamPageRequest.current) return
        setError((err as Error).message)
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          setTeamPage(null)
          boardEtag.current = null
          teamCursors.current = [null]
          setBoard((current) => (current ? { ...current, savedViews: [], settings: {} } : current))
        }
      } finally {
        if (request === teamPageRequest.current && !quiet) setLoading(false)
      }
    },
    [filters],
  )

  const loadTeamPreferences = useCallback(async () => {
    const request = ++teamPreferenceRequest.current
    let savedViews: unknown[] = []
    let settings: { teamId?: string | null; executionWipLimit?: number } | null = null
    try {
      ;[savedViews, settings] = await Promise.all([
        fetchSavedViews(filters.teamId),
        fetchBoardSettings(filters.teamId),
      ])
    } catch (err) {
      if (request !== teamPreferenceRequest.current) return
      throw err
    }
    if (request !== teamPreferenceRequest.current) return
    setBoard((current) => ({
      projects: current?.projects || [],
      tasks: current?.tasks || [],
      ...current,
      savedViews,
      settings: {
        executionWipLimit: settings?.executionWipLimit,
      },
    }))
  }, [filters.teamId])

  const loadTeamStatus = useCallback(() => teamStatusRefresh.request(), [teamStatusRefresh])

  const replaceOperations = useCallback((next: PublishOperation[]) => {
    const signature = JSON.stringify(next)
    if (signature === operationsSignature.current) return
    operationsSignature.current = signature
    setOperations(next)
  }, [])

  const clearOperations = useCallback(() => replaceOperations([]), [replaceOperations])

  const loadOperations = useCallback(async () => {
    if (filters.taskSpaceId === 'all') {
      operationsRequest.current += 1
      clearOperations()
      return
    }
    const request = ++operationsRequest.current
    try {
      const result = await fetchTaskOperations(filters.taskSpaceId)
      if (request !== operationsRequest.current) return
      const next = (result?.operations || []).map(
        (item) => normalizeOperation(item) as PublishOperation,
      )
      replaceOperations(next)
    } catch {
      // 操作列表失败不覆盖正式任务查询结果。
    }
  }, [filters.taskSpaceId, clearOperations, replaceOperations])

  const loadAssignments = useCallback(async () => {
    try {
      const payload = await fetchAssignments()
      setAssignments(payload?.assignments || [])
    } catch {
      /* 待接受队列加载失败由页面提示 */
    }
  }, [])

  useEffect(() => {
    let active = true
    api<TeamRuntime>('/api/runtime')
      .then((data) => {
        if (active && data) setRuntime(data)
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : '读取运行时信息失败')
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!runtime) return
    void loadTeamPage(true)
    void loadAssignments()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 初始化一次并加载权威快照
  }, [runtime])

  const alignBoard = useCallback(async () => {
    await Promise.all([loadTeamPage(true), loadTeamStatus()])
    if (inbox.openRef.current) await inbox.reload()
  }, [loadTeamPage, loadTeamStatus, inbox.reload])

  const alignBoardRef = useRef(alignBoard)
  useEffect(() => {
    alignBoardRef.current = alignBoard
  }, [alignBoard])

  useEffect(() => {
    if (!runtime) return
    let timer = 0
    const align = () => {
      if (timer) window.clearTimeout(timer)
      timer = 0
      void alignBoardRef.current()
    }
    const scheduleAlign = () => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(align, 100)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') scheduleAlign()
    }
    const events = new EventSource(withBasePath('/api/board/events'))
    events.onopen = align
    events.addEventListener('tasks.changed', scheduleAlign)
    window.addEventListener('focus', scheduleAlign)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      events.close()
      if (timer) window.clearTimeout(timer)
      window.removeEventListener('focus', scheduleAlign)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [runtime])

  useEffect(() => {
    let timer = 0
    const schedule = () => {
      if (timer) window.clearTimeout(timer)
      timer = 0
      if (document.visibilityState === 'visible') {
        timer = window.setTimeout(() => {
          void loadTeamStatus()
          schedule()
        }, 10_000)
      }
    }
    const onVisibilityChange = () => schedule()
    void loadTeamStatus()
    schedule()
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      if (timer) window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [loadTeamStatus])

  useEffect(() => {
    void loadTeamPage(true)
  }, [filters, loadTeamPage])

  useEffect(() => {
    void loadTeamPreferences().catch((err: unknown) => {
      setError((err as Error).message)
    })
  }, [loadTeamPreferences])

  useEffect(() => {
    if (filters.taskSpaceId === 'all') {
      clearOperations()
      return
    }
    void loadOperations()
    const timer = window.setInterval(() => void loadOperations(), 3_000)
    return () => {
      operationsRequest.current += 1
      window.clearInterval(timer)
    }
  }, [filters.taskSpaceId, loadOperations, clearOperations])

  const reloadCurrentSource = useCallback(async () => {
    await loadTeamPage(true)
  }, [loadTeamPage])

  const trackOperation = useCallback(
    (payload: unknown) => {
      const next = normalizeOperation(payload) as PublishOperation
      if (!next?.id && !next?.status) return false
      operationAttempt.current = 0
      setOperation(next)
      void loadOperations()
      return true
    },
    [loadOperations],
  )

  useEffect(() => {
    if (!operation?.id || !isActiveOperation(operation)) return
    let cancelled = false
    const attempt = operationAttempt.current
    operationAttempt.current += 1
    const timer = window.setTimeout(async () => {
      try {
        const next = normalizeOperation(
          await fetchTaskOperation(String(operation.id)),
        ) as PublishOperation
        if (cancelled) return
        setOperation(next)
        if (isCompleteOperation(next)) {
          await reloadCurrentSource()
          await loadTeamStatus()
          await loadOperations()
        }
      } catch (err) {
        if (!cancelled) {
          setOperation((current) =>
            current ? { ...current, error: (err as Error).message } : current,
          )
        }
      }
    }, operationPollDelay(attempt))
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [operation, reloadCurrentSource, loadTeamStatus, loadOperations])

  const setFilters = useCallback(
    (patch: Partial<BoardFilters>) => {
      const nextTeamId = patch.teamId ?? filters.teamId
      const nextProjectId =
        patch.teamId !== undefined && patch.projectId === undefined
          ? 'all'
          : (patch.projectId ?? filters.projectId)
      const ownershipScopeChanged =
        nextTeamId !== filters.teamId || nextProjectId !== filters.projectId
      setFiltersState((current) => {
        const next = { ...current, ...patch }
        if (patch.teamId !== undefined && patch.projectId === undefined) {
          next.projectId = 'all'
          next.taskSpaceId = 'all'
        }
        if (patch.projectId !== undefined && patch.taskSpaceId === undefined) {
          next.taskSpaceId = 'all'
        }
        if (patch.teamId !== undefined && patch.executionView === undefined) {
          next.executionView = 'all'
        }
        return next
      })
      teamPageIndex.current = 0
      teamCursors.current = [null]
      boardEtag.current = null
      teamPageRequest.current += 1
      if (
        patch.taskSpaceId !== undefined ||
        patch.projectId !== undefined ||
        patch.teamId !== undefined
      ) {
        operationsRequest.current += 1
        clearOperations()
      }
      if (ownershipScopeChanged) {
        inbox.clear()
      }
      if (patch.teamId !== undefined) {
        teamPreferenceRequest.current += 1
        setTeamPage(null)
        setBoard((current) => (current ? { ...current, savedViews: [], settings: {} } : current))
      }
    },
    [clearOperations, inbox.clear, filters.teamId, filters.projectId],
  )

  const actions = useMemo(
    () => ({
      refresh: async () => {
        await loadTeamPage(false)
        await loadTeamStatus()
        if (inbox.openRef.current) await inbox.reload()
      },
      saveWip: async (limit: number) => {
        await saveWipLimit(limit, filters.teamId)
        await loadTeamPreferences()
      },
      createTask: async (payload: Record<string, unknown>) => {
        const idempotencyKey =
          typeof payload.idempotencyKey === 'string' && payload.idempotencyKey
            ? payload.idempotencyKey
            : createIdempotencyKey()
        const result = await createTaskRequest({
          ...payload,
          taskSpaceId:
            payload.taskSpaceId ||
            (filters.taskSpaceId !== 'all' ? filters.taskSpaceId : undefined),
          idempotencyKey,
        })
        trackOperation(result)
        await reloadCurrentSource()
      },
      assign: async (payload: Record<string, unknown>) => {
        const result = await assignTaskRequest({
          ...payload,
          taskSpaceId:
            payload.taskSpaceId ||
            (filters.taskSpaceId !== 'all' ? filters.taskSpaceId : undefined),
        })
        trackOperation(result)
        await reloadCurrentSource()
      },
      addDependency: async (payload: {
        blocked: { taskSpaceId: string; executionTaskKey?: string; taskPath?: string }
        blocker: { taskSpaceId: string; executionTaskKey?: string; taskPath?: string }
        reason: string
        assigneeDecision?: { warningId: string; action: 'continue' | 'takeover' }
      }) => {
        await createDependency(payload)
        await reloadCurrentSource()
      },
      removeDependency: async (
        id: string,
        assigneeDecision?: { warningId: string; action: 'continue' | 'takeover' },
      ) => {
        await removeDependency(id, assigneeDecision)
        await reloadCurrentSource()
      },
      saveView: async (name: string, viewFilter: Record<string, unknown>) => {
        const saved = await saveSavedView({
          name,
          filter: viewFilter,
          teamId: filters.teamId,
        })
        await reloadCurrentSource()
        await loadTeamPreferences()
        return saved?.view?.id ?? ''
      },
      deleteView: async (id: string) => {
        await deleteSavedView(id, filters.teamId)
        if (filters.executionView === id) {
          setFiltersState((current) => ({ ...current, executionView: 'all' }))
        }
        await reloadCurrentSource()
        await loadTeamPreferences()
      },
      retryOperation: async (id?: string) => {
        const operationId = id || operation?.id
        if (!operationId) return
        operationAttempt.current = 0
        setOperation(
          normalizeOperation(await retryTaskOperation(String(operationId))) as PublishOperation,
        )
        await loadOperations()
      },
      cancelOperation: async (id: string) => {
        await cancelTaskOperation(id)
        await loadOperations()
      },
      dismissOperation: () => setOperation(null),
      accept: async (payload: unknown) => {
        await acceptTask(payload)
        await loadAssignments()
        await loadTeamPage(true)
      },
      reloadAssignments: loadAssignments,
      repositories: {
        list: fetchRepositories,
        pick: pickFolders,
        add: async (paths: string[]) => {
          await addRepositories(paths)
          await loadTeamPage(false)
        },
        remove: async (id: string) => {
          await removeRepository(id)
          await loadTeamPage(false)
        },
      },
    }),
    [
      loadTeamPage,
      loadTeamPreferences,
      loadTeamStatus,
      inbox.reload,
      loadAssignments,
      reloadCurrentSource,
      trackOperation,
      operation,
      loadOperations,
      filters.teamId,
      filters.taskSpaceId,
      filters.executionView,
    ],
  )

  const teamProjects = useMemo<Project[]>(() => {
    type TeamProjectRow = {
      id?: string
      name?: string
      path?: string
      teamId?: string
      teamName?: string
      syncBranch?: string | null
      taskSpaces?: Project['taskSpaces']
      ownershipInboxCount?: unknown
      ownership_inbox_count?: unknown
    }
    const rows = [
      ...((teamStatus?.projects as TeamProjectRow[] | undefined) || []),
      ...((teamStatus?.associationProjects as TeamProjectRow[] | undefined) || []),
    ]
    const unique = new Map<string, TeamProjectRow>()
    rows.forEach((row) => {
      if (row?.id && !unique.has(row.id)) unique.set(row.id, row)
    })
    return [...unique.values()]
      .filter(
        (
          row,
        ): row is {
          id: string
          name?: string
          path?: string
          teamId?: string
          teamName?: string
          syncBranch?: string | null
          taskSpaces?: Project['taskSpaces']
          ownershipInboxCount?: unknown
          ownership_inbox_count?: unknown
        } => Boolean(row?.id) && (filters.teamId === 'all' || row.teamId === filters.teamId),
      )
      .map((row) => ({
        ...row,
        id: row.id,
        name: row.name || row.id,
        path: row.path || '',
        syncBranch: row.syncBranch || null,
        ownershipInboxCount: normalizeOwnershipInboxCount(
          row.ownershipInboxCount ?? row.ownership_inbox_count,
        ),
      }))
  }, [teamStatus, filters.teamId])
  const projects: Project[] = teamProjects
  const ownershipInboxSummary = useMemo(
    () => summarizeOwnershipInbox(projects, filters.projectId),
    [projects, filters.projectId],
  )

  const toggleOwnershipInbox = useCallback(
    (projectId: string) => {
      const scope = projectId || 'all'
      const sameScope = filters.projectId === scope
      inbox.toggle(sameScope)
      if (!sameScope) setFilters({ projectId: scope })
    },
    [filters.projectId, setFilters],
  )

  useEffect(() => {
    if (inbox.open && ownershipInboxSummary.count === 0) inbox.clear()
  }, [inbox.open, ownershipInboxSummary.count, inbox.clear])

  useEffect(() => {
    if (projects.length === 0 || filters.projectId === 'all') return
    if (!projects.some((project) => project.id === filters.projectId)) {
      setFilters({ projectId: projects[0].id, taskSpaceId: 'all' })
    }
  }, [projects, filters.projectId, setFilters])

  const tasks = useMemo<BoardTask[]>(() => {
    return (teamPage?.tasks || []).map((row) => teamRowToBoardTask(row as Record<string, unknown>))
  }, [teamPage?.tasks])

  return {
    board,
    tasks,
    projects,
    status,
    runtime,
    teamPage,
    teamStatus,
    ownershipInbox: {
      count: ownershipInboxSummary.count,
      projectGroups: ownershipInboxSummary.groups,
      open: inbox.open,
      items: inbox.items,
      total: inbox.total,
      nextCursor: inbox.nextCursor,
      loading: inbox.loading,
      loadingMore: inbox.loadingMore,
      error: inbox.error,
      toggle: toggleOwnershipInbox,
      reload: inbox.reload,
      loadMore: inbox.loadMore,
    },
    assignments,
    filters,
    setFilters,
    error,
    loading,
    operation,
    operations,
    actions,
    builtinViews: BUILTIN_VIEW_IDS,
  }
}
