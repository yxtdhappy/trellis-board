import { readWorkspaceSummary, taskWorkspaceMember } from './loader-cache.js'

export const STAGE_ORDER = [
  'prd',
  'research',
  'design',
  'implementPlan',
  'context',
  'review',
  'implement',
  'check',
  'e2e',
  'spec',
  'commit',
  'archive',
  'journal',
]

export const STAGE_META = {
  prd: { label: '需求', index: 1 },
  research: { label: '调研', index: 2 },
  design: { label: '设计', index: 3 },
  implementPlan: { label: '实施计划', index: 4 },
  context: { label: '上下文编排', index: 5 },
  review: { label: '规划评审', index: 6 },
  implement: { label: '实现', index: 7 },
  check: { label: '检查', index: 8 },
  e2e: { label: '真实验证', index: 9 },
  spec: { label: '规范回写', index: 10 },
  commit: { label: '工作提交', index: 11 },
  archive: { label: '归档', index: 12 },
  journal: { label: '会话记录', index: 13 },
}

export function hasMeaningfulPrd(content) {
  const requirements = content.match(/##\s+Requirements\s*\n([\s\S]*?)(?=\n##\s|$)/i)?.[1] || ''
  const acceptance =
    content.match(/##\s+Acceptance Criteria\s*\n([\s\S]*?)(?=\n##\s|$)/i)?.[1] || ''
  const meaningfulLines = [...requirements.split(/\r?\n/), ...acceptance.split(/\r?\n/)]
    .map((line) => line.trim())
    .filter((line) => line && !/^-\s*\[\s*\]\s*TBD\.?$/i.test(line) && !/^-?\s*TBD\.?$/i.test(line))
  return {
    initialized: meaningfulLines.length > 0,
    acceptanceCount: (acceptance.match(/^-\s*\[[ xX]\]/gm) || []).length,
    checkedCount: (acceptance.match(/^-\s*\[[xX]\]/gm) || []).length,
  }
}

export function hasMeaningfulDocument(content) {
  if (typeof content !== 'string' || !content.trim()) return false
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^#{1,6}\s/.test(line))
    .filter((line) => !/^[-*]?\s*(?:TBD|TODO|待补|待填写)[.。]?$/i.test(line))
    .some((line) => line.replace(/[`*_#[\]()>-]/g, '').trim().length >= 4)
}

const E2E_CONTEXT_PATTERN = /E2E|真机|真实页面|真实联调|浏览器验证|Playwright|Chrome DevTools/i
const E2E_COMPLETED_PATTERN =
  /已完成|已执行|已验证|已复测|验证通过|测试通过|端到端通过|(?:^|[|:：\s-])(?:通过|成功|PASS(?:ED)?|SUCCESS|OK|✅)(?:$|[|。；;\s（(])/i
const E2E_NEGATIVE_PATTERN =
  /未完成|未执行|未验证|未运行|尚未|待确认|待执行|等待|未通过|失败|blocked|不能标记/i
const E2E_DEFERRED_PATTERN = /通过后|完成后再|再做|下一步|后续|计划执行|准备执行|预计/i

function hasCompletedVerificationEvidence(content, source = '') {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const usableLines = lines.filter(
    (line) => !E2E_NEGATIVE_PATTERN.test(line) && !E2E_DEFERRED_PATTERN.test(line),
  )
  if (source === 'e2e-report') {
    return (
      E2E_CONTEXT_PATTERN.test(content) &&
      usableLines.some((line) => E2E_COMPLETED_PATTERN.test(line))
    )
  }
  return usableLines.some(
    (line) => E2E_CONTEXT_PATTERN.test(line) && E2E_COMPLETED_PATTERN.test(line),
  )
}

function hasCompletedCheckEvidence(content) {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const checkPattern = /测试|vitest|jest|test|lint|type.?check|编译|build|检查/i
  const completedPattern = /通过|passed|pass|成功|success|0 failures|0 errors/i
  const incompletePattern = /未执行|未运行|未通过|尚未|待执行|等待|失败|blocked/i
  return lines.some(
    (line) =>
      checkPattern.test(line) && completedPattern.test(line) && !incompletePattern.test(line),
  )
}

function hasCheckedAcceptanceEvidence(content) {
  const acceptance =
    content.match(/##\s+Acceptance Criteria\s*\n([\s\S]*?)(?=\n##\s|$)/i)?.[1] || ''
  return /^-\s*\[[xX]\]/m.test(acceptance)
}

function hasCheckedPlanEvidence(content) {
  return (
    (content.match(/^-\s*\[[xX]\].*(测试|验证|检查|test|verify|check|lint)/gim) || []).length > 0
  )
}

export function deriveCurrentStageFromStages(stages) {
  if (!Array.isArray(stages) || !stages.length) return 'prd'
  const archiveStage = stages.find((stage) => stage.id === 'archive')
  if (archiveStage?.complete) {
    const journalStage = stages.find((stage) => stage.id === 'journal')
    return journalStage?.complete ? 'journal' : 'archive'
  }
  const executionEnd = stages.findIndex((stage) => stage.id === 'check')
  const frontier = stages.reduce(
    (highest, stage, index) => (stage.complete && index <= executionEnd ? index : highest),
    0,
  )
  const next = stages.slice(frontier + 1).find((stage) => !stage.complete && !stage.optional)?.id
  return next || stages[stages.length - 1].id
}

export function createStageMap(evidence) {
  return STAGE_ORDER.map((id) => ({
    id,
    ...STAGE_META[id],
    complete: Boolean(evidence[id]?.complete),
    evidence: evidence[id]?.evidence || null,
    source: evidence[id]?.source || 'missing',
    optional: id === 'e2e',
  }))
}

export function inferDerivedStage(task, files, workspaceSummary = null) {
  const evidence = {}
  const prd = files.prd?.content || ''
  const prdInfo = hasMeaningfulPrd(prd)
  const implementationReport = files.implementationReport?.content || ''
  const checkReport = files.checkReport?.content || ''
  const e2eReport = files.e2eReport?.content || ''
  const implementPlan = files.implement?.content || ''
  const hasStarted = ['in_progress', 'completed'].includes(task.status)
  const hasCheckedAcceptance = hasCheckedAcceptanceEvidence(prd)
  const passedCheckReport = hasCompletedCheckEvidence(checkReport)
  const passedImplementationReport = hasCompletedCheckEvidence(implementationReport)
  const checkedPlan = hasCheckedPlanEvidence(implementPlan)
  const hasImplementationEvidence =
    task.status === 'completed' ||
    Boolean(task.commit) ||
    hasCheckedAcceptance ||
    Boolean(implementationReport.trim()) ||
    Boolean(checkReport.trim())
  const hasPlanningCutoff = prdInfo.initialized && (hasStarted || hasImplementationEvidence)
  const checkEvidence =
    hasImplementationEvidence &&
    (passedCheckReport ||
      passedImplementationReport ||
      hasCheckedAcceptance ||
      checkedPlan ||
      task.status === 'completed')
  const implementationSource = implementationReport.trim()
    ? 'implementation-report'
    : checkReport.trim()
      ? 'check-report'
      : hasCheckedAcceptance
        ? 'prd-acceptance'
        : task.commit
          ? 'task-json'
          : task.status === 'completed'
            ? 'status'
            : 'missing'
  const implementationEvidence = implementationReport.trim()
    ? `implementation-report.md 记录交付 ${implementationReport.length.toLocaleString('zh-CN')} 字符`
    : checkReport.trim()
      ? `check-report.md 记录实现检查 ${checkReport.length.toLocaleString('zh-CN')} 字符`
      : hasCheckedAcceptance
        ? 'PRD 验收项已勾选'
        : task.commit
          ? `task.json commit=${task.commit}`
          : task.status === 'completed'
            ? 'task.json status=completed'
            : hasStarted
              ? '任务已开始，但尚无实施报告、检查报告、验收勾选、提交或完成状态'
              : '任务尚未开始，也没有实施报告、检查报告、验收勾选、提交或完成状态'

  evidence.prd = {
    complete: Boolean(files.prd && prdInfo.initialized),
    source: files.prd ? 'file' : 'missing',
    evidence: files.prd
      ? prdInfo.initialized
        ? `PRD 已填写；验收项 ${prdInfo.checkedCount}/${prdInfo.acceptanceCount} 已勾选`
        : '仍为默认 PRD 骨架'
      : '没有 prd.md',
  }
  evidence.research = {
    complete: files.researchFiles.length > 0,
    source: 'file',
    evidence: files.researchFiles.length
      ? `research/ 下有 ${files.researchFiles.length} 个文件`
      : '没有 research 文件',
  }
  evidence.design = {
    complete: Boolean(files.design),
    source: 'file',
    evidence: files.design ? '存在 design.md' : '没有 design.md',
  }
  evidence.implementPlan = {
    complete: Boolean(files.implement),
    source: 'file',
    evidence: files.implement ? '存在 implement.md' : '没有 implement.md',
  }
  evidence.context = {
    complete: files.implementEntries > 0 && files.checkEntries > 0,
    source: 'file',
    evidence: `implement.jsonl ${files.implementEntries} 条 / check.jsonl ${files.checkEntries} 条`,
  }
  evidence.review = {
    complete: hasPlanningCutoff,
    source: hasPlanningCutoff ? (hasStarted ? 'status' : implementationSource) : 'status',
    evidence: hasPlanningCutoff
      ? hasStarted
        ? `task.json status=${task.status}，规划已放行`
        : '已有实施/检查完成证据，说明任务已进入开发'
      : hasImplementationEvidence
        ? '已有实施/检查完成证据，但 PRD 仍是默认骨架'
        : hasStarted
          ? '任务已开始，但 PRD 仍未有效填写'
          : '任务仍在 planning，且没有开发完成证据',
  }
  evidence.implement = {
    complete: hasImplementationEvidence,
    source: implementationSource,
    evidence: implementationEvidence,
  }
  evidence.check = {
    complete: checkEvidence,
    source: checkEvidence
      ? passedCheckReport
        ? 'check-report'
        : passedImplementationReport
          ? 'implementation-report'
          : hasCheckedAcceptance
            ? 'prd-acceptance'
            : checkedPlan
              ? 'implement-plan'
              : 'status'
      : 'missing',
    evidence: checkEvidence
      ? passedCheckReport
        ? 'check-report.md 记录了通过的测试、类型检查、编译或 lint'
        : passedImplementationReport
          ? 'implementation-report.md 记录了通过的检查'
          : hasCheckedAcceptance
            ? 'PRD 验收项已勾选'
            : checkedPlan
              ? 'implement.md 已勾选检查项'
              : '任务已完成，按 Trellis 状态视为检查阶段已收口'
      : checkedPlan
        ? 'implement.md 已勾选检查项，但缺少实施报告、检查报告、验收勾选、提交或完成状态'
        : '没有找到通过的持久检查证据，需人工确认',
  }
  const verificationSources = [
    { source: 'e2e-report', content: e2eReport },
    { source: 'check-report', content: checkReport },
    { source: 'implementation-report', content: implementationReport },
  ]
  const verificationEvidence = verificationSources.find(
    ({ source, content }) => content && hasCompletedVerificationEvidence(content, source),
  )
  evidence.e2e = {
    complete: Boolean(verificationEvidence),
    source: verificationEvidence?.source || 'missing',
    evidence: verificationEvidence
      ? verificationEvidence.source === 'e2e-report'
        ? 'e2e-report.md 记录了明确通过的真实验证'
        : '任务产物记录了明确通过的真实验证'
      : '可选步骤：没有真实验证证据；不阻塞规范和收尾',
  }
  const specEvidence = task.relatedFiles?.some((file) => file.startsWith('.trellis/spec/'))
  evidence.spec = {
    complete: Boolean(specEvidence),
    source: specEvidence ? 'task-json' : 'missing',
    evidence: specEvidence
      ? 'relatedFiles 含 .trellis/spec/'
      : 'relatedFiles 没有 spec 文件；需人工核验',
  }
  evidence.commit = {
    complete: Boolean(task.commit),
    source: 'task-json',
    evidence: task.commit ? `task.json commit=${task.commit}` : 'task.json 没有 commit 字段',
  }
  evidence.archive = {
    complete: task.archived,
    source: 'archive',
    evidence: task.archived ? '任务位于 archive/' : '任务仍在进行中目录',
  }
  const workspace =
    workspaceSummary || readWorkspaceSummary(task.repoPath, taskWorkspaceMember(task))
  evidence.journal = {
    complete: workspace.indexExists && workspace.journals > 0,
    source: 'workspace',
    evidence: `${task.assignee || task.creator || 'unknown'} 有 ${workspace.journals} 个 journal 文件`,
  }

  return evidence
}
