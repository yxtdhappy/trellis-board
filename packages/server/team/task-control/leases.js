import crypto from 'node:crypto'
import { withTransaction } from '../../database.js'
import { ERROR_CODES, teamError } from '../errors.js'
import { ACTIVE_LEASE, LEASE_DURATION_MS, text } from './shared.js'

/** 租约生命周期：过期回收、归档/改派撤销、获取续期、认领、心跳、释放。 */
export function createLeases({
  db,
  statements,
  views,
  now = () => new Date(),
  leaseDurationMs = LEASE_DURATION_MS,
}) {
  function expireLeases(timestamp = now().toISOString()) {
    statements.expireActiveLeases.run(timestamp, timestamp)
    statements.clearStaleTaskLeases.run(timestamp)
  }

  function revokeLeases(executionTaskKey, timestamp) {
    statements.revokeLeases.run(timestamp, executionTaskKey)
    statements.clearRevokedTaskLease.run(executionTaskKey)
  }

  function ensureLease(executionTaskKey, agent) {
    const timestampDate = now()
    const timestamp = timestampDate.toISOString()
    expireLeases(timestamp)
    const current = views.activeLease(executionTaskKey)
    if (current && current.agent_id !== agent.id) {
      throw teamError(409, 'TASK_LEASE_HELD', '任务正由其他客户端修改，请等待租约释放后接管', {
        details: {
          executionTaskKey,
          leaseExpiresAt: current.expires_at,
          holderUserId: current.user_id,
        },
      })
    }
    const expiresAt = new Date(timestampDate.getTime() + leaseDurationMs).toISOString()
    if (current) {
      statements.touchLease.run(timestamp, expiresAt, timestamp, current.id)
      statements.setTaskLease.run(current.id, timestamp, executionTaskKey)
      return { ...current, expires_at: expiresAt, last_heartbeat_at: timestamp }
    }
    const lease = {
      id: crypto.randomUUID(),
      token: crypto.randomUUID(),
      expiresAt,
      lastHeartbeatAt: timestamp,
    }
    statements.insertLease.run(
      lease.id,
      executionTaskKey,
      agent.id,
      agent.userId,
      lease.token,
      expiresAt,
      timestamp,
      timestamp,
      timestamp,
    )
    statements.setTaskLease.run(lease.id, timestamp, executionTaskKey)
    return {
      id: lease.id,
      execution_task_key: executionTaskKey,
      agent_id: agent.id,
      user_id: agent.userId,
      lease_token: lease.token,
      status: ACTIVE_LEASE,
      expires_at: expiresAt,
      last_heartbeat_at: timestamp,
    }
  }

  function claim(agent, taskSpaceId, executionTaskKey) {
    views.assertAgentAccess(agent, taskSpaceId)
    return withTransaction(db, () => {
      const row = views.taskRow(executionTaskKey)
      if (!row || row.task_space_id !== taskSpaceId) {
        throw teamError(404, ERROR_CODES.NOT_FOUND, '任务不存在')
      }
      if (row.archived) throw teamError(409, 'TASK_ARCHIVED', '归档任务不能认领')
      if (row.assignee_user_id !== agent.userId) {
        throw teamError(403, ERROR_CODES.FORBIDDEN, '只能认领分配给自己的任务')
      }
      const lease = ensureLease(row.execution_task_key, agent)
      if (row.materialization_state === 'pending') {
        statements.markTaskClaimed.run(now().toISOString(), row.execution_task_key)
      }
      return {
        task: views.publicTask(statements.readTask.get(row.execution_task_key)),
        lease: views.publicLease(lease),
      }
    })
  }

  function heartbeat(agent, taskSpaceId, executionTaskKey, input = {}) {
    views.assertAgentAccess(agent, taskSpaceId)
    return withTransaction(db, () => {
      const row = views.taskRow(executionTaskKey)
      if (!row || row.task_space_id !== taskSpaceId) {
        throw teamError(404, ERROR_CODES.NOT_FOUND, '任务不存在')
      }
      const lease = views.activeLease(row.execution_task_key)
      if (!lease || lease.agent_id !== agent.id || lease.user_id !== agent.userId) {
        throw teamError(409, 'TASK_LEASE_INVALID', '任务写租约无效或已过期')
      }
      const token = text(input.leaseToken, 200)
      if (token && token !== lease.lease_token) {
        throw teamError(409, 'TASK_LEASE_INVALID', '任务写租约令牌不匹配')
      }
      const timestampDate = now()
      const timestamp = timestampDate.toISOString()
      const expiresAt = new Date(timestampDate.getTime() + leaseDurationMs).toISOString()
      statements.touchLease.run(timestamp, expiresAt, timestamp, lease.id)
      return {
        task: views.publicTask(row),
        lease: views.publicLease({
          ...lease,
          expires_at: expiresAt,
          last_heartbeat_at: timestamp,
        }),
      }
    })
  }

  function release(agent, taskSpaceId, executionTaskKey, input = {}) {
    views.assertAgentAccess(agent, taskSpaceId)
    return withTransaction(db, () => {
      const row = views.taskRow(executionTaskKey)
      if (!row || row.task_space_id !== taskSpaceId) {
        throw teamError(404, ERROR_CODES.NOT_FOUND, '任务不存在')
      }
      const lease = views.activeLease(row.execution_task_key)
      if (!lease) return { released: true, idempotent: true }
      if (lease.agent_id !== agent.id || lease.user_id !== agent.userId) {
        throw teamError(403, ERROR_CODES.FORBIDDEN, '不能释放其他客户端的任务租约')
      }
      const token = text(input.leaseToken, 200)
      if (token && token !== lease.lease_token) {
        throw teamError(409, 'TASK_LEASE_INVALID', '任务写租约令牌不匹配')
      }
      const timestamp = now().toISOString()
      statements.releaseLease.run(timestamp, lease.id)
      statements.clearTaskLease.run(timestamp, row.execution_task_key)
      return { released: true, idempotent: false }
    })
  }

  return { expireLeases, revokeLeases, ensureLease, claim, heartbeat, release }
}
