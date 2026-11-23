import { boolean, existingValue, normalizeProjectMembers, taskVersion } from './team-normalize.js'

export function taskCommandState(taskSpace = {}) {
  if (taskSpace?.listenerState === 'disabled' || taskSpace?.status === 'disabled') {
    return { canSubmit: false, reason: '该分支任务空间已停用' }
  }
  if (taskSpace?.readOnly || taskSpace?.role === 'read_only') {
    return {
      canSubmit: false,
      reason: '当前账号对该分支只有只读权限',
    }
  }
  return { canSubmit: true, reason: null }
}

const TASK_CONTROL_VIEWS = {
  pending_delivery: {
    label: '等待客户端接管',
    description: '任务已保存到服务端，等待目标客户端上线后认领并落地；当前只展示服务端元数据。',
    tone: 'warning',
  },
  claimed: {
    label: '客户端已认领',
    description: '目标客户端已认领任务，正在落地完整内容；索引完成前不把正文视为可用。',
    tone: 'info',
  },
  materialized: {
    label: '任务已落地',
    description: '服务端已收到完整任务快照；文档长期历史仍以 Git 为准。',
    tone: 'success',
  },
  lease_expired: {
    label: '写入租约已过期',
    description: '当前写入租约已失效，其他授权客户端可申请接管；本页内容可能已落后。',
    tone: 'warning',
  },
  version_stale: {
    label: '控制版本待收敛',
    description: '服务端控制版本领先于当前索引投影，请刷新或等待索引收敛，不能视为实时一致。',
    tone: 'warning',
  },
  migration_conflict: {
    label: '迁移/身份冲突',
    description: '检测到多个执行身份或迁移冲突，需要人工确认，不能按单一实时任务处理。',
    tone: 'danger',
  },
  archived: {
    label: '已归档',
    description: '任务已归档；本地活动副本可能保留、进入受保护清理或需要按 Git 流程处理。',
    tone: 'neutral',
  },
  reassigned: {
    label: '等待新负责人接管',
    description: '任务负责人已变更，等待目标客户端接管；旧负责人的本地副本不会因改派立即删除。',
    tone: 'warning',
  },
  handoff_pending: {
    label: '等待目标认领',
    description: '任务已委派，等待目标客户端认领并上传完整内容。',
    tone: 'warning',
  },
  target_materializing: {
    label: '目标正在接管',
    description: '目标客户端正在认领和落地任务，完成后才允许清理创建者副本。',
    tone: 'info',
  },
  source_cleanup_pending: {
    label: '等待来源副本清理',
    description: '目标已落地完整内容，等待创建者本地副本完成受保护备份和清理。',
    tone: 'info',
  },
  source_cleanup_conflict: {
    label: '来源副本需保护',
    description: '创建者本地副本存在修改、Git 跟踪或备份问题，需要保留并按说明处理。',
    tone: 'danger',
  },
  completed: {
    label: '认领与清理已完成',
    description: '目标接管和来源副本清理已完成。',
    tone: 'success',
  },
}

