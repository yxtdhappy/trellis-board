import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchOwnershipInbox } from '@/api/board'
import { mergeOwnershipInboxItems } from '@/lib/ownership-inbox.js'
import type { OwnershipInboxItem } from '@/lib/ownership-inbox.js'

export function useOwnershipInbox({
  teamId,
  projectId,
}: {
  teamId: string
  projectId: string
}) {
  const [open, setOpenState] = useState(false)
  const [items, setItems] = useState<OwnershipInboxItem[]>([])
  const [total, setTotal] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')

  const request = useRef(0)
  const cursor = useRef<string | null>(null)
  const openRef = useRef(false)

  const clear = useCallback(() => {
    request.current += 1
    cursor.current = null
    setItems([])
    setTotal(0)
    setNextCursor(null)
    setLoading(false)
    setLoadingMore(false)
    setError('')
  }, [])

  const load = useCallback(
    async (mode: 'replace' | 'next' = 'replace') => {
      const next = mode === 'next'
      const from = next ? cursor.current : null
      if (next && !from) return
      const seq = ++request.current
      setLoading(!next)
      setLoadingMore(next)
      if (!next) setError('')
      try {
        const page = await fetchOwnershipInbox({ teamId, projectId, cursor: from })
        if (seq !== request.current) return
        setItems((current) => (next ? mergeOwnershipInboxItems(current, page.items) : page.items))
        cursor.current = page.nextCursor
        setNextCursor(page.nextCursor)
        setTotal(page.total)
        setError('')
      } catch (err) {
        if (seq !== request.current) return
        if ((err as Error)?.name === 'AbortError') return
        setError((err as Error).message)
      } finally {
        if (seq === request.current) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [teamId, projectId, clear],
  )

  const reload = useCallback(() => load('replace'), [load])

  const loadMore = useCallback(async () => {
    if (loading || loadingMore || !cursor.current) return
    await load('next')
  }, [loading, loadingMore, load])

  const toggle = useCallback((sameScope: boolean) => {
    const next = !(openRef.current && sameScope)
    openRef.current = next
    setOpenState(next)
  }, [])

  useEffect(() => {
    openRef.current = open
  }, [open])

  useEffect(() => {
    if (!open) return
    void reload()
  }, [open, teamId, projectId, reload])

  return {
    open,
    openRef,
    items,
    total,
    nextCursor,
    loading,
    loadingMore,
    error,
    clear,
    reload,
    loadMore,
    toggle,
  }
}
