import { useCallback, useEffect, useRef, useState } from 'react'
import { queryTeamTasks, type TeamQueryPage } from '@/api/board'
import { ApiError } from '@/api/request'
import { teamRowToBoardTask } from '@/features/board/task-view'
import { buildTaskQuery } from '@/lib/team-client.js'

const PAGE_SIZE = 20

type ArchiveTaskOptions = {
  enabled: boolean
  teamId: string
  projectId: string
  taskSpaceId: string
  revision?: number | string | null
}

export type ArchiveTasksController = {
  tasks: TeamQueryPage['tasks']
  assignees: string[]
  total: number
  pageIndex: number
  pageCount: number
  hasNext: boolean
  loading: boolean
  error: string
  search: string
  setSearch: (value: string) => void
  assignee: string
  setAssignee: (value: string) => void
  next: () => void
  previous: () => void
  refresh: () => void
}

export function useArchiveTasks({
  enabled,
  teamId,
  projectId,
  taskSpaceId,
  revision,
}: ArchiveTaskOptions): ArchiveTasksController {
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [assignee, setAssignee] = useState('')
  const [page, setPage] = useState<TeamQueryPage | null>(null)
  const [pageIndex, setPageIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [reloadToken, setReloadToken] = useState(0)
  const cursors = useRef<(string | null)[]>([null])
  const requestId = useRef(0)

  useEffect(() => {
    if (!enabled) return
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [enabled, searchInput])

  const loadPage = useCallback(
    async (index: number, cursor: string | null, reset = false) => {
      const currentRequest = ++requestId.current
      if (reset) {
        setPage(null)
        setError('')
      }
      setLoading(true)
      try {
        const query = buildTaskQuery(
          {
            teamId,
            projectId,
            taskSpaceId,
            scope: 'all',
            q: search,
            assignee,
            archived: true,
          },
          { limit: PAGE_SIZE, cursor },
        )
        const result = await queryTeamTasks(query, null)
        if (currentRequest !== requestId.current || !result.page) return
        setPage({
          ...result.page,
          tasks: result.page.tasks.map((row) => teamRowToBoardTask(row as Record<string, unknown>)),
        })
        setPageIndex(index)
        setError('')
      } catch (err) {
        if (currentRequest !== requestId.current) return
        if (err instanceof ApiError && err.status === 409 && err.code === 'CURSOR_INVALID') {
          cursors.current = [null]
          setPageIndex(0)
          setReloadToken((value) => value + 1)
        }
        setError((err as Error).message)
      } finally {
        if (currentRequest === requestId.current) setLoading(false)
      }
    },
    [teamId, projectId, taskSpaceId, search, assignee],
  )

  useEffect(() => {
    if (!enabled) {
      requestId.current += 1
      cursors.current = [null]
      setPage(null)
      setPageIndex(0)
      setLoading(false)
      setError('')
      return
    }
    cursors.current = [null]
    setPageIndex(0)
    void loadPage(0, null, true)
    return () => {
      requestId.current += 1
    }
  }, [enabled, loadPage, revision, reloadToken])

  const next = useCallback(() => {
    if (loading || !page?.nextCursor) return
    const index = pageIndex + 1
    cursors.current[index] = page.nextCursor
    setPageIndex(index)
    void loadPage(index, page.nextCursor, true)
  }, [loadPage, loading, page?.nextCursor, pageIndex])

  const previous = useCallback(() => {
    if (loading || pageIndex === 0) return
    const index = pageIndex - 1
    setPageIndex(index)
    void loadPage(index, cursors.current[index] ?? null, true)
  }, [loadPage, loading, pageIndex])

  const refresh = useCallback(() => {
    cursors.current = [null]
    setPageIndex(0)
    setReloadToken((value) => value + 1)
  }, [])

  return {
    tasks: page?.tasks || [],
    assignees: page?.assignees || [],
    total: page?.total || 0,
    pageIndex,
    pageCount: Math.max(1, Math.ceil((page?.total || 0) / PAGE_SIZE)),
    hasNext: Boolean(page?.nextCursor),
    loading,
    error,
    search: searchInput,
    setSearch: setSearchInput,
    assignee,
    setAssignee,
    next,
    previous,
    refresh,
  }
}