function numericVersion(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

function normalizedControlValue(source, camel, snake) {
  return String(existingValue(source, camel, snake) ?? '')
    .trim()
    .toLowerCase()
}

export function taskControlView(task = {}) {
  const source = task && typeof task === 'object' && !Array.isArray(task) ? task : {}
  const explicitState = normalizedControlValue(source, 'controlState', 'control_state')
  const materializationState = normalizedControlValue(
    source,
    'materializationState',
    'materialization_state',
  )
  const handoffState = normalizedControlValue(source, 'handoffState', 'handoff_state')
  const leaseStatus = normalizedControlValue(source, 'leaseStatus', 'lease_status')
  const leaseExpiresAt = String(
    existingValue(source, 'leaseExpiresAt', 'lease_expires_at') ?? '',
  ).trim()
  const controlVersion = numericVersion(
    existingValue(source, 'controlTaskVersion', 'control_task_version'),
  )
  const indexedVersion = numericVersion(taskVersion(source))
  const previousAssigneeUserId =
    existingValue(source, 'previousAssigneeUserId', 'previous_assignee_user_id') ?? null
  const identityConflict =
    boolean(existingValue(source, 'executionIdentityConflict', 'execution_identity_conflict')) ||
    boolean(existingValue(source, 'migrationConflict', 'migration_conflict'))
  const activeLeaseExpired =
    leaseStatus === 'expired' ||
    (leaseStatus === 'active' &&
      Boolean(leaseExpiresAt) &&
      Number.isFinite(Date.parse(leaseExpiresAt)) &&
      Date.parse(leaseExpiresAt) <= Date.now()) ||
    boolean(existingValue(source, 'leaseExpired', 'lease_expired'))
  const handoffActive = Boolean(handoffState) && !['none', 'completed'].includes(handoffState)
  const hasControlMetadata = Boolean(
    explicitState ||
    materializationState ||
    handoffActive ||
    controlVersion != null ||
    leaseStatus ||
    previousAssigneeUserId ||
    identityConflict,
  )
  if (!hasControlMetadata) {
    return {
      available: false,
      state: 'unavailable',
      label: '',
      description: '',
      tone: 'neutral',
      contentMaterialized: true,
    }
  }

  let state = explicitState
  if (boolean(source.archived)) {
    state = 'archived'
  } else if (!state) {
    if (identityConflict) state = 'migration_conflict'
    else if (handoffState === 'completed') state = 'completed'
    else if (handoffActive) state = handoffState
    else if (previousAssigneeUserId && ['pending', 'claimed'].includes(materializationState)) {
      state = 'reassigned'
    } else if (activeLeaseExpired && ['pending', 'claimed'].includes(materializationState)) {
      state = 'lease_expired'
    } else if (
      controlVersion != null &&
      indexedVersion != null &&
      controlVersion > indexedVersion
    ) {
      state = 'version_stale'
    } else if (materializationState === 'pending') {
      state = 'pending_delivery'
    } else if (materializationState === 'claimed') {
      state = 'claimed'
    } else if (materializationState === 'materialized') {
      state = 'materialized'
    } else {
      state = materializationState || 'unknown'
    }
  }

  const known = TASK_CONTROL_VIEWS[state]
  const requiresMaterialization = new Set([
    'pending_delivery',
    'claimed',
    'reassigned',
    'lease_expired',
    'target_materializing',
    'handoff_pending',
    'migration_conflict',
  ]).has(state)
  const contentMaterialized =
    !requiresMaterialization &&
    (boolean(source.archived) || materializationState === 'materialized') &&
    (!explicitState || Boolean(known))

  return {
    available: true,
    state,
    label: known?.label || '状态未知',
    description:
      known?.description || `服务端返回了未识别的控制状态“${state}”，当前不能视为实时一致。`,
    tone: known?.tone || 'warning',
    contentMaterialized,
  }
}

export function taskContentMaterialized(task = {}) {
  return taskControlView(task).contentMaterialized
}

export function assignableProjectMembers(project = {}) {
  return normalizeProjectMembers(project).filter(
    (member) =>
      ['lead', 'member'].includes(member.role) &&
      member.status === 'active' &&
      Boolean(member.trellisDevId),
  )
}

export function assignmentActionState(task = {}, assignee, assignees = []) {
  const readOnly = Boolean(task?.archived)
  const candidates = Array.isArray(assignees) ? assignees : []
  return {
    readOnly,
    canSubmit: Boolean(task) && !readOnly && Boolean(assignee) && candidates.includes(assignee),
  }
}

export function planEditingState(task = {}) {
  const readOnly = Boolean(task?.archived)
  return {
    readOnly,
    canEdit: Boolean(task) && !readOnly,
  }
}

export function isRetryableOperation(operation) {
  return ['pending', 'delivered', 'running', 'failed'].includes(operation?.status)
}

export function isActiveOperation(operation) {
  return ['pending', 'delivered', 'running'].includes(operation?.status)
}

export function isCompleteOperation(operation) {
  return ['succeeded', 'cancelled'].includes(operation?.status)
}

export function operationPollDelay(attempt, status) {
  if (status === 'delivered' || status === 'running') {
    return Math.min(8_000, 1_500 * (attempt + 1))
  }
  return Math.min(4_000, 700 * 2 ** attempt)
}
