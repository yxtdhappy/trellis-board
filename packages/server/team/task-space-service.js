import { DEFAULT_LISTENER_STALE_MS, createStatements } from './task-space/shared.js'
import { createView } from './task-space/view.js'
import { createAccess } from './task-space/access.js'
import { createAttach } from './task-space/attach.js'
import { createBindings } from './task-space/bindings.js'
import { createLifecycle } from './task-space/lifecycle.js'
import { createMembership } from './task-space/membership.js'

export function createTaskSpaceService({
  db,
  config = {},
  allowedFileRemote = false,
  now = () => new Date(),
  staleMs = null,
  backupService = null,
  onTaskSpacePurged = null,
  onTaskSpaceWorktreeMarked = null,
}) {
  const allowFileRemote = allowedFileRemote === true || config?.allowLocalGitRemotes === true
  const configuredStaleMs = Number(staleMs ?? config.agentStaleMs ?? DEFAULT_LISTENER_STALE_MS)
  const effectiveStaleMs =
    Number.isFinite(configuredStaleMs) && configuredStaleMs > 0
      ? configuredStaleMs
      : DEFAULT_LISTENER_STALE_MS
  const statements = createStatements(db)
  const view = createView({ statements, now, staleMs: effectiveStaleMs })
  const access = createAccess({ db, statements, view, allowFileRemote, now })
  const attach = createAttach({
    db,
    statements,
    access,
    view,
    allowFileRemote,
    onTaskSpaceWorktreeMarked,
  }).attach
  const bindings = createBindings({ db, statements, access, view, now })
  const lifecycle = createLifecycle({
    db,
    statements,
    access,
    view,
    now,
    backupService,
    onTaskSpacePurged,
  })
  const membership = createMembership({ db, statements, access })

  return {
    actorContext: access.actorContext,
    readProject: access.readProject,
    readTaskSpace: access.readTaskSpace,
    loadTaskSpaceRow: access.loadTaskSpaceRow,
    listReadable: access.listReadable,
    listStatusReadable: access.listStatusReadable,
    listAssociationCandidates: access.listAssociationCandidates,
    listAll: access.listAll,
    listTaskSpaces: lifecycle.listTaskSpaces,
    listAdminTaskSpaces: lifecycle.listAdminTaskSpaces,
    retireTaskSpace: lifecycle.retireTaskSpace,
    restoreTaskSpace: lifecycle.restoreTaskSpace,
    purgeProject: lifecycle.purgeProject,
    purgeTaskSpace: lifecycle.purgeTaskSpace,
    resolve: access.resolve,
    preflight: access.preflight,
    attach,
    authorizeTaskSpace: bindings.authorizeTaskSpace,
    listenerDetails: bindings.listenerDetails,
    detachAgent: bindings.detachAgent,
    inviteTeam: membership.inviteTeam,
    listTeamAccess: membership.listTeamAccess,
    removeTeam: membership.removeTeam,
    upsertMember: membership.upsertMember,
    listVisibleMembers: membership.listVisibleMembers,
    removeMember: membership.removeMember,
    disableProject: membership.disableProject,
  }
}
