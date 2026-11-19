import { requestJson } from '../request.ts'

import { collection, optionalText, readAgentDevice, record, teamQuery } from './readers.ts'
import type { AgentDevice } from './types.ts'

export async function fetchDevices(teamId?: string | null): Promise<AgentDevice[]> {
  const { data } = await requestJson<unknown>(`/api/admin/agents${teamQuery(teamId)}`)
  return collection(data, 'agents', readAgentDevice)
}

export async function createPairingCode(teamId?: string | null): Promise<{
  pairingCode: string | null
  expiresAt: string | null
}> {
  const { data } = await requestJson<unknown>('/api/team/pairing-codes', {
    method: 'POST',
    body: { teamId: teamId?.trim() || undefined },
  })
  const row = record(data)
  return {
    pairingCode: optionalText(row.pairingCode),
    expiresAt: optionalText(row.expiresAt),
  }
}

export async function createDesktopEnrollToken(): Promise<{
  token: string | null
  expiresAt: string | null
}> {
  const { data } = await requestJson<unknown>('/api/desktop/enroll-tokens', {
    method: 'POST',
    body: {},
  })
  const row = record(data)
  return {
    token: optionalText(row.token),
    expiresAt: optionalText(row.expiresAt),
  }
}

export async function revokeDevice(deviceId: string, teamId?: string | null): Promise<void> {
  await requestJson(`/api/admin/agents/${encodeURIComponent(deviceId)}/revoke`, {
    method: 'POST',
    body: { teamId: teamId?.trim() || undefined },
  })
}
