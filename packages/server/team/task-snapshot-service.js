import { createApply } from './snapshot/apply.js'
import { createBatch } from './snapshot/batch.js'
import { createConflicts } from './snapshot/conflicts.js'
import { createOwnership } from './snapshot/ownership.js'
import { createBindingContext, createStatements } from './snapshot/shared.js'
import { createViews } from './snapshot/views.js'

export { purgeArchivedTaskFiles } from './snapshot/archive-files.js'

export function createTaskSnapshotService({
  db,
  taskSpaces,
  taskControl = null,
  onRevisionCommitted = null,
  onOwnershipInboxCleared = null,
  now = () => new Date(),
}) {
  const statements = createStatements(db)
  const bindingContext = createBindingContext({ statements, taskSpaces })
  const views = createViews({ statements, taskSpaces, taskControl, bindingContext })
  const ownership = createOwnership({ db, statements })
  const batch = createBatch({ statements, now, bindingContext })
  const apply = createApply({
    db,
    statements,
    taskSpaces,
    taskControl,
    now,
    onRevisionCommitted,
    onOwnershipInboxCleared,
    bindingContext,
    checkRateLimit: batch.checkRateLimit,
    validateCompleteTaskGroups: ownership.validateCompleteTaskGroups,
    validateTaskOwnership: ownership.validateTaskOwnership,
    persistMergeEvidence: ownership.persistMergeEvidence,
  })
  const conflicts = createConflicts({
    statements,
    now,
    bindingContext,
    applyChangesInternal: apply.applyChangesInternal,
  })

  return {
    snapshot: views.snapshot,
    directorySnapshot: views.directorySnapshot,
    listTaskSummaries: views.listTaskSummaries,
    taskFilesById: views.taskFilesById,
    preflight: views.preflight,
    taskOwnership: views.taskOwnership,
    applyChanges: apply.applyChanges,
    writeCursor: batch.writeCursor,
    listConflicts: conflicts.listConflicts,
    resolveConflict: conflicts.resolveConflict,
    bindingContext,
    manifestForDirectory: views.manifestForDirectory,
  }
}
