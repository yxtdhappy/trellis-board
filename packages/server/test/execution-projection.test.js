import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase, withTransaction } from '../database.js'
import { appendTaskEvent } from '../execution-store.js'
import {
  computeAttentionReasons,
  deriveTaskRisk,
  dueDateDistance,
  projectBoardExecution,
  projectTaskDetailExecution,
  projectTaskExecution,
} from '../execution-projection.js'

const NOW = new Date('2026-10-30T09:00:00.000Z')

test('截止日期距离按本地日期计算并区分逾期和临近', () => {
  assert.equal(dueDateDistance('2026-10-30', NOW), 0)
  assert.equal(dueDateDistance('2026-11-02', NOW), 3)
  assert.equal(dueDateDistance('2026-10-28', NOW), -2)
  const task = {
    archived: false,
    priority: 'P1',
    derivedStage: 'check',
    executionIdentityValid: true,
  }
  const execution = {
    dueDate: '2026-10-28',
    lastActivityAt: '2026-10-20T00:00:00.000Z',
    historyStatus: 'tracking',
  }
  assert.deepEqual(computeAttentionReasons(task, execution, NOW), [
    'overdue',
    'priority',
    'stale',
    'checking',
  ])
})

test('身份冲突任务不投影共享扩展数据并显示冲突原因', () => {
  const task = {
    taskKey: 'demo::a',
    executionTaskKey: 'demo::same',
    executionIdentityValid: false,
    executionIdentityConflict: true,
    priority: 'P0',
    derivedStage: 'implement',
    archived: false,
  }
  const execution = projectTaskExecution(
    task,
    {
      dueDate: '2026-11-01',
      milestone: '不应泄露',
      tags: ['shared'],
    },
    NOW,
  )
  assert.deepEqual(execution.tags, [])
  assert.equal(execution.milestone, '')
  assert.equal(execution.historyStatus, 'missing')
  assert.equal(execution.attentionReasons.includes('identity_conflict'), true)
})

