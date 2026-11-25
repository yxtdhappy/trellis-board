import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canProbeBranch,
  normalizePushState,
  onboardingErrorMessage,
  preflightBlockReason,
} from '../src/lib/onboarding-probe.js'
import {
  normalizeAssociation,
  normalizePreflight,
  preflightDifferenceLabel,
  preflightDifferenceTone,
  preflightPresentationMode,
} from '../src/features/board/dialogs/project-onboarding-normalize.ts'

test('分支探测只在分支和远端 URL 都非空时触发', () => {
  assert.equal(canProbeBranch('dev', 'https://github.com/example/repo.git'), true)
  assert.equal(canProbeBranch('dev', '  https://github.com/example/repo.git  '), true)
  assert.equal(canProbeBranch('', 'https://github.com/example/repo.git'), false)
  assert.equal(canProbeBranch('   ', 'https://github.com/example/repo.git'), false)
  assert.equal(canProbeBranch('dev', ''), false)
  assert.equal(canProbeBranch('dev', '   '), false)
  assert.equal(canProbeBranch(null, null), false)
})

test('预检只在 Trellis 任务目录和首次推送就绪后开放', () => {
  assert.equal(
    preflightBlockReason({ hasTrellis: false, hasTasks: true }),
    '请先初始化 Trellis 任务目录。',
  )
  assert.equal(
    preflightBlockReason({ hasTrellis: true, hasTasks: false }),
    '请先初始化 Trellis 任务目录。',
  )
  assert.equal(
    preflightBlockReason({
      hasTrellis: true,
      hasTasks: true,
      requiresPushCheck: true,
      pushState: 'waiting_commit',
    }),
    '请先提交（commit）并推送（push）Trellis 初始化文件。',
  )
  assert.equal(
    preflightBlockReason({
      hasTrellis: true,
      hasTasks: true,
      requiresPushCheck: true,
      pushState: 'ready',
    }),
    '',
  )
  assert.equal(
    preflightBlockReason({ hasTrellis: true, hasTasks: true, requiresPushCheck: false }),
    '',
  )
})

test('推送状态规范化容忍缺失与非字符串字段', () => {
  assert.deepEqual(normalizePushState({ state: 'ready', message: '已推送', dirtySummary: 'M a' }), {
    state: 'ready',
    message: '已推送',
    dirtySummary: 'M a',
  })
  assert.deepEqual(normalizePushState({ state: 42, message: null }), {
    state: '',
    message: '',
    dirtySummary: '',
  })
  assert.deepEqual(normalizePushState(null), { state: '', message: '', dirtySummary: '' })
  assert.deepEqual(normalizePushState('ready'), { state: '', message: '', dirtySummary: '' })
})

test('接入错误提取真实消息，不可读时使用兜底', () => {
  assert.equal(
    onboardingErrorMessage(new Error('MISSING_TRELLIS: 请先初始化'), '任务预检失败'),
    'MISSING_TRELLIS: 请先初始化',
  )
  assert.equal(onboardingErrorMessage(' 网络连接失败 ', '任务预检失败'), '网络连接失败')
  assert.equal(
    onboardingErrorMessage(
      { message: 'sidecar 返回的具体错误', token: '不得显示' },
      '任务预检失败',
    ),
    'sidecar 返回的具体错误',
  )
  assert.equal(onboardingErrorMessage(new Error('   '), '任务预检失败'), '任务预检失败')
  assert.equal(onboardingErrorMessage({ token: '不得显示' }, '任务预检失败'), '任务预检失败')
})

test('normalizePreflight 提取差异标题和双端目录并兼容缺省字段', () => {
  const normalized = normalizePreflight({
    status: 'existing',
    revision: 5,
    differences: [
      {
        type: 'content-conflict',
        taskId: 'task-1',
        taskDir: '.trellis/tasks/11-25-a',
        title: '  冲突任务标题  ',
        local: { taskDir: '.trellis/tasks/11-25-a' },
        server: { taskDir: '.trellis/tasks/11-25-a-server' },
      },
      {
        type: 'server-only',
        taskId: 'task-2',
        taskDir: '.trellis/tasks/11-25-b',
      },
    ],
    counts: { same: 1, localOnly: 0, serverOnly: 1, conflicts: 1, invalid: 0 },
  })
  assert.ok(normalized)
  assert.equal(normalized.differences.length, 2)
  assert.deepEqual(normalized.differences[0], {
    type: 'content-conflict',
    taskId: 'task-1',
    taskDir: '.trellis/tasks/11-25-a',
    title: '冲突任务标题',
    localTaskDir: '.trellis/tasks/11-25-a',
    serverTaskDir: '.trellis/tasks/11-25-a-server',
  })
  assert.deepEqual(normalized.differences[1], {
    type: 'server-only',
    taskId: 'task-2',
    taskDir: '.trellis/tasks/11-25-b',
    title: null,
    localTaskDir: null,
    serverTaskDir: null,
  })
})

