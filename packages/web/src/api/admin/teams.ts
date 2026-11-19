import { requestJson } from '../request.ts'

import { collection, readTeam, readTeamMember, record, rows } from './readers.ts'
import type { Team, TeamMember } from './types.ts'

export async function fetchAdminTeams(): Promise<Team[]> {
  const { data } = await requestJson<unknown>('/api/admin/teams')
  return collection(data, 'teams', readTeam)
}

export async function createTeam(name: string, slug?: string): Promise<Team | null> {
  const { data } = await requestJson<unknown>('/api/admin/teams', {
    method: 'POST',
    body: { name, slug: slug?.trim() || undefined },
  })
  return record(data).team ? readTeam(record(data).team) : null
}

export async function updateTeam(
  teamId: string,
  updates: { name?: string; status?: string },
): Promise<Team | null> {
  const { data } = await requestJson<unknown>(`/api/admin/teams/${encodeURIComponent(teamId)}`, {
    method: 'PATCH',
    body: updates,
  })
  return record(data).team ? readTeam(record(data).team) : null
}

export async function fetchTeamDetail(
  teamId: string,
): Promise<{ team: Team | null; members: TeamMember[] }> {
  const { data } = await requestJson<unknown>(`/api/admin/teams/${encodeURIComponent(teamId)}`)
  const row = record(data)
  return {
    team: record(row.team).id ? readTeam(record(row.team)) : null,
    members: rows(record(row.team).members).map(readTeamMember),
  }
}

export async function saveUserTeams(
  userId: string,
  teams: { teamId: string; role: string }[],
): Promise<Team[]> {
  const { data } = await requestJson<unknown>(
    `/api/admin/users/${encodeURIComponent(userId)}/teams`,
    { method: 'PUT', body: { teams } },
  )
  return rows(record(data).teams).map(readTeam)
}
