import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_FRAME_BYTES,
  ERROR_CODES,
  RPC,
  RpcError,
  encodeFrame,
  createFrameDecoder,
  withTimeout,
  isRequest,
  isNotification,
  isResponse,
  successResponse,
  errorResponse,
} from '../server/plugins/protocol.js'

test('encodeFrame 输出单行 JSON 并以换行结尾', () => {
  const frame = encodeFrame({ jsonrpc: '2.0', id: 1, method: 'ping' })
  assert.ok(frame.endsWith('\n'))
  assert.equal(frame.slice(0, -1).includes('\n'), false)
  assert.deepEqual(JSON.parse(frame), { jsonrpc: '2.0', id: 1, method: 'ping' })
})

test('encodeFrame 拒绝超过 1 MiB 的帧', () => {
  const oversized = { payload: 'x'.repeat(MAX_FRAME_BYTES + 10) }
  assert.throws(
    () => encodeFrame(oversized),
    (error) => error instanceof RpcError && error.code === ERROR_CODES.RATE_LIMITED,
  )
})

test('解码器支持分片与同块多帧，忽略空行', () => {
  const messages = []
  const errors = []
  const decoder = createFrameDecoder({
    onMessage: (message) => messages.push(message),
    onError: (error) => errors.push(error),
  })
  const first = '{"jsonrpc":"2.0","id":1,"result":{}}\n'
  const second = '{"jsonrpc":"2.0","id":2,"result":{}}\n'
  decoder.push(first.slice(0, 10))
  decoder.push(first.slice(10) + '\n' + second)
  assert.equal(errors.length, 0)
  assert.deepEqual(
    messages.map((message) => message.id),
    [1, 2],
  )
})

test('解码器对非法 JSON 报 -32700 并继续处理后续帧', () => {
  const messages = []
  const errors = []
  const decoder = createFrameDecoder({
    onMessage: (message) => messages.push(message),
    onError: (error) => errors.push(error),
  })
  decoder.push('{not json}\n')
  decoder.push('{"jsonrpc":"2.0","id":7,"result":{}}\n')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].rpcCode, RPC.PARSE_ERROR)
  assert.equal(messages[0].id, 7)
})

test('解码器丢弃超限帧且不污染后续帧', () => {
  const messages = []
  const errors = []
  const decoder = createFrameDecoder({
    onMessage: (message) => messages.push(message),
    onError: (error) => errors.push(error),
  })
  decoder.push(`${JSON.stringify({ data: 'y'.repeat(MAX_FRAME_BYTES + 10) })}\n`)
  decoder.push('{"jsonrpc":"2.0","id":3,"result":{}}\n')
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, ERROR_CODES.RATE_LIMITED)
  assert.equal(decoder.dropped, 1)
  assert.equal(messages[0].id, 3)
})

test('解码器在无换行的超长缓冲区上丢弃并重置', () => {
  const errors = []
  const decoder = createFrameDecoder({
    onMessage: () => {},
    onError: (error) => errors.push(error),
  })
  decoder.push('z'.repeat(MAX_FRAME_BYTES + 1))
  assert.equal(errors.length, 1)
  assert.equal(decoder.pending, '')
  decoder.push('{"jsonrpc":"2.0","id":4,"result":{}}\n')
  assert.equal(decoder.dropped, 1)
})

test('消息类型判定区分请求、通知与响应', () => {
  assert.equal(isRequest({ jsonrpc: '2.0', id: 1, method: 'task/get' }), true)
  assert.equal(isNotification({ jsonrpc: '2.0', method: 'event/ack' }), true)
  assert.equal(isResponse({ jsonrpc: '2.0', id: 1, result: {} }), true)
  assert.equal(isResponse({ jsonrpc: '2.0', id: 1, error: { code: -1 } }), true)
  assert.equal(isRequest({ jsonrpc: '2.0', method: 'x' }), false)
})

test('RpcError 序列化把应用错误码放进 error.data.code', () => {
  const error = new RpcError(ERROR_CODES.PERMISSION_DENIED, '拒绝', { rpcCode: RPC.INTERNAL_ERROR })
  const payload = errorResponse(9, error)
  assert.equal(payload.error.code, RPC.INTERNAL_ERROR)
  assert.equal(payload.error.data.code, 1001)
  assert.equal(payload.error.message, '拒绝')
})

test('successResponse 保持 JSON-RPC 2.0 形状', () => {
  assert.deepEqual(successResponse(5, { ok: true }), {
    jsonrpc: '2.0',
    id: 5,
    result: { ok: true },
  })
})

test('withTimeout 在预算内返回结果', async () => {
  const value = await withTimeout(Promise.resolve('ok'), 100)
  assert.equal(value, 'ok')
})

test('withTimeout 超时后抛 1003', async () => {
  // withTimeout 的预算计时器是 unref 的；这里保留一个 ref 计时器，
  // 避免 Node 22 在没有其它活跃句柄时提前结束事件循环导致用例 cancelled。
  const keepAlive = setTimeout(() => {}, 200)
  try {
    await assert.rejects(
      withTimeout(new Promise(() => {}), 20, '太慢'),
      (error) => error.code === ERROR_CODES.TIMEOUT && error.message === '太慢',
    )
  } finally {
    clearTimeout(keepAlive)
  }
})
