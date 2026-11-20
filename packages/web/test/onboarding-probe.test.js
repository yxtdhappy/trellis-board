import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canProbeBranch,
  normalizePushState,
  onboardingErrorMessage,
  preflightBlockReason,
} from '../src/lib/onboarding-probe.js'

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
