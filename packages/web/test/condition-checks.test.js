import assert from 'node:assert/strict'
import test from 'node:test'
import { conditionBadges, conditionMode, conditionRows } from '../src/lib/condition-checks.js'

const stages = [
  { id: 'prd', label: '需求', index: 1, complete: true, evidence: 'PRD 已填写；验收项 2/4 已勾选' },
  { id: 'design', label: '设计', index: 3, complete: false, evidence: '没有 design.md' },
  {
    id: 'implementPlan',
    label: '实施计划',
    index: 4,
    complete: false,
    evidence: '没有 implement.md',
  },
  { id: 'review', label: '规划评审', index: 6, complete: true, evidence: '规划已放行' },
  { id: 'implement', label: '实现', index: 7, complete: false, evidence: '尚无实施报告' },
  { id: 'check', label: '检查', index: 8, complete: false, evidence: '尚无检查报告' },
  { id: 'commit', label: '工作提交', index: 11, complete: false, evidence: '没有 commit' },
  { id: 'archive', label: '归档', index: 12, complete: false, evidence: '仍在进行中目录' },
]

test('开工条件映射到阶段、证据和建议动作', () => {
  const rows = conditionRows(
    [
      'PRD 的 Requirements 与 Acceptance Criteria',
      '非骨架的 Design 文档',
      'Implement 执行计划',
      '规划评审证据或人工检查点',
    ],
    stages,
    'start',
  )

  assert.deepEqual(
    rows.map((row) => row.stageId),
    ['prd', 'design', 'implementPlan', 'review'],
  )
  assert.deepEqual(
    rows.map((row) => row.nextAction),
    ['补齐需求与验收内容', '补设计文档', '补实施计划', '补规划评审'],
  )
  assert.equal(rows[0].evidence, 'PRD 已填写；验收项 2/4 已勾选')
})

test('完成条件支持动态验收计数并保留全部缺口', () => {
  const rows = conditionRows(
    [
      '实施报告或等效实现证据',
      '检查报告或明确通过的检查证据',
      'PRD 验收项（2/4 已勾选）',
      '工作提交 commit',
      '归档记录',
    ],
    stages,
    'completion',
  )

  assert.deepEqual(
    rows.map((row) => row.stageId),
    ['implement', 'check', 'prd', 'commit', 'archive'],
  )
  assert.equal(rows[2].stageLabel, '需求')
  assert.equal(rows[2].nextAction, '勾选验收项')
})

test('未知缺口文本不会被静默丢弃', () => {
  const [row] = conditionRows(['后端新增但前端未识别的条件'], stages, 'start')
  assert.equal(row.label, '后端新增但前端未识别的条件')
  assert.equal(row.stageLabel, '其他')
  assert.equal(row.evidence, '当前证据未归类')
  assert.equal(row.nextAction, '补齐证据')
})

test('任务阶段决定条件展示和卡片标签', () => {
  const base = {
    archived: false,
    derivedStage: 'design',
    execution: { risk: { dorMissingCount: 2, dodMissingCount: 0 } },
  }
  assert.equal(conditionMode(base), 'planning')
  assert.deepEqual(conditionBadges(base), [{ kind: 'start', label: '开工条件缺 2' }])

  const closeout = {
    archived: false,
    derivedStage: 'implement',
    execution: { risk: { dorMissingCount: 2, dodMissingCount: 5 } },
  }
  assert.equal(conditionMode(closeout), 'closeout')
  assert.deepEqual(conditionBadges(closeout), [
    { kind: 'completion', label: '完成条件缺 5' },
    { kind: 'start', label: '开工条件仍缺 2' },
  ])

  assert.equal(conditionMode({ ...base, archived: true }), 'archived')
})
