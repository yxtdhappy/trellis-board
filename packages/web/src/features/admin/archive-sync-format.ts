import type { ArchiveTaskSpaceSync } from '@/api/admin'

export const STATUS_LABELS: Record<string, string> = {
  idle: '等待同步',
  syncing: '正在拉取',
  importing: '正在导入',
  indexing: '正在更新索引',
  current: '已更新',
  stale: '索引落后',
  error: '同步失败',
  index_error: '索引失败',
}

export const PROJECT_PREVIEW_LIMIT = 5

export function statusLabel(value: string) {
  return STATUS_LABELS[value] || value
}

export function credentialStateLabel(value: string) {
  if (value === 'configured') return '已匹配 · 未验证'
  if (value === 'anonymous') return '公开 HTTPS 匿名'
  if (value === 'missing') return '缺少 SSH 凭据'
  if (value === 'unsupported') return '远端协议不支持'
  return value ? `未知凭据状态（${value}）` : '凭据状态未知'
}

export function displayText(value: string | null | undefined, fallback: string) {
  return value?.trim() || fallback
}

export type AffectedProject = {
  key: string
  name: string
  branches: string[]
}

export function credentialProjects(taskSpaces: ArchiveTaskSpaceSync[], credentialId: string) {
  if (!credentialId) return []
  const projects = new Map<string, AffectedProject>()
  taskSpaces.forEach((taskSpace, index) => {
    if (taskSpace.credential?.id !== credentialId) return
    const key = taskSpace.projectId || taskSpace.taskSpaceId || `project-${index}`
    const project = projects.get(key) ?? {
      key,
      name: displayText(taskSpace.projectName, '项目名称缺失'),
      branches: [],
    }
    const branchName = displayText(taskSpace.branchName, '分支名称缺失')
    if (!project.branches.includes(branchName)) project.branches.push(branchName)
    projects.set(key, project)
  })
  return [...projects.values()]
}

export function taskSpaceText(taskSpace: ArchiveTaskSpaceSync) {
  const projectName = displayText(taskSpace.projectName, '项目名称缺失')
  const branchName = displayText(taskSpace.branchName, '分支名称缺失')
  return `${projectName} · ${branchName}`
}

export function affectedProjectText(project: AffectedProject) {
  return `${project.name} · ${project.branches.join(' / ')}`
}

export function shortHead(value: string | null) {
  return value ? value.slice(0, 10) : '—'
}

export type CredentialDraft = {
  name: string
  scheme: 'ssh' | 'https'
  host: string
  port: string
  username: string
  token: string
  privateKey: string
}

export const EMPTY_CREDENTIAL: CredentialDraft = {
  name: '',
  scheme: 'ssh',
  host: '',
  port: '22',
  username: 'x-access-token',
  token: '',
  privateKey: '',
}
