import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import * as admin from '@/api/admin'
import type {
  ArchiveCredentialInput,
  ArchiveGitCredential,
  ArchiveSyncLog,
  ArchiveSyncOverview,
  ArchiveTaskSpaceSync,
} from '@/api/admin'

function errorMessage(error: unknown): string {
  return admin.formatError(error)
}

export type ArchiveSyncController = {
  overview: ArchiveSyncOverview | null
  loading: boolean
  error: string
  busy: boolean
  reload: (quiet?: boolean) => Promise<void>
  saveConfig: (input: { enabled: boolean; intervalSeconds: number }) => Promise<boolean>
  saveCredential: (
    input: ArchiveCredentialInput,
    credentialId?: string | null,
  ) => Promise<ArchiveGitCredential | null>
  removeCredential: (credential: ArchiveGitCredential) => Promise<boolean>
  testCredential: (credential: ArchiveGitCredential) => Promise<boolean>
  run: (taskSpaceId?: string | null) => Promise<boolean>
  logsTaskSpace: ArchiveTaskSpaceSync | null
  logs: ArchiveSyncLog[]
  logsHasMore: boolean
  logsLoading: boolean
  logsError: string
  openLogs: (taskSpace: ArchiveTaskSpaceSync) => Promise<void>
  closeLogs: () => void
  loadMoreLogs: () => Promise<void>
}

export function useArchiveSync(): ArchiveSyncController {
  const [overview, setOverview] = useState<ArchiveSyncOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [logsTaskSpace, setLogsTaskSpace] = useState<ArchiveTaskSpaceSync | null>(null)
  const [logs, setLogs] = useState<ArchiveSyncLog[]>([])
  const [logsHasMore, setLogsHasMore] = useState(false)
  const [logsLoading, setLogsLoading] = useState(false)
  const [logsError, setLogsError] = useState('')
  const nextBeforeRef = useRef<number | null>(null)
  const requestRef = useRef(0)

  const reload = useCallback(async (quiet = false) => {
    const requestId = ++requestRef.current
    if (!quiet) setLoading(true)
    try {
      const next = await admin.fetchArchiveSync()
      if (requestId !== requestRef.current) return
      setOverview(next)
      setError('')
    } catch (fetchError) {
      if (requestId !== requestRef.current) return
      setError(errorMessage(fetchError))
      if (!quiet) toast.error(errorMessage(fetchError))
    } finally {
      if (requestId === requestRef.current && !quiet) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    const timer = window.setInterval(() => void reload(true), 5000)
    return () => window.clearInterval(timer)
  }, [reload])

  const saveConfig = useCallback(
    async (input: { enabled: boolean; intervalSeconds: number }) => {
      setBusy(true)
      try {
        const config = await admin.updateArchiveSyncConfig(input)
        setOverview((current) => (current ? { ...current, config } : current))
        toast.success('归档同步配置已保存。')
        await reload(true)
        return true
      } catch (saveError) {
        toast.error(errorMessage(saveError))
        return false
      } finally {
        setBusy(false)
      }
    },
    [reload],
  )

  const saveCredential = useCallback(
    async (input: ArchiveCredentialInput, credentialId?: string | null) => {
      setBusy(true)
      try {
        const credential = credentialId
          ? await admin.updateArchiveSyncCredential(credentialId, {
              name: input.name,
              username: input.username,
              token: input.token || undefined,
              privateKey: input.privateKey || undefined,
              knownHostsText: input.knownHostsText || undefined,
            })
          : await admin.createArchiveSyncCredential(input)
        toast.success(credentialId ? '归档 Git 凭据已更新。' : '归档 Git 凭据已创建。')
        await reload(true)
        return credential
      } catch (saveError) {
        toast.error(errorMessage(saveError))
        return null
      } finally {
        setBusy(false)
      }
    },
    [reload],
  )

  const removeCredential = useCallback(
    async (credential: ArchiveGitCredential) => {
      setBusy(true)
      try {
        await admin.deleteArchiveSyncCredential(credential.id)
        toast.success(`已删除 ${credential.origin} 的归档凭据。`)
        await reload(true)
        return true
      } catch (removeError) {
        toast.error(errorMessage(removeError))
        return false
      } finally {
        setBusy(false)
      }
    },
    [reload],
  )

  const testCredential = useCallback(async (credential: ArchiveGitCredential) => {
    setBusy(true)
    try {
      const result = await admin.testArchiveSyncCredential(credential.id)
      if (!result.branchFound) {
        toast.error(`已连接 ${credential.origin}，但测试分支不存在。`)
        return false
      }
      toast.success(`连接成功：${result.branchName}。`)
      return true
    } catch (testError) {
      toast.error(errorMessage(testError))
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  const run = useCallback(
    async (taskSpaceId?: string | null) => {
      setBusy(true)
      try {
        const queued = await admin.runArchiveSync(taskSpaceId)
        toast.success(`已排队 ${queued} 个归档同步任务。`)
        await reload(true)
        return true
      } catch (runError) {
        toast.error(errorMessage(runError))
        return false
      } finally {
        setBusy(false)
      }
    },
    [reload],
  )

  const openLogs = useCallback(async (taskSpace: ArchiveTaskSpaceSync) => {
    setLogsTaskSpace(taskSpace)
    setLogs([])
    setLogsHasMore(false)
    setLogsLoading(true)
    setLogsError('')
    nextBeforeRef.current = null
    try {
      const page = await admin.fetchArchiveSyncLogs(taskSpace.taskSpaceId, null)
      setLogs(page.logs)
      setLogsHasMore(page.nextBeforeId != null)
      nextBeforeRef.current = page.nextBeforeId
    } catch (logsError) {
      const message = errorMessage(logsError)
      setLogsError(message)
      toast.error(message)
    } finally {
      setLogsLoading(false)
    }
  }, [])

  const loadMoreLogs = useCallback(async () => {
    if (!logsTaskSpace || logsLoading || !nextBeforeRef.current) return
    setLogsLoading(true)
    setLogsError('')
    try {
      const page = await admin.fetchArchiveSyncLogs(
        logsTaskSpace.taskSpaceId,
        nextBeforeRef.current,
      )
      setLogs((current) => [...current, ...page.logs])
      setLogsHasMore(page.nextBeforeId != null)
      nextBeforeRef.current = page.nextBeforeId
    } catch (logsError) {
      const message = errorMessage(logsError)
      setLogsError(message)
      toast.error(message)
    } finally {
      setLogsLoading(false)
    }
  }, [logsLoading, logsTaskSpace])

  return {
    overview,
    loading,
    error,
    busy,
    reload,
    saveConfig,
    saveCredential,
    removeCredential,
    testCredential,
    run,
    logsTaskSpace,
    logs,
    logsHasMore,
    logsLoading,
    logsError,
    openLogs,
    closeLogs: () => setLogsTaskSpace(null),
    loadMoreLogs,
  }
}
