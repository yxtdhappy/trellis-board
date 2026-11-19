import { requestJson } from '../request.ts'

import {
  flag,
  readArchiveGitCredential,
  readArchiveSyncConfig,
  readArchiveSyncLog,
  readArchiveSyncOverview,
  record,
  rows,
  text,
} from './readers.ts'
import type {
  ArchiveCredentialInput,
  ArchiveGitCredential,
  ArchiveSyncConfig,
  ArchiveSyncLog,
  ArchiveSyncOverview,
} from './types.ts'

export async function fetchArchiveSync(): Promise<ArchiveSyncOverview> {
  const { data } = await requestJson<unknown>('/api/admin/archive-sync')
  return readArchiveSyncOverview(data)
}

export async function updateArchiveSyncConfig(input: {
  enabled?: boolean
  intervalSeconds?: number
}): Promise<ArchiveSyncConfig> {
  const { data } = await requestJson<unknown>('/api/admin/archive-sync/config', {
    method: 'PATCH',
    body: input,
  })
  return readArchiveSyncConfig(record(data).config ?? data)
}

export async function createArchiveSyncCredential(
  input: ArchiveCredentialInput,
): Promise<ArchiveGitCredential> {
  const { data } = await requestJson<unknown>('/api/admin/archive-sync/credentials', {
    method: 'POST',
    body: { ...input, authType: input.scheme === 'ssh' ? 'ssh_key' : 'https_token' },
  })
  return readArchiveGitCredential(record(data).credential ?? data)
}

export async function updateArchiveSyncCredential(
  credentialId: string,
  input: Partial<ArchiveCredentialInput>,
): Promise<ArchiveGitCredential> {
  const { data } = await requestJson<unknown>(
    `/api/admin/archive-sync/credentials/${encodeURIComponent(credentialId)}`,
    { method: 'PATCH', body: input },
  )
  return readArchiveGitCredential(record(data).credential ?? data)
}

export async function deleteArchiveSyncCredential(credentialId: string): Promise<void> {
  await requestJson(`/api/admin/archive-sync/credentials/${encodeURIComponent(credentialId)}`, {
    method: 'DELETE',
    body: {},
  })
}

export async function testArchiveSyncCredential(credentialId: string): Promise<{
  branchFound: boolean
  branchName: string
  taskSpaceId: string
}> {
  const { data } = await requestJson<unknown>(
    `/api/admin/archive-sync/credentials/${encodeURIComponent(credentialId)}/test`,
    { method: 'POST', body: {} },
  )
  const row = record(data)
  return {
    branchFound: flag(row.branchFound ?? row.branch_found),
    branchName: text(row.branchName ?? row.branch_name),
    taskSpaceId: text(row.taskSpaceId ?? row.task_space_id),
  }
}

export async function runArchiveSync(taskSpaceId?: string | null): Promise<number> {
  const { data } = await requestJson<unknown>('/api/admin/archive-sync/run', {
    method: 'POST',
    body: { taskSpaceId: taskSpaceId?.trim() || undefined },
  })
  return Number(record(data).queued ?? 0) || 0
}

export async function fetchArchiveSyncLogs(
  taskSpaceId: string,
  beforeId: number | null,
): Promise<{ logs: ArchiveSyncLog[]; nextBeforeId: number | null }> {
  const query = new URLSearchParams({ limit: '20' })
  if (beforeId) query.set('beforeId', String(beforeId))
  const { data } = await requestJson<unknown>(
    `/api/admin/archive-sync/task-spaces/${encodeURIComponent(taskSpaceId)}/logs?${query}`,
  )
  const row = record(data)
  return {
    logs: rows(row.logs).map(readArchiveSyncLog),
    nextBeforeId: row.nextBeforeId == null ? null : Number(row.nextBeforeId) || null,
  }
}
