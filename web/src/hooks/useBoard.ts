import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  api,
  acceptTask,
  addRepositories,
  assignTaskRequest,
  createTaskRequest,
  fetchAssignments,
  fetchBoard,
  fetchBoardSettings,
  fetchBoardStatus,
  fetchRepositories,
  fetchSavedViews,
  fetchTeamStatus,
  fetchTeamLiveRevision,
  pickFolders,
  queryTeamTasks,
  removeRepository,
  saveWipLimit,
  saveSavedView,
  deleteSavedView,
  createDependency,
  removeDependency,
  fetchGitOperation,
  retryGitOperation,
} from '@/api/board'
import type { BoardPayload, BoardStatus, Project, TeamQueryPage, TeamRuntime } from '@/api/board'
import { teamRowToBoardTask, type BoardTask } from '@/features/board/task-view'
import { ApiError } from '@/api/request'

export type BoardFilters = {
  teamId: string
  projectId: string
  scope: 'all' | 'mine'
  search: string
  assignee: string
  priority: string
  stage: string
  blocked: 'any' | 'blocked' | 'unblocked'
  executionView: string
  archiveProject: string
  archiveSearch: string
}
import {
  buildTaskQuery,
  normalizeOperation,
  isRetryableOperation,
  isCompleteOperation,
  operationPollDelay,
} from '@/lib/team-client.js'

const BUILTIN_VIEW_IDS = ['all', 'p0p1', 'due', 'stale', 'implementing', 'blocked'] as const

