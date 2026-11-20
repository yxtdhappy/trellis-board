import { withTransaction } from '../../database.js'
import { appendAuditEvent } from '../audit.js'
import { ERROR_CODES, teamError } from '../errors.js'
import { normalizeHandoffAck } from './shared.js'

function currentCycle(row) {
  return {
    materializedAt: row.materialized_at || null,
    materializedRevision:
      row.materialized_revision == null ? null : Number(row.materialized_revision),
  }
}

/**
 * ACK 必须声明自己处理的是哪一次物化轮次，任何状态推进与幂等判断之前先做 fencing。
 * `materializedAt` 是本轮首次物化时间，是轮次主键；同轮后续上传可能推进
 * `materializedRevision`，因此只有 at 缺失时才回退比较 revision。
 * 旧客户端不携带轮次字段时保持兼容；携带字段但与会话行不一致的迟到 ACK 直接拒绝。
 */
function assertHandoffCycle(row, ack, { logger, executionTaskKey }) {
  const current = currentCycle(row)
  const stale =
    ack.materializedAt != null
      ? ack.materializedAt !== current.materializedAt
      : ack.materializedRevision != null
        ? ack.materializedRevision !== current.materializedRevision
        : false
  if (!stale) return
  logger?.warn?.('handoff ACK 属于旧物化轮次，拒绝推进状态', {
    executionTaskKey,
    requestedMaterializedAt: ack.materializedAt,
    requestedMaterializedRevision: ack.materializedRevision,
    currentMaterializedAt: current.materializedAt,
    currentMaterializedRevision: current.materializedRevision,
  })
  throw teamError(409, 'HANDOFF_CYCLE_STALE', 'handoff ACK 属于旧物化轮次', {
    details: current,
  })
}

/** handoff 流程：创建者确认来源副本清理结果（幂等 ACK 与状态收敛）。 */
export function createHandoff({ db, statements, views, now = () => new Date(), logger = null }) {
  function ackHandoff(agent, taskSpaceId, executionTaskKey, input = {}) {
    views.assertAgentAccess(agent, taskSpaceId)
    const ack = normalizeHandoffAck(input)
    return withTransaction(db, () => {
      const row = views.taskRow(executionTaskKey)
      if (!row || row.task_space_id !== taskSpaceId) {
        throw teamError(404, ERROR_CODES.NOT_FOUND, '任务不存在')
      }
      if (row.created_by_user_id !== agent.userId) {
        throw teamError(403, ERROR_CODES.FORBIDDEN, '只能由任务创建者处理 handoff 清理')
      }
      assertHandoffCycle(row, ack, { logger, executionTaskKey })
      const nextState = ack.outcome === 'cleaned' ? 'completed' : 'source_cleanup_conflict'
      if (
        (row.handoff_state === 'completed' && ack.outcome === 'cleaned') ||
        (row.handoff_state === 'source_cleanup_conflict' && ack.outcome === 'conflict')
      ) {
        const audit = statements.readLastHandoffAudit.get(
          agent.userId,
          row.execution_task_key,
          ack.outcome,
        )
        let detail = null
        try {
          detail = audit ? JSON.parse(audit.detail_json) : null
        } catch {
          detail = null
        }
        const sameAck =
          detail &&
          detail.outcome === ack.outcome &&
          (detail.reason || null) === ack.reason &&
          (detail.backupId || null) === ack.backupId &&
          (detail.manifestSha256 || null) === ack.manifestSha256 &&
          Number(detail.fileCount || 0) === ack.fileCount &&
          Number(detail.totalBytes || 0) === ack.totalBytes
        if (!sameAck) {
          throw teamError(409, 'HANDOFF_ACK_MISMATCH', '重复 handoff ACK 与已完成结果不一致')
        }
        return {
          handoffState: row.handoff_state,
          outcome: ack.outcome,
          idempotent: true,
          updatedAt: row.updated_at,
        }
      }
      if (row.handoff_state !== 'source_cleanup_pending') {
        throw teamError(409, 'HANDOFF_NOT_READY', '任务当前没有待确认的 handoff 清理状态')
      }
      const lease = views.activeLease(row.execution_task_key)
      if (
        ack.outcome === 'cleaned' &&
        lease &&
        lease.user_id !== agent.userId &&
        lease.user_id !== row.assignee_user_id
      ) {
        throw teamError(409, 'HANDOFF_LEASE_HELD', '任务仍被其他客户端修改，暂不能确认清理')
      }
      const timestamp = now().toISOString()
      const project = statements.readProject.get(row.project_id)
      appendAuditEvent(db, {
        actorUserId: agent.userId,
        actorAgentId: agent.id,
        teamId: project?.owner_team_id || null,
        projectId: row.project_id,
        action: 'task_handoff_cleanup_ack',
        targetType: 'sync_task',
        targetId: row.execution_task_key,
        result: ack.outcome,
        occurredAt: timestamp,
        detail: {
          outcome: ack.outcome,
          reason: ack.reason,
          backupId: ack.backupId,
          manifestSha256: ack.manifestSha256,
          fileCount: ack.fileCount,
          totalBytes: ack.totalBytes,
        },
      })
      const update = statements.updateHandoffState.run(nextState, timestamp, row.execution_task_key)
      if (Number(update.changes) !== 1) {
        throw teamError(409, ERROR_CODES.CONFLICT, 'handoff 状态已变化，请刷新后重试')
      }
      return {
        handoffState: nextState,
        outcome: ack.outcome,
        idempotent: false,
        updatedAt: timestamp,
      }
    })
  }

  return { ackHandoff }
}
