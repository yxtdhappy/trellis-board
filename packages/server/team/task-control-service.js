import { createHandoff } from './task-control/handoff.js'
import { createLeases } from './task-control/leases.js'
import { createProjection } from './task-control/projection.js'
import { createStatements, LEASE_DURATION_MS } from './task-control/shared.js'
import { createTasks } from './task-control/tasks.js'
import { createUploads } from './task-control/uploads.js'
import { createViews } from './task-control/views.js'

export function createTaskControlService({
  db,
  now = () => new Date(),
  leaseDurationMs = LEASE_DURATION_MS,
}) {
  const statements = createStatements(db)
  const views = createViews({ statements, now })
  const leases = createLeases({ db, statements, views, now, leaseDurationMs })
  const tasks = createTasks({ statements, views, leases, now })
  const uploads = createUploads({ statements, views, leases, tasks, now })
  const projection = createProjection({ statements, leases, tasks, now })
  const handoff = createHandoff({ db, statements, views, now })

  return {
    createPendingTask: tasks.createPendingTask,
    assignPendingTask: tasks.assignPendingTask,
    assertAgentAccess: views.assertAgentAccess,
    assertUploadAllowed: uploads.assertUploadAllowed,
    commitUpload: uploads.commitUpload,
    completeCommand: tasks.completeCommand,
    visibleTaskIds: views.visibleTaskIds,
    assertReadable: views.assertReadable,
    controlsForAgent: views.controlsForAgent,
    pendingTasks: views.pendingTasks,
    authoritativeTasks: views.authoritativeTasks,
    reconcileProjection: projection.reconcileProjection,
    claim: leases.claim,
    heartbeat: leases.heartbeat,
    release: leases.release,
    ackHandoff: handoff.ackHandoff,
    getTask: views.getTask,
    expireLeases: leases.expireLeases,
    publicTask: views.publicTask,
    publicLease: views.publicLease,
  }
}
