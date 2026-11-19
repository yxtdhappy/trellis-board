import { requestJson } from '../request.ts'

import { collection, optionalText, readTeamProject, record, teamQuery } from './readers.ts'
import type { ProjectTeamAccess, TeamProject } from './types.ts'

export async function fetchAdminProjects(teamId?: string | null): Promise<TeamProject[]> {
  const { data } = await requestJson<unknown>(`/api/admin/projects${teamQuery(teamId)}`)
  return collection(data, 'projects', readTeamProject)
}

export async function fetchProjectTeams(projectId: string): Promise<ProjectTeamAccess[]> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/team-access`,
  )
  return collection(data, 'teams', (value) => {
    const row = record(value)
    return {
      projectId: optionalText(row.projectId) || '',
      teamId: optionalText(row.teamId) || '',
      teamName: optionalText(row.teamName) || '未知团队',
      teamStatus: optionalText(row.teamStatus) || 'unknown',
      accessRole: optionalText(row.accessRole) || 'member',
      createdAt: optionalText(row.createdAt),
    }
  }).filter((item) => item.projectId && item.teamId)
}

export async function inviteProjectTeam(
  projectId: string,
  teamId: string,
  accessRole = 'member',
): Promise<void> {
  await requestJson(`/api/projects/${encodeURIComponent(projectId)}/team-access`, {
    method: 'POST',
    body: { teamId, accessRole },
  })
}

export async function removeProjectTeam(projectId: string, teamId: string): Promise<void> {
  await requestJson(
    `/api/projects/${encodeURIComponent(projectId)}/team-access?teamId=${encodeURIComponent(teamId)}`,
    { method: 'DELETE' },
  )
}
