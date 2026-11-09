import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import * as admin from '@/api/admin'
import type {
  GitCredential,
  GitCredentialInput,
  RemoteProbeResult,
  TeamProject
} from '@/api/admin'

export type AdminGitCredentials = {
  credentials: GitCredential[]
  credentialsLoading: boolean
  reloadCredentials: (quiet?: boolean) => Promise<GitCredential[]>
  createCredential: (input: Omit<GitCredentialInput, 'teamId'>) => Promise<boolean>
  updateCredential: (
    credential: GitCredential,
    input: Omit<GitCredentialInput, 'teamId' | 'host' | 'authType'>
  ) => Promise<boolean>
  deleteCredential: (credential: GitCredential) => Promise<boolean>
  probeRemote: (input: {
    remoteUrl: string
    credentialId?: string | null
  }) => Promise<RemoteProbeResult>
  confirmSshTrust: (challengeId: string) => Promise<admin.SshTrustResult>
  changeProjectCredential: (
    projectId: string,
    credentialId: string | null
  ) => Promise<TeamProject>
}

type Options = {
  report: (error: unknown, quiet?: boolean) => void
  isAdmin: boolean
  teamId: string
}

export function useGitCredentials({
  report,
  isAdmin,
  teamId
}: Options): AdminGitCredentials {
  const [credentials, setCredentials] = useState<GitCredential[]>([])
  const [credentialsLoading, setCredentialsLoading] = useState(false)
  const requestRef = useRef(0)

  const reloadCredentials = useCallback(
    async (quiet = false) => {
      if (!isAdmin) return []
      const requestId = requestRef.current + 1
      requestRef.current = requestId
      if (!quiet) setCredentialsLoading(true)
      try {
        const list = await admin.fetchGitCredentials(teamId || undefined)
        if (requestRef.current === requestId) setCredentials(list)
        return requestRef.current === requestId ? list : []
      } catch (error) {
        if (requestRef.current === requestId) report(error, quiet)
        return []
      } finally {
        if (requestRef.current === requestId) setCredentialsLoading(false)
      }
    },
    [isAdmin, report, teamId]
  )

  useEffect(() => {
    requestRef.current += 1
    if (isAdmin) void reloadCredentials(true)
  }, [isAdmin, reloadCredentials])

  const createCredential = useCallback(
    async (input: Omit<GitCredentialInput, 'teamId'>) => {
      if (!teamId || teamId === 'all') {
        toast.error('请先在顶部选择一个具体团队，再新增 Git 凭据。')
        return false
      }
      try {
        await admin.createGitCredential({ ...input, teamId })
        await reloadCredentials(true)
        toast.success('Git 凭据已创建。')
        return true
      } catch (error) {
        report(error)
        return false
      }
    },
    [reloadCredentials, report, teamId]
  )

  const updateCredential = useCallback(
    async (
      credential: GitCredential,
      input: Omit<GitCredentialInput, 'teamId' | 'host' | 'authType'>
    ) => {
      try {
        await admin.updateGitCredential(credential.id, input)
        await reloadCredentials(true)
        toast.success('Git 凭据已更新。')
        return true
      } catch (error) {
        report(error)
        return false
      }
    },
    [reloadCredentials, report]
  )

  const deleteCredential = useCallback(
    async (credential: GitCredential) => {
      if (!window.confirm(`删除 Git 凭据 ${credential.name}？`)) return false
      try {
        await admin.deleteGitCredential(credential.id)
        await reloadCredentials(true)
        toast.success('Git 凭据已删除。')
        return true
      } catch (error) {
        report(error)
        return false
      }
    },
    [reloadCredentials, report]
  )

  const probeRemote = useCallback(
    (input: { remoteUrl: string; credentialId?: string | null }) => {
      if (!teamId || teamId === 'all') {
        return Promise.reject(new Error('请先在顶部选择一个具体团队。'))
      }
      return admin.probeGitRemote({ ...input, teamId })
    },
    [teamId]
  )

  const confirmSshTrust = useCallback((challengeId: string) => {
    return admin.confirmSshHost(challengeId)
  }, [])

  const changeProjectCredential = useCallback(
    (projectId: string, credentialId: string | null) => {
      return admin.changeProjectCredential(projectId, credentialId)
    },
    []
  )
  const visibleCredentials = teamId && teamId !== 'all'
    ? credentials.filter((credential) => credential.teamId === teamId)
    : credentials

  return {
    credentials: visibleCredentials,
    credentialsLoading,
    reloadCredentials,
    createCredential,
    updateCredential,
    deleteCredential,
    probeRemote,
    confirmSshTrust,
    changeProjectCredential
  }
}
