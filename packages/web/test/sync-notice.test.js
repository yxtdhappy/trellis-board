import test from 'node:test'
import assert from 'node:assert/strict'
import { syncNoticeView } from '../src/lib/sync-notice.js'

test('分支不一致消息包含项目、分支原因与恢复说明', () => {
  const view = syncNoticeView({
    type: 'task_sync_notice',
    projectName: 'trellis-board',
    branchName: 'main',
    taskSpaceId: 'space-board',
    message: '本地当前分支为 fix/offline-assign-materialize，绑定分支为 main',
  })
  assert.deepEqual(view, {
    id: 'sync-notice:trellis-board',
    title: '项目「trellis-board」已暂停同步',
    description:
      '本地当前分支为 fix/offline-assign-materialize，绑定分支为 main。切回绑定分支后会自动恢复。',
  })
})

test('缺少项目名时回退到通用标题并以 taskSpaceId 去重', () => {
  const view = syncNoticeView({
    type: 'task_sync_notice',
    taskSpaceId: 'space-1',
    message: '本地当前分支为 feature，绑定分支为 main。',
  })
  assert.equal(view?.id, 'sync-notice:space-1')
  assert.equal(view?.title, '任务同步已暂停')
  assert.equal(
    view?.description,
    '本地当前分支为 feature，绑定分支为 main。切回绑定分支后会自动恢复。',
  )
})

test('缺少 message 时用绑定分支兜底', () => {
  const view = syncNoticeView({
    type: 'task_sync_notice',
    projectName: 'repo',
    branchName: 'main',
  })
  assert.equal(view?.title, '项目「repo」已暂停同步')
  assert.equal(view?.description, '本地分支与绑定分支 main 不一致。切回绑定分支后会自动恢复。')
})

test('同项目不同任务空间复用同一个 toast id', () => {
  const first = syncNoticeView({
    type: 'task_sync_notice',
    projectName: 'repo',
    taskSpaceId: 'space-1',
  })
  const second = syncNoticeView({
    type: 'task_sync_notice',
    projectName: 'repo',
    taskSpaceId: 'space-2',
  })
  assert.equal(first?.id, second?.id)
})

test('忽略非同步消息或空负载', () => {
  assert.equal(syncNoticeView(null), null)
  assert.equal(syncNoticeView({ type: 'task_sync_error' }), null)
})
