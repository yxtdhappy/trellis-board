import { requestJson } from '../request.ts'

import { collection, readAuditEvent } from './readers.ts'
import { AUDIT_PAGE_LIMIT, type AuditEvent } from './types.ts'

function auditQuery(beforeId: number | null, limit = AUDIT_PAGE_LIMIT): string {
  const cursor = beforeId ? `&beforeId=${encodeURIComponent(String(beforeId))}` : ''
  return `?limit=${limit}${cursor}`
}

export async function fetchProjectAudit(
  projectId: string,
  beforeId: number | null,
): Promise<AuditEvent[]> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/audit${auditQuery(beforeId)}`,
  )
  return collection(data, 'events', readAuditEvent)
}

export async function fetchSystemAudit(
  beforeId: number | null,
  teamId?: string | null,
): Promise<AuditEvent[]> {
  const query = new URLSearchParams({ limit: String(AUDIT_PAGE_LIMIT) })
  if (beforeId) query.set('beforeId', String(beforeId))
  if (teamId?.trim()) query.set('teamId', teamId.trim())
  const { data } = await requestJson<unknown>(`/api/admin/audit?${query}`)
  return collection(data, 'events', readAuditEvent)
}
