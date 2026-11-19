import { ERROR_CODES, teamError } from '../errors.js'

const MAX_RATE_BATCHES_PER_SECOND = 5

export function createBatch({ statements, now, bindingContext }) {
  function checkRateLimit(agentId, taskSpaceId) {
    const cutoff = new Date(now().getTime() - 1000).toISOString()
    const count = Number(statements.batchCountInWindow.get(agentId, taskSpaceId, cutoff).count)
    if (count >= MAX_RATE_BATCHES_PER_SECOND) {
      throw teamError(429, ERROR_CODES.RATE_LIMITED, '同步批次过于频繁，请稍后重试')
    }
  }

  function writeCursor(agent, taskSpaceId, input = {}) {
    bindingContext(agent, taskSpaceId)
    const revision = Number(input.revision)
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw teamError(400, ERROR_CODES.INVALID_INPUT, 'cursor revision 必须是非负整数')
    }
    const timestamp = now().toISOString()
    statements.upsertCursor.run(agent.id, taskSpaceId, revision, timestamp)
    return {
      taskSpaceId,
      revision: Number(statements.cursorRevision.get(agent.id, taskSpaceId).revision),
      updatedAt: timestamp,
    }
  }

  return { checkRateLimit, writeCursor }
}