test('board 投影一次组合任务与保存视图', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-projection-'))
  const dataDir = path.join(root, 'data')
  const db = openDatabase({
    databaseFile: path.join(dataDir, 'board.sqlite'),
    legacyFiles: {
      repositoriesFile: path.join(dataDir, 'repos.json'),
      metadataFile: path.join(dataDir, 'task-metadata.json'),
      scanCacheFile: path.join(dataDir, 'scan-cache.json'),
      stateFile: path.join(dataDir, 'board-state.json'),
    },
    fallbackRepositories: [],
    logger: { warn() {} },
  })
  try {
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO task_execution(
        execution_task_key, due_date, milestone, created_at, updated_at
      ) VALUES ('demo::task', '2026-11-01', 'MVP', ?, ?)
    `).run(now, now)
    db.prepare(`
      INSERT INTO task_tag(execution_task_key, tag, created_at)
      VALUES ('demo::task', '后端', ?)
    `).run(now)
    const board = {
      generatedAt: now,
      projects: [],
      tasks: [
        {
          taskKey: 'demo::.trellis/tasks/task',
          executionTaskKey: 'demo::task',
          executionIdentityValid: true,
          projectId: 'demo',
          projectName: 'Demo',
          title: 'Task',
          priority: 'P1',
          derivedStage: 'implement',
          archived: false,
        },
      ],
    }
    const savedViews = [{ id: 'view', name: '视图', filter: { priorities: ['P1'] } }]
    const projected = projectBoardExecution(board, savedViews, db, NOW)
    assert.deepEqual(projected.savedViews, savedViews)
    assert.equal(projected.tasks[0].execution.dueDate, '2026-11-01')
    assert.equal(projected.tasks[0].execution.milestone, 'MVP')
    assert.deepEqual(projected.tasks[0].execution.tags, ['后端'])
    assert.equal(projected.tasks[0].execution.historyStatus, 'missing')
    assert.equal(projected.tasks[0].execution.attentionReasons.includes('due_soon'), true)
    assert.equal(projected.tasks[0].execution.attentionReasons.includes('implementing'), true)
  } finally {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('依赖投影在列表保持轻量，并在详情区分 blockedBy、blocks 和解除历史', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-dependency-projection-'))
  const dataDir = path.join(root, 'data')
  const db = openDatabase({
    databaseFile: path.join(dataDir, 'board.sqlite'),
    legacyFiles: {
      repositoriesFile: path.join(dataDir, 'repos.json'),
      metadataFile: path.join(dataDir, 'task-metadata.json'),
      scanCacheFile: path.join(dataDir, 'scan-cache.json'),
      stateFile: path.join(dataDir, 'board-state.json'),
    },
    fallbackRepositories: [],
    logger: { warn() {} },
  })
  try {
    const createdAt = '2026-10-30T08:00:00.000Z'
    const resolvedAt = '2026-10-30T08:30:00.000Z'
    db.prepare(`
      INSERT INTO task_dependency(
        id, blocker_task_key, blocked_task_key, reason, created_by,
        created_at, resolved_at
      ) VALUES (?, ?, ?, ?, 'dev', ?, ?)
    `).run('dep-resolved', 'demo::b', 'demo::a', '已解除', createdAt, resolvedAt)
    db.prepare(`
      INSERT INTO task_dependency(
        id, blocker_task_key, blocked_task_key, reason, created_by,
        created_at, resolved_at
      ) VALUES (?, ?, ?, ?, 'dev', ?, NULL)
    `).run('dep-active', 'demo::c', 'demo::b', '等待 C 完成', createdAt)
    const tasks = ['a', 'b', 'c'].map((id) => ({
      taskKey: `demo::.trellis/tasks/${id}`,
      executionTaskKey: `demo::${id}`,
      executionIdentityValid: true,
      projectId: 'demo',
      projectName: 'Demo',
      title: id.toUpperCase(),
      priority: 'P2',
      derivedStage: 'design',
      archived: false,
      stages: [],
    }))
    const projected = projectBoardExecution({ generatedAt: NOW.toISOString(), tasks }, [], db, NOW)
    const byKey = new Map(projected.tasks.map((task) => [task.executionTaskKey, task]))
    assert.equal(byKey.get('demo::a').execution.isUnblockedReady, true)
    assert.equal(byKey.get('demo::b').execution.isBlocked, true)
    assert.equal(byKey.get('demo::b').execution.blockedByCount, 1)
    assert.equal(byKey.get('demo::c').execution.blocksCount, 1)
    assert.equal('blockedBy' in byKey.get('demo::b').execution, false)
    assert.equal(projected.flow.blockedCount, 1)
    assert.equal(projected.flow.unblockedReadyCount, 1)
    assert.equal(projected.flow.blockedDurationMs, 3_600_000)

    const detail = projectTaskDetailExecution(byKey.get('demo::b'), db, NOW, 200, {
      boardTasks: tasks,
    })
    assert.equal(detail.execution.blockedBy.length, 1)
    assert.equal(detail.execution.blockedBy[0].title, 'C')
    assert.equal(detail.execution.blockedBy[0].reason, '等待 C 完成')
    assert.equal(detail.execution.blockedBy[0].createdBy, 'dev')
    assert.equal(detail.execution.blockedBy[0].durationMs, 3_600_000)
    assert.deepEqual(detail.execution.blocks, [])
    assert.deepEqual(
      detail.execution.resolvedBlocks.map((item) => item.title),
      ['A'],
    )
    assert.equal(detail.execution.resolvedBlocks[0].durationMs, 1_800_000)
    assert.equal(detail.execution.attentionReasons.includes('blocked'), true)

    const resolvedDetail = projectTaskDetailExecution(byKey.get('demo::a'), db, NOW, 200, {
      boardTasks: tasks,
    })
    assert.deepEqual(resolvedDetail.execution.blockedBy, [])
    assert.deepEqual(
      resolvedDetail.execution.resolvedBlockedBy.map((item) => item.title),
      ['B'],
    )
    assert.equal(resolvedDetail.execution.resolvedBlockedBy[0].resolvedAt, resolvedAt)
    assert.equal(resolvedDetail.execution.resolvedBlockedBy[0].durationMs, 1_800_000)
    assert.deepEqual(resolvedDetail.execution.resolvedBlocks, [])
  } finally {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('WIP 达到和超出软上限只改变风险状态与流动提示', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-wip-projection-'))
  const dataDir = path.join(root, 'data')
  const db = openDatabase({
    databaseFile: path.join(dataDir, 'board.sqlite'),
    legacyFiles: {
      repositoriesFile: path.join(dataDir, 'repos.json'),
      metadataFile: path.join(dataDir, 'task-metadata.json'),
      scanCacheFile: path.join(dataDir, 'scan-cache.json'),
      stateFile: path.join(dataDir, 'board-state.json'),
    },
    fallbackRepositories: [],
    logger: { warn() {} },
  })
  try {
    const task = (index) => ({
      taskKey: `demo::.trellis/tasks/${index}`,
      executionTaskKey: `demo::${index}`,
      executionIdentityValid: true,
      archived: false,
      derivedStage: 'implement',
      stages: [],
    })
    const atLimit = projectBoardExecution(
      { generatedAt: NOW.toISOString(), tasks: [task(1), task(2)] },
      [],
      db,
      NOW,
      { executionWipLimit: 2 },
    )
    assert.equal(atLimit.flow.implementationWip, 2)
    assert.equal(atLimit.flow.wipState, 'at_limit')
    assert.equal(atLimit.tasks[0].execution.risk.wipState, 'at_limit')

    const overLimit = projectBoardExecution(
      { generatedAt: NOW.toISOString(), tasks: [task(1), task(2), task(3)] },
      [],
      db,
      NOW,
      { executionWipLimit: 2 },
    )
    assert.equal(overLimit.flow.wipState, 'over_limit')
    assert.equal(overLimit.tasks[2].execution.risk.wipState, 'over_limit')
  } finally {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('DoR 和 DoD 缺口从现有阶段证据派生且不修改阶段完成状态', () => {
  const planning = {
    archived: false,
    derivedStage: 'design',
    summary: {
      hasDesign: true,
      designMeaningful: false,
      hasImplement: false,
    },
    stages: [
      { id: 'prd', complete: false },
      { id: 'design', complete: true },
      { id: 'implementPlan', complete: false },
      { id: 'review', complete: false },
    ],
  }
  const planningRisk = deriveTaskRisk(planning)
  assert.deepEqual(planningRisk.dorMissing, [
    'PRD 的 Requirements 与 Acceptance Criteria',
    '非骨架的 Design 文档',
    'Implement 执行计划',
    '规划评审证据或人工检查点',
  ])
  assert.equal(planning.stages[0].complete, false)

  const manualPrd = {
    ...planning,
    summary: {
      prdMeaningful: false,
      hasDesign: true,
      designMeaningful: true,
      hasImplement: true,
    },
    stages: [
      { id: 'prd', complete: true, source: 'manual' },
      { id: 'design', complete: true },
      { id: 'implementPlan', complete: true },
      { id: 'review', complete: true },
    ],
  }
  assert.deepEqual(deriveTaskRisk(manualPrd).dorMissing, [
    'PRD 的 Requirements 与 Acceptance Criteria',
  ])

  const missingAcceptance = {
    ...manualPrd,
    summary: {
      ...manualPrd.summary,
      prdMeaningful: true,
      prdAcceptanceCount: 0,
    },
  }
  assert.deepEqual(deriveTaskRisk(missingAcceptance).dorMissing, [
    'PRD 的 Requirements 与 Acceptance Criteria',
  ])

  const implementing = {
    archived: false,
    derivedStage: 'implement',
    summary: {
      prdMeaningful: true,
      prdAcceptanceCount: 1,
      hasDesign: false,
      designMeaningful: false,
      hasImplement: false,
    },
    stages: [
      { id: 'prd', complete: true },
      { id: 'design', complete: false },
      { id: 'implementPlan', complete: false },
      { id: 'review', complete: true },
    ],
  }
  assert.deepEqual(deriveTaskRisk(implementing).dorMissing, [
    '非骨架的 Design 文档',
    'Implement 执行计划',
  ])

  const archivedWithPlanningGaps = {
    ...implementing,
    archived: true,
  }
  assert.deepEqual(deriveTaskRisk(archivedWithPlanningGaps).dorMissing, [])

  const closeout = {
    archived: false,
    derivedStage: 'check',
    commit: null,
    summary: {
      prdAcceptanceCount: 3,
      prdCheckedCount: 2,
    },
    stages: [
      { id: 'implement', complete: true },
      { id: 'check', complete: true },
    ],
  }
  assert.deepEqual(deriveTaskRisk(closeout).dodMissing, [
    'PRD 验收项（2/3 已勾选）',
    '工作提交 commit',
    '归档记录',
  ])
  assert.equal(closeout.stages[1].complete, true)

  const archivedGaps = {
    archived: true,
    commit: null,
    summary: {
      hasImplementationReport: false,
      hasCheckReport: false,
      prdAcceptanceCount: 0,
    },
    stages: [
      { id: 'implement', complete: true, source: 'archive-gap' },
      { id: 'check', complete: true, source: 'archive-gap' },
    ],
  }
  assert.deepEqual(deriveTaskRisk(archivedGaps).dodMissing, [
    '实施报告或等效实现证据',
    '检查报告或明确通过的检查证据',
    'PRD 验收项',
    '工作提交 commit',
  ])

  const archivedWithEvidence = {
    ...archivedGaps,
    commit: 'feature-sha',
    summary: {
      hasImplementationReport: true,
      hasCheckReport: true,
      prdAcceptanceCount: 1,
      prdCheckedCount: 1,
    },
  }
  assert.deepEqual(deriveTaskRisk(archivedWithEvidence).dodMissing, [])
})

test('归档任务详情返回历史与完整指标，列表只带轻量指标摘要', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-history-projection-'))
  const dataDir = path.join(root, 'data')
  const db = openDatabase({
    databaseFile: path.join(dataDir, 'board.sqlite'),
    legacyFiles: {
      repositoriesFile: path.join(dataDir, 'repos.json'),
      metadataFile: path.join(dataDir, 'task-metadata.json'),
      scanCacheFile: path.join(dataDir, 'scan-cache.json'),
      stateFile: path.join(dataDir, 'board-state.json'),
    },
    fallbackRepositories: [],
    logger: { warn() {} },
  })
  try {
    const executionTaskKey = 'demo::archived'
    const append = (id, type, occurredAt, payload, source = 'scan') =>
      appendTaskEvent(db, {
        executionTaskKey,
        eventType: type,
        source,
        actor: source === 'system' ? 'system' : 'dev',
        correlationId: `event-${id}`,
        occurredAt,
        payload,
      })
    append(
      1,
      'tracking_started',
      '2026-10-30T00:00:00.000Z',
      {
        after: { derivedStage: 'implement' },
      },
      'system',
    )
    append(2, 'stage_observed', '2026-10-30T00:10:00.000Z', {
      after: { derivedStage: 'implement' },
    })
    append(3, 'stage_observed', '2026-10-30T00:20:00.000Z', {
      after: { derivedStage: 'check' },
    })

    const task = {
      taskKey: 'demo::.trellis/tasks/archive/archived',
      executionTaskKey,
      executionIdentityValid: true,
      executionIdentityConflict: false,
      projectId: 'demo',
      projectName: 'Demo',
      title: 'Archived task',
      priority: 'P2',
      derivedStage: 'archive',
      archived: true,
      archivedAt: '2026-10-30T00:40:00.000Z',
      artifacts: { prd: { path: 'prd.md', content: '保留产物' } },
      stages: [],
    }
    const board = projectBoardExecution(
      { generatedAt: NOW.toISOString(), tasks: [task] },
      [],
      db,
      NOW,
    )
    const listed = board.tasks[0]
    assert.equal(listed.execution.metrics.completeness, 'tracked')
    assert.equal(listed.execution.metrics.cycleTimeMs, 10 * 60_000)
    assert.equal('events' in listed.execution, false)
    assert.equal('history' in listed.execution, false)

    const detail = projectTaskDetailExecution(listed, db, NOW, 1000, {
      boardTasks: [task],
    })
    assert.equal(detail.artifacts.prd.content, '保留产物')
    assert.equal(detail.execution.historyError, null)
    assert.equal(detail.execution.metricsError, null)
    assert.equal(detail.execution.history.events.length, 3)
    assert.deepEqual(
      detail.execution.history.events.map((item) => item.type),
      ['stage_observed', 'stage_observed', 'tracking_started'],
    )
    assert.equal(detail.execution.history.undo.available, false)
    assert.match(detail.execution.history.undo.disabledReason, /归档任务只读/)
    assert.equal(detail.execution.metrics.completeness, 'tracked')
    assert.equal(detail.execution.metrics.leadTimeMs, 30 * 60_000)
    assert.equal(detail.execution.metrics.cycleTimeMs, 10 * 60_000)
  } finally {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('事件读取失败只影响历史与指标，任务产物和阶段仍返回', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-history-isolation-'))
  const dataDir = path.join(root, 'data')
  const db = openDatabase({
    databaseFile: path.join(dataDir, 'board.sqlite'),
    legacyFiles: {
      repositoriesFile: path.join(dataDir, 'repos.json'),
      metadataFile: path.join(dataDir, 'task-metadata.json'),
      scanCacheFile: path.join(dataDir, 'scan-cache.json'),
      stateFile: path.join(dataDir, 'board-state.json'),
    },
    fallbackRepositories: [],
    logger: { warn() {} },
  })
  try {
    const task = {
      taskKey: 'demo::.trellis/tasks/isolation',
      executionTaskKey: 'demo::isolation',
      executionIdentityValid: true,
      executionIdentityConflict: false,
      projectId: 'demo',
      projectName: 'Demo',
      title: 'Local error isolation',
      priority: 'P2',
      derivedStage: 'implement',
      archived: false,
      artifacts: { prd: { path: 'prd.md', content: '保留产物' } },
      stages: [{ id: 'prd', complete: true }],
    }
    db.exec('DROP TABLE task_event')
    const detail = projectTaskDetailExecution(task, db, NOW, 1000, {
      boardTasks: [task],
    })

    assert.equal(detail.title, task.title)
    assert.equal(detail.artifacts.prd.content, '保留产物')
    assert.deepEqual(detail.stages, task.stages)
    assert.match(detail.execution.historyError, /task_event/)
    assert.equal(detail.execution.metricsError, detail.execution.historyError)
    assert.deepEqual(detail.execution.history.events, [])
    assert.equal(detail.execution.metrics.completeness, 'missing')
    assert.equal(detail.execution.history.undo.available, false)
  } finally {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('board 事件截断时只返回指标摘要，不泄漏历史正文', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-history-board-limit-'))
  const dataDir = path.join(root, 'data')
  const db = openDatabase({
    databaseFile: path.join(dataDir, 'board.sqlite'),
    legacyFiles: {
      repositoriesFile: path.join(dataDir, 'repos.json'),
      metadataFile: path.join(dataDir, 'task-metadata.json'),
      scanCacheFile: path.join(dataDir, 'scan-cache.json'),
      stateFile: path.join(dataDir, 'board-state.json'),
    },
    fallbackRepositories: [],
    logger: { warn() {} },
  })
  try {
    const executionTaskKey = 'demo::limited'
    withTransaction(db, () => {
      appendTaskEvent(db, {
        executionTaskKey,
        eventType: 'tracking_started',
        source: 'system',
        actor: 'system',
        correlationId: 'tracking',
        occurredAt: '2026-10-30T00:00:00.000Z',
        payload: { after: { derivedStage: 'implement' } },
      })
      for (let index = 0; index < 1000; index += 1) {
        appendTaskEvent(db, {
          executionTaskKey,
          eventType: 'stage_observed',
          source: 'scan',
          actor: 'system',
          correlationId: `scan-${index}`,
          occurredAt: new Date(Date.parse('2026-10-30T00:00:01.000Z') + index * 1000).toISOString(),
          payload: {
            after: { derivedStage: index % 2 ? 'check' : 'implement' },
          },
        })
      }
    })
    const task = {
      taskKey: 'demo::.trellis/tasks/limited',
      executionTaskKey,
      executionIdentityValid: true,
      executionIdentityConflict: false,
      projectId: 'demo',
      projectName: 'Demo',
      title: 'Limited history',
      priority: 'P2',
      derivedStage: 'implement',
      archived: false,
      stages: [],
    }
    const board = projectBoardExecution(
      { generatedAt: NOW.toISOString(), tasks: [task] },
      [],
      db,
      NOW,
    )
    const execution = board.tasks[0].execution
    assert.equal(execution.metrics.completeness, 'partial')
    assert.equal(execution.metrics.missingReasonCount > 0, true)
    assert.equal('events' in execution, false)
    assert.equal('history' in execution, false)
  } finally {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