export function useBoard(): BoardController {
  const [board, setBoard] = useState<BoardPayload | null>(null)
  const [status, setStatus] = useState<BoardStatus | null>(null)
  const [runtime, setRuntime] = useState<TeamRuntime | null>(null)
  const [teamPage, setTeamPage] = useState<TeamQueryPage | null>(null)
  const [teamStatus, setTeamStatus] = useState<Record<string, unknown> | null>(null)
  const [assignments, setAssignments] = useState<unknown[]>([])
  const [operation, setOperation] = useState<PublishOperation | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [filters, setFiltersState] = useState<BoardFilters>({
    teamId: 'all',
    projectId: 'all',
    scope: 'all',
    search: '',
    assignee: '',
    priority: '',
    stage: '',
    blocked: 'any',
    executionView: 'all',
    archiveProject: 'all',
    archiveSearch: '',
  })

  const operationAttempt = useRef(0)
  const boardEtag = useRef<string | null>(null)
  const teamCursors = useRef<(string | null)[]>([null])
  const teamPageIndex = useRef(0)
  const teamPageRequest = useRef(0)
  const teamPreferenceRequest = useRef(0)
  const loadBoardRef = useRef<(force?: boolean, quiet?: boolean) => Promise<void>>(async () => {})
  const lastLoadedAtRef = useRef<string | null>(null)
  const liveRevisionKey = useRef<string | null>(null)
  const seenLiveNotifications = useRef(new Set<number>())

  const teamMode = runtime?.team === true || runtime?.mode === 'team'

  const loadBoard = useCallback(async (force = false, quiet = false) => {
    if (!quiet) setLoading(true)
    try {
      const payload = await fetchBoard(force)
      if (payload) {
        setBoard(payload)
        lastLoadedAtRef.current = payload.generatedAt ?? null
        setError('')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [])

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

  const loadTeamStatus = useCallback(async () => {
    try {
      setTeamStatus(await fetchTeamStatus())
    } catch {
      /* 状态轮询失败不打断主流程 */
    }
  }, [])

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
      .catch(() => {
        // 独立模式没有 /api/runtime，回落为单人看板
        if (active) setRuntime({ team: false, authenticated: true, user: null })
      })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    loadBoardRef.current = loadBoard
  }, [loadBoard])

  useEffect(() => {
    if (!runtime) return
    if (teamMode) {
      void loadTeamPage(true)
      void loadTeamStatus()
      void loadAssignments()
      const timer = window.setInterval(() => {
        void loadTeamStatus()
      }, 3000)
      return () => window.clearInterval(timer)
    }
    void loadBoard()
    let cancelled = false
    let timer = 0
    const poll = async () => {
      if (cancelled) return
      try {
        const next = await fetchBoardStatus()
        setStatus(next)
        if (next?.lastRefreshAt && next.lastRefreshAt !== lastLoadedAtRef.current) {
          lastLoadedAtRef.current = next.lastRefreshAt
          await loadBoardRef.current(false, true)
        }
      } catch {
        /* 忽略轮询错误，等待下一轮 */
      }
      if (!cancelled) timer = window.setTimeout(poll, 750)
    }
    timer = window.setTimeout(poll, 750)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只按运行模式起停轮询
  }, [runtime, teamMode])

  useEffect(() => {
    if (!teamMode) {
      liveRevisionKey.current = null
      seenLiveNotifications.current.clear()
      return
    }
    let cancelled = false
    let timer = 0
    const poll = async () => {
      try {
        const next = await fetchTeamLiveRevision(filters.teamId)
        if (cancelled) return
        for (const notice of next?.notifications || []) {
          if (seenLiveNotifications.current.has(notice.id)) continue
          seenLiveNotifications.current.add(notice.id)
          const taskLabel = notice.taskTitle
            ? `任务「${notice.taskTitle}」`
            : `任务 ${notice.taskKey || notice.projectId}`
          const actionLabel = notice.action === 'takeover' ? '已被他人接管' : '已被他人继续推进'
          toast.warning(`${taskLabel}${actionLabel}，原责任人是你。`)
        }
        const key = next?.revisionKey || ''
        if (liveRevisionKey.current != null && liveRevisionKey.current !== key) {
          await Promise.all([loadTeamPage(true), loadTeamStatus()])
        }
        liveRevisionKey.current = key
      } catch {
        // 实时版本轮询失败时保留现有 3 秒团队状态轮询作为兜底。
      }
      if (!cancelled) timer = window.setTimeout(poll, 750)
    }
    liveRevisionKey.current = null
    timer = window.setTimeout(poll, 750)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [teamMode, filters.teamId, loadTeamPage, loadTeamStatus])

  useEffect(() => {
    if (teamMode) void loadTeamPage(true)
  }, [filters, teamMode, loadTeamPage])

  useEffect(() => {
    if (!teamMode) return
    void loadTeamPreferences().catch((err: unknown) => {
      setError((err as Error).message)
    })
  }, [teamMode, loadTeamPreferences])

  const reloadCurrentSource = useCallback(async () => {
    if (teamMode) {
      await loadTeamPage(true)
      return
    }
    await loadBoard(false, true)
  }, [teamMode, loadBoard, loadTeamPage])

  const trackOperation = useCallback((payload: unknown) => {
    const next = normalizeOperation(payload) as PublishOperation
    if (!next?.id && !next?.status) return false
    operationAttempt.current = 0
    setOperation(next)
    return true
  }, [])

  useEffect(() => {
    if (!operation?.id || !isRetryableOperation(operation)) return
    let cancelled = false
    const attempt = operationAttempt.current
    operationAttempt.current += 1
    const timer = window.setTimeout(async () => {
      try {
        const next = normalizeOperation(
          await fetchGitOperation(String(operation.id)),
        ) as PublishOperation
        if (cancelled) return
        setOperation(next)
        if (isCompleteOperation(next)) {
          await reloadCurrentSource()
          await loadTeamStatus()
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
  }, [operation, reloadCurrentSource, loadTeamStatus])

  const setFilters = useCallback((patch: Partial<BoardFilters>) => {
    setFiltersState((current) => {
      const next = { ...current, ...patch }
      if (patch.teamId !== undefined && patch.projectId === undefined) {
        next.projectId = 'all'
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
    if (patch.teamId !== undefined) {
      teamPreferenceRequest.current += 1
      setTeamPage(null)
      setBoard((current) => (current ? { ...current, savedViews: [], settings: {} } : current))
    }
  }, [])

  const actions = useMemo(
    () => ({
      refresh: async () => {
        if (teamMode) {
          await loadTeamPage(false)
          await loadTeamStatus()
          return
        }
        await loadBoard(true)
      },
      saveWip: async (limit: number) => {
        await saveWipLimit(limit, teamMode ? filters.teamId : undefined)
        if (teamMode) await loadTeamPreferences()
        else await loadBoard(false, true)
      },
      createTask: async (payload: Record<string, unknown>) => {
        const idempotencyKey =
          typeof payload.idempotencyKey === 'string' && payload.idempotencyKey
            ? payload.idempotencyKey
            : typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        const result = await createTaskRequest({ ...payload, idempotencyKey })
        trackOperation(result)
        await reloadCurrentSource()
      },
      assign: async (payload: Record<string, unknown>) => {
        const result = await assignTaskRequest(payload)
        trackOperation(result)
        await reloadCurrentSource()
      },
      addDependency: async (payload: {
        blocked: { projectId: string; taskPath: string }
        blocker: { projectId: string; taskPath: string }
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
          ...(teamMode ? { teamId: filters.teamId } : {}),
        })
        await reloadCurrentSource()
        if (teamMode) await loadTeamPreferences()
        return saved?.view?.id ?? ''
      },
      deleteView: async (id: string) => {
        await deleteSavedView(id, teamMode ? filters.teamId : undefined)
        if (filters.executionView === id) {
          setFiltersState((current) => ({ ...current, executionView: 'all' }))
        }
        await reloadCurrentSource()
        if (teamMode) await loadTeamPreferences()
      },
      retryOperation: async () => {
        if (!operation?.id) return
        setOperation(
          normalizeOperation(await retryGitOperation(String(operation.id))) as PublishOperation,
        )
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
          await loadBoard(false, true)
        },
        remove: async (id: string) => {
          await removeRepository(id)
          await loadBoard(false, true)
        },
      },
    }),
    [
      teamMode,
      loadBoard,
      loadTeamPage,
      loadTeamPreferences,
      loadTeamStatus,
      loadAssignments,
      reloadCurrentSource,
      trackOperation,
      operation,
      filters.teamId,
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
        } => Boolean(row?.id) && (filters.teamId === 'all' || row.teamId === filters.teamId),
      )
      .map((row) => ({
        ...row,
        id: row.id,
        name: row.name || row.id,
        path: row.path || '',
        syncBranch: row.syncBranch || null,
      }))
  }, [teamStatus, filters.teamId])
  const projects: Project[] = teamMode ? teamProjects : board?.projects || []
  const tasks = useMemo<BoardTask[]>(() => {
    if (!teamMode) return board?.tasks || []
    return (teamPage?.tasks || []).map((row) => teamRowToBoardTask(row as Record<string, unknown>))
  }, [teamMode, teamPage?.tasks, board?.tasks])

  return {
    board,
    tasks,
    projects,
    status,
    runtime,
    teamMode,
    teamPage,
    teamStatus,
    assignments,
    filters,
    setFilters,
    error,
    loading,
    operation,
    actions,
    builtinViews: BUILTIN_VIEW_IDS,
  }
}

export type PublishOperation = {
  id: string | null
  status?: string
  code?: string | null
  error?: string | null
  operationType?: string | null
  taskKey?: string | null
  projectId?: string | null
  localSha?: string | null
  remoteSha?: string | null
  result?: Record<string, unknown>
  raw?: unknown
}

export type BoardActions = {
  refresh: () => Promise<void>
  saveWip: (limit: number) => Promise<void>
  createTask: (payload: Record<string, unknown>) => Promise<void>
  assign: (payload: Record<string, unknown>) => Promise<void>
  addDependency: (payload: {
    blocked: { projectId: string; taskPath: string }
    blocker: { projectId: string; taskPath: string }
    reason: string
    assigneeDecision?: { warningId: string; action: 'continue' | 'takeover' }
  }) => Promise<void>
  removeDependency: (
    id: string,
    assigneeDecision?: { warningId: string; action: 'continue' | 'takeover' },
  ) => Promise<void>
  saveView: (name: string, filter: Record<string, unknown>) => Promise<string>
  deleteView: (id: string) => Promise<void>
  retryOperation: () => Promise<void>
  dismissOperation: () => void
  accept: (payload: unknown) => Promise<void>
  reloadAssignments: () => Promise<void>
  repositories: {
    list: () => Promise<{ id?: string; name?: string; path?: string }[]>
    pick: () => Promise<string[]>
    add: (paths: string[]) => Promise<void>
    remove: (id: string) => Promise<void>
  }
}

export type BoardController = {
  board: BoardPayload | null
  tasks: BoardTask[]
  projects: BoardPayload['projects']
  status: BoardStatus | null
  runtime: TeamRuntime | null
  teamMode: boolean
  teamPage: TeamQueryPage | null
  teamStatus: Record<string, unknown> | null
  assignments: unknown[]
  filters: BoardFilters
  setFilters: (patch: Partial<BoardFilters>) => void
  error: string
  loading: boolean
  operation: PublishOperation | null
  actions: BoardActions
  builtinViews: readonly string[]
}
