import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_SHARE_PARAM_LENGTH,
  buildProtocolUrl,
  buildShareUrl,
  parseSharePageParams,
  sanitizeShareParam,
  taskIdFromExecutionKey,
} from '../src/lib/share-link.ts'

const target = {
  origin: 'http://192.168.1.5:4317',
  taskSpaceId: 'space-a',
  taskId: '11-24-task',
}

test('分享链接跟随部署协议，不硬编码 https', () => {
  assert.equal(
    buildShareUrl(target),
    'http://192.168.1.5:4317/share.html?space=space-a&task=11-24-task',
  )
  assert.equal(
    buildShareUrl({
      ...target,
      origin: 'https://board.example.com',
    }).startsWith('https://'),
    true,
  )
})

test('origin 末尾斜杠不会产生双斜杠', () => {
  assert.match(
    buildShareUrl({ ...target, origin: 'https://board.example.com/' }),
    /\.com\/share\.html\?/,
  )
})

test('参数必须 URL 编码，避免任务 id 破坏查询串', () => {
  const url = buildShareUrl({ ...target, taskId: 'a&b=c' })
  assert.match(url, /task=a%26b%3Dc$/)
})

test('协议链接带 server origin 供客户端比对', () => {
  const url = buildProtocolUrl(target)
  assert.equal(url.startsWith('spec-board://task?'), true)
  const query = new URLSearchParams(url.slice('spec-board://task?'.length))
  assert.equal(query.get('server'), 'http://192.168.1.5:4317')
  assert.equal(query.get('space'), 'space-a')
  assert.equal(query.get('task'), '11-24-task')
})

test('executionTaskKey 去掉 taskSpaceId 前缀', () => {
  assert.equal(taskIdFromExecutionKey('space-a::11-24-task'), '11-24-task')
  assert.equal(taskIdFromExecutionKey('space::a::b'), 'a::b')
  assert.equal(taskIdFromExecutionKey('11-24-task'), '')
  assert.equal(taskIdFromExecutionKey(undefined), '')
})

test('中转页参数清洗与 origin 校验拒绝空白、控制字符、超长与非 http(s) 来源', () => {
  assert.equal(sanitizeShareParam('  task-a  '), 'task-a')
  assert.equal(sanitizeShareParam('   '), '')
  assert.equal(sanitizeShareParam('a\nb'), '')
  assert.equal(sanitizeShareParam('a\u0000b'), '')
  assert.equal(sanitizeShareParam('a\u007fb'), '')
  assert.equal(sanitizeShareParam('x'.repeat(MAX_SHARE_PARAM_LENGTH + 1)), '')

  assert.deepEqual(
    parseSharePageParams('?space=%20space-1%20&task=task-1', 'https://board.example.com:8443/'),
    {
      origin: 'https://board.example.com:8443',
      taskSpaceId: 'space-1',
      taskId: 'task-1',
    },
  )
  assert.equal(parseSharePageParams('?space=s%0A&task=t', 'http://127.0.0.1:4317'), null)
  assert.equal(parseSharePageParams('?space=s%0Aa&task=t', 'http://127.0.0.1:4317'), null)
  assert.equal(parseSharePageParams('?space=s&task=t', 'file://'), null)
  assert.equal(parseSharePageParams('?space=s&task=t', 'null'), null)
})
