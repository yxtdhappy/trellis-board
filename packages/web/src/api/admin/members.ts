import { requestJson } from '../request.ts'

import {
  collection,
  flag,
  readAgentBinding,
  readProjectMembers,
  readTaskSpace,
  record,
  text,
} from './readers.ts'
import type {
  AdminTaskSpace,
  AgentBinding,
  BindingAction,
  MemberInput,
  ProjectMember,
  PurgeTaskSpaceResult,
  TaskSpaceLifecycleMutation,
} from './types.ts'

export async function fetchMembers(projectId: string): Promise<ProjectMember[]> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/members`,
  )
  return readProjectMembers(record(data))
}

export async function saveMember(projectId: string, input: MemberInput): Promise<ProjectMember[]> {
  await requestJson<unknown>(`/api/projects/${encodeURIComponent(projectId)}/members`, {
    method: 'PUT',
    body: input,
  })
  return fetchMembers(projectId)
}

export async function removeMember(projectId: string, userId: string): Promise<ProjectMember[]> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/members?userId=${encodeURIComponent(userId)}`,
    { method: 'DELETE' },
  )
  return readProjectMembers(record(data))
}

export async function fetchBindings(projectId: string): Promise<AgentBinding[]> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/agents`,
  )
  return collection(data, 'agents', readAgentBinding)
}

export async function fetchProjectTaskSpaces(projectId: string): Promise<AdminTaskSpace[]> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/task-spaces`,
  )
  return collection(data, 'taskSpaces', readTaskSpace)
}

export async function retireProjectTaskSpace(
  projectId: string,
  taskSpaceId: string,
  reason = '',
): Promise<TaskSpaceLifecycleMutation> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/task-spaces/${encodeURIComponent(taskSpaceId)}/retire`,
    { method: 'POST', body: { reason: reason.trim() || undefined } },
  )
  const row = record(record(data).taskSpace ?? data)
  return {
    taskSpace: readTaskSpace(record(row)),
    affectedBindingCount: Number(row.affectedBindingCount ?? row.affected_binding_count ?? 0) || 0,
  }
}

export async function restoreProjectTaskSpace(
  projectId: string,
  taskSpaceId: string,
): Promise<TaskSpaceLifecycleMutation> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/task-spaces/${encodeURIComponent(taskSpaceId)}/restore`,
    { method: 'POST', body: {} },
  )
  return {
    taskSpace: readTaskSpace(record(record(data).taskSpace ?? data)),
    affectedBindingCount: 0,
  }
}

export async function purgeProjectTaskSpace(
  projectId: string,
  taskSpaceId: string,
  confirmation: string,
): Promise<PurgeTaskSpaceResult> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/task-spaces/${encodeURIComponent(taskSpaceId)}`,
    { method: 'DELETE', body: { confirmation } },
  )
  const row = record(data)
  const summary = record(row.summary)
  return {
    taskSpaceId: text(row.taskSpaceId ?? row.task_space_id ?? taskSpaceId),
    branchName: text(row.branchName ?? row.branch_name ?? confirmation),
    backupName: text(row.backupName ?? row.backup_name),
    summary,
  }
}

export async function runBindingAction(
  projectId: string,
  bindingId: string,
  action: BindingAction,
): Promise<{ commandQueued: boolean }> {
  const { data } = await requestJson<unknown>(
    `/api/projects/${encodeURIComponent(projectId)}/agents/${encodeURIComponent(bindingId)}/${action}`,
    { method: 'POST', body: {} },
  )
  return { commandQueued: flag(record(data).commandQueued) }
}
