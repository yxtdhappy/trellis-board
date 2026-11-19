import type { BoardTask } from '../task-view.ts'

export const ARTIFACTS = [
  { key: 'source', label: 'WitOps 原文', hint: '从 WitOps 同步的任务字段与描述' },
  { key: 'prd', label: 'PRD', hint: '需求、范围与验收标准' },
  { key: 'design', label: 'Design', hint: '技术设计与关键取舍' },
  { key: 'implement', label: 'Implement', hint: '实施计划与检查项' },
  { key: 'implementationReport', label: '实施报告', hint: '实现结果与验证记录' },
  { key: 'checkReport', label: '检查报告', hint: '质量检查与问题闭环' },
  { key: 'e2eReport', label: 'E2E 报告', hint: '真实环境端到端验证' },
] as const

export type ArtifactEntry = { path?: string; content?: string; truncated?: boolean }

export function authoritativeTaskField<K extends keyof BoardTask>(
  task: BoardTask | null,
  detail: BoardTask,
  key: K,
): BoardTask[K] {
  return task && Object.hasOwn(task, key) ? task[key] : detail[key]
}

export function fileSizeLabel(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export function dependencyStateText(task: BoardTask) {
  const execution = task.execution || {}
  const blockedBy = execution.blockedBy || []
  const state = execution.isBlocked
    ? `当前被 ${blockedBy.length} 项依赖阻断`
    : execution.isUnblockedReady
      ? '已有阻断解除，当前无活动阻断，可继续推进'
      : '当前没有活动阻断'
  const wip =
    task.archived || task.derivedStage !== 'implement'
      ? '当前阶段不计入实现中 WIP'
      : execution.risk?.wipState === 'over_limit'
        ? '实现中 WIP 超出软上限'
        : execution.risk?.wipState === 'at_limit'
          ? '实现中 WIP 达到软上限'
          : '实现中 WIP 在软上限内'
  return `${state} · ${wip}`
}

export function readArtifacts(task: BoardTask | null) {
  const source = task?.artifacts
  if (!source || typeof source !== 'object') return []
  const record = source as Record<string, ArtifactEntry>
  return ARTIFACTS.map((definition) => ({
    ...definition,
    artifact: record[definition.key],
  })).filter((item) => item.artifact?.path)
}
