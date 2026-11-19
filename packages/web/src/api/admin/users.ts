import { requestJson } from '../request.ts'

import { collection, readAdminUser, record, teamQuery } from './readers.ts'
import type { AdminUser, NewUserInput, UserUpdate } from './types.ts'

export async function fetchUsers(teamId?: string | null): Promise<AdminUser[]> {
  const { data } = await requestJson<unknown>(`/api/admin/users${teamQuery(teamId)}`)
  return collection(data, 'users', readAdminUser)
}

export async function createUser(input: NewUserInput): Promise<AdminUser | null> {
  const { data } = await requestJson<unknown>('/api/admin/users', {
    method: 'POST',
    body: {
      username: input.username,
      displayName: input.displayName,
      password: input.password,
      teamIds: input.teamIds,
      systemAdmin: input.systemAdmin,
    },
  })
  const row = record(data)
  return row.user ? readAdminUser(row.user) : null
}

export async function updateUser(userId: string, updates: UserUpdate): Promise<AdminUser> {
  const { data } = await requestJson<unknown>(`/api/admin/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    body: updates,
  })
  const row = record(data)
  return readAdminUser(row.user ?? data)
}

export async function resetUserPassword(userId: string, password: string): Promise<void> {
  await requestJson<unknown>(`/api/admin/users/${encodeURIComponent(userId)}/reset-password`, {
    method: 'POST',
    body: { password },
  })
}