test('normalizeAssociation 保留 initialReviewPending 且映射差异标签与语义 tone', () => {
  const base = {
    projectId: 'p1',
    taskSpaceId: 's1',
    repoPath: 'C:/repo',
    displayName: 'Repo',
    branchName: 'main',
    status: 'approved',
  }
  assert.equal(
    normalizeAssociation({ ...base, initialReviewPending: true })?.initialReviewPending,
    true,
  )
  assert.equal(normalizeAssociation(base)?.initialReviewPending, false)
  assert.equal(preflightDifferenceLabel('server-only'), '仅服务端存在')
  assert.equal(preflightDifferenceLabel('local-only'), '仅本地存在')
  assert.equal(preflightDifferenceLabel('content-conflict'), '内容冲突')
  assert.equal(preflightDifferenceLabel('move-delete-conflict'), '移动或删除冲突')
  assert.equal(preflightDifferenceLabel('invalid'), '任务结构或身份异常')
  assert.equal(preflightDifferenceTone('server-only'), 'info')
  assert.equal(preflightDifferenceTone('local-only'), 'primary')
  assert.equal(preflightDifferenceTone('content-conflict'), 'warning')
  assert.equal(preflightDifferenceTone('move-delete-conflict'), 'danger')
  assert.equal(preflightDifferenceTone('invalid'), 'danger')
})

test('preflightPresentationMode 区分纯服务端任务与需确认差异', () => {
  assert.equal(preflightPresentationMode(null), 'none')
  assert.equal(
    preflightPresentationMode(
      normalizePreflight({
        status: 'existing',
        revision: 3,
        differences: [{ type: 'server-only', taskId: 't1', taskDir: '.trellis/tasks/11-25-a' }],
        counts: { same: 0, localOnly: 0, serverOnly: 1, conflicts: 0, invalid: 0 },
      }),
    ),
    'server-only',
  )
  assert.equal(
    preflightPresentationMode(
      normalizePreflight({
        status: 'existing',
        revision: 3,
        differences: [
          { type: 'server-only', taskId: 't1', taskDir: '.trellis/tasks/11-25-a' },
          { type: 'local-only', taskId: 't2', taskDir: '.trellis/tasks/11-25-b' },
        ],
        counts: { same: 0, localOnly: 1, serverOnly: 1, conflicts: 0, invalid: 0 },
      }),
    ),
    'review',
  )
  assert.equal(
    preflightPresentationMode(
      normalizePreflight({
        status: 'existing',
        revision: 3,
        differences: [
          { type: 'content-conflict', taskId: 't1', taskDir: '.trellis/tasks/11-25-a' },
        ],
        counts: { same: 0, localOnly: 0, serverOnly: 0, conflicts: 1, invalid: 0 },
      }),
    ),
    'review',
  )
  assert.equal(
    preflightPresentationMode(
      normalizePreflight({
        status: 'existing',
        revision: 3,
        differences: [],
        counts: { same: 2, localOnly: 0, serverOnly: 0, conflicts: 0, invalid: 0 },
      }),
    ),
    'ready',
  )
  assert.equal(
    preflightPresentationMode(
      normalizePreflight({
        status: 'new',
        revision: 0,
        differences: [],
        counts: { same: 0, localOnly: 1, serverOnly: 0, conflicts: 0, invalid: 0 },
      }),
    ),
    'bootstrap',
  )
  assert.equal(
    preflightPresentationMode(
      normalizePreflight({
        status: 'new',
        revision: 0,
        differences: [],
        counts: { same: 0, localOnly: 0, serverOnly: 0, conflicts: 0, invalid: 1 },
      }),
    ),
    'bootstrap-invalid',
  )
  assert.equal(
    preflightPresentationMode(
      normalizePreflight({
        status: 'access_required',
        revision: 0,
        differences: [],
        counts: { same: 0, localOnly: 0, serverOnly: 0, conflicts: 0, invalid: 0 },
      }),
    ),
    'blocked',
  )
})
