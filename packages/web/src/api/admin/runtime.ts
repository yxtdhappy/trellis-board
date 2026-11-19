import { ApiError, requestJson } from '../request.ts'

import { readRuntime } from './readers.ts'
import type { Runtime, RuntimeProject } from './types.ts'

export function canManageProject(project: RuntimeProject): boolean {
  if (project.capabilities.manageMembers ?? project.capabilities.manage_members) return true
  return project.role === 'lead'
}

export function formatError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.code ? `${error.message}（${error.code}）` : error.message
  }
  if (error instanceof Error) return error.message || '请求失败'
  return '请求失败'
}

export async function fetchRuntime(): Promise<Runtime> {
  const { data } = await requestJson<unknown>('/api/runtime')
  return readRuntime(data)
}

export async function logout(): Promise<void> {
  await requestJson('/api/auth/logout', { method: 'POST', body: {} })
}
