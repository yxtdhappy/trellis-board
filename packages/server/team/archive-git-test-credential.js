import { formatGitRemote, normalizeGitRemote } from '@trellis-board/shared/remote-identity.js'

import { withTransaction } from '../database.js'
import { archiveCredentialOrigin } from './archive-git-credentials.js'
import { appendAuditEvent } from './audit.js'
import { ERROR_CODES, teamError } from './errors.js'

export async function testArchiveCredential(deps, actor, credentialId, signal = null) {
  const { db, config, credentials, store, activeTaskSpaces } = deps
  const profile = credentials.list().find((item) => item.id === String(credentialId || ''))
  if (!profile) throw teamError(404, ERROR_CODES.NOT_FOUND, '归档 Git 凭据不存在')
  const candidates = activeTaskSpaces().filter((space) => {
    try {
      const remote = normalizeGitRemote(space.remote_url, {
        allowFileRemote: Boolean(config?.allowLocalGitRemotes),
      })
      return archiveCredentialOrigin(remote) === profile.origin
    } catch {
      return false
    }
  })
  if (!candidates.length) {
    throw teamError(409, 'ARCHIVE_CREDENTIAL_NO_PROJECT', '该来源下没有可测试的活动任务空间')
  }
  const taskSpace = candidates[0]
  const resolved = credentials.resolveForRemote(taskSpace.remote_url, {
    allowFileRemote: Boolean(config?.allowLocalGitRemotes),
  })
  const result = await store.testCredential({
    credential: resolved.credential,
    remoteUrl: resolved.remote.url,
    branchName: taskSpace.branch_name,
    signal,
  })
  withTransaction(db, () => {
    appendAuditEvent(db, {
      actorUserId: actor.userId,
      action: 'archive_git_credential_tested',
      targetType: 'archive_git_credential',
      targetId: profile.id,
      result: 'success',
      detail: {
        origin: profile.origin,
        taskSpaceId: taskSpace.id,
        branchFound: result.branchFound,
      },
    })
  })
  return {
    ok: true,
    origin: profile.origin,
    taskSpaceId: taskSpace.id,
    branchName: taskSpace.branch_name,
    branchFound: result.branchFound,
  }
}
