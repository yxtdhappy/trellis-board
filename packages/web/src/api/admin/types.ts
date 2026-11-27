export const AUDIT_PAGE_LIMIT = 100

export type AdminView =
  | 'project-access'
  | 'archive-sync'
  | 'users'
  | 'teams'
  | 'plugins'
  | 'agents'
  | 'audit'

export type SessionUser = {
  id: string
  username: string
  displayName: string
  systemAdmin: boolean
  status: string
  mustChangePassword: boolean
}

export type TaskSpaceLifecycleStatus = 'active' | 'disabled' | 'retired'

export type AdminTaskSpace = {
  id: string
  branchName: string
  status: string
  lifecycleStatus: TaskSpaceLifecycleStatus
  isBaseline?: boolean
  revision: number
  indexedRevision: number
  readOnly: boolean
  retiredAt: string | null
  retiredByUserId: string | null
  retiredReason: string | null
  taskCount: number
  fileCount: number
  activeTaskCount: number
  archivedTaskCount: number
  lastActivityAt: string | null
  unarchivedTaskTitles: string[]
  approvedBindingCount: number
  onlineListenerCount: number
  lastListenerAt: string | null
}

export type RuntimeProject = {
  id: string
  teamId: string | null
  teamName: string | null
  name: string
  baselineBranch?: string | null
  syncStatus: string
  syncBranch: string
  role: string | null
  stale: boolean
  lastError: string | null
  capabilities: Record<string, unknown>
  taskSpaces: AdminTaskSpace[]
}

export type ProjectMember = {
  userId: string | null
  username: string
  displayName: string
  trellisDevId: string | null
  role: string | null
  status: string
}

export type TeamProject = RuntimeProject & {
  members: ProjectMember[]
}

export type Team = {
  id: string
  name: string
  slug: string
  status: string
  role: string | null
  active: boolean
  memberCount: number
  projectCount: number
}

export type TeamMember = {
  userId: string
  username: string
  displayName: string
  systemAdmin: boolean
  status: string
  role: string
}

export type AdminUser = SessionUser & {
  passwordChangedAt: string | null
  createdAt: string | null
  teams: Team[]
}

export type AgentDevice = {
  id: string
  userId: string | null
  username: string
  displayName: string
  deviceName: string
  platform: string
  agentVersion: string
  protocolVersion: number
  status: string
  lastSeenAt: string | null
  createdAt: string | null
  revokedAt: string | null
}

export type AgentBinding = {
  id: string
  agentId: string
  projectId: string
  localRepoKey: string
  displayName: string | null
  branchName: string
  status: string
  lastSyncedAt: string | null
  lastError: string | null
  deviceName: string | null
  agentStatus: string | null
  ownerUserId: string | null
  ownerUsername: string
  ownerDisplayName: string
  lastSeenAt: string | null
  createdAt: string | null
  updatedAt: string | null
}

export type ProjectTeamAccess = {
  projectId: string
  teamId: string
  teamName: string
  teamStatus: string
  accessRole: string
  createdAt: string | null
}

export type AuditEvent = {
  id: number
  actorUserId: string | null
  actorAgentId: string | null
  projectId: string | null
  action: string
  targetType: string
  targetId: string | null
  result: string
  correlationId: string
  detail: unknown
  occurredAt: string | null
}

export type ArchiveSyncConfig = {
  enabled: boolean
  intervalSeconds: number
  updatedAt: string | null
}

export type ArchiveGitCredential = {
  id: string
  name: string
  scheme: 'ssh' | 'https'
  host: string
  port: number
  origin: string
  authType: 'ssh_key' | 'https_token'
  username: string | null
  configured: boolean
  publicKeyFingerprint: string | null
  secretVersion: number
  createdAt: string | null
  updatedAt: string | null
}

export type ArchiveTaskSpaceSync = {
  taskSpaceId: string
  projectId: string
  projectName: string
  remoteUrl: string
  origin: string | null
  branchName: string
  isWorktree: boolean
  credentialState: string
  credential: ArchiveGitCredential | null
  status: string
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastIndexedAt: string | null
  lastError: string | null
  remoteHead: string | null
  fileCount: number
  byteCount: number
  archiveRevision: number
  archiveIndexedRevision: number
  failureCount: number
  nextAttemptAt: string | null
}

export type ArchiveSyncOverview = {
  config: ArchiveSyncConfig
  credentials: ArchiveGitCredential[]
  taskSpaces: ArchiveTaskSpaceSync[]
}

export type ArchiveSyncLog = {
  id: number
  taskSpaceId: string
  attemptId: string
  phase: string
  level: string
  errorCode: string
  message: string
  detail: Record<string, unknown>
  createdAt: string | null
}

export type Runtime = {
  mode: 'team' | 'standalone'
  team: boolean
  appName: string | null
  authenticated: boolean
  user: SessionUser | null
  systemAdmin: boolean
  teams: Team[]
  projects: RuntimeProject[]
  features: {
    pluginsEnabled: boolean
  }
}

export type NewUserInput = {
  username: string
  displayName: string
  password: string
  teamIds: string[]
  systemAdmin: boolean
}

export type UserUpdate = {
  displayName?: string
  status?: string
  systemAdmin?: boolean
  teamIds?: string[]
}

export type MemberInput = {
  userId: string
  role: string
  trellisDevId: string | null
}

export type TaskSpaceLifecycleMutation = {
  taskSpace: AdminTaskSpace
  affectedBindingCount: number
}

export type PurgeTaskSpaceResult = {
  taskSpaceId: string
  branchName: string
  backupName: string
  summary: Record<string, unknown>
}

export type PurgeProjectResult = {
  purged: boolean
  projectId: string
  projectName: string
  backupName: string
  summary: {
    remoteUrl: string
    taskSpaceCount: number
    taskCount: number
    memberCount: number
    teamAccessCount: number
    backupName: string
  }
}

export type BindingAction = 'approve' | 'reject' | 'revoke'

export type ArchiveCredentialInput = {
  name: string
  scheme: 'ssh' | 'https'
  host: string
  port: number
  username?: string
  token?: string
  privateKey?: string
}
