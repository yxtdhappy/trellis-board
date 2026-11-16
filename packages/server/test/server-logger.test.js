import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServerLogger, redactServerLogText, serverLogDir } from '../logger.js'

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-server-logger-'))
  return { root, dataDir: path.join(root, 'data') }
}

function quietConsole() {
  const calls = { log: [], info: [], warn: [], error: [] }
  return {
    calls,
    log: (...args) => calls.log.push(args),
    info: (...args) => calls.info.push(args),
    warn: (...args) => calls.warn.push(args),
    error: (...args) => calls.error.push(args),
  }
}

function readLogRecords(dataDir) {
  const dir = serverLogDir(dataDir)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.log'))
    .flatMap((name) =>
      fs
        .readFileSync(path.join(dir, name), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    )
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
}

test('服务端日志固定写入运行数据目录的 logs 子目录', () => {
  assert.equal(
    serverLogDir(path.join('somewhere', 'TrellisBoard')),
    path.join('somewhere', 'TrellisBoard', 'logs'),
  )
})

test('日志调用立即返回且 close 会写入 JSON 记录', async () => {
  const workspace = makeWorkspace()
  const consoleWriter = quietConsole()
  const logger = createServerLogger({ dataDir: workspace.dataDir, console: consoleWriter })
  try {
    assert.equal(logger.info('启动完成'), undefined)
    await logger.close()
    const records = readLogRecords(workspace.dataDir)
    assert.equal(records.length, 1)
    assert.equal(records[0].msg, '启动完成')
    assert.equal(records[0].level, 30)
    assert.match(records[0].time, /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('控制台收到原始参数，文件记录四个级别并脱敏', async () => {
  const workspace = makeWorkspace()
  const consoleWriter = quietConsole()
  const detail = { password: 'console-secret' }
  const logger = createServerLogger({ dataDir: workspace.dataDir, console: consoleWriter })
  try {
    logger.log('log %s', 'value', detail)
    logger.info('info')
    logger.warn('warn')
    logger.error('error')
    assert.deepEqual(consoleWriter.calls.log[0], ['log %s', 'value', detail])
    assert.equal(consoleWriter.calls.info[0][0], 'info')
    assert.equal(consoleWriter.calls.warn[0][0], 'warn')
    assert.equal(consoleWriter.calls.error[0][0], 'error')

    await logger.close()
    const records = readLogRecords(workspace.dataDir)
    assert.deepEqual(
      records.map((record) => record.msg),
      ['log value { password: [REDACTED] }', 'info', 'warn', 'error'],
    )
    assert.deepEqual(
      records.map((record) => record.level),
      [30, 30, 40, 50],
    )
    assert.equal(JSON.stringify(records).includes('console-secret'), false)
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('Bearer、URL 用户信息、凭据键值和 Windows 路径写入文件前脱敏', () => {
  const text = redactServerLogText(
    [
      'Bearer abc.def',
      'https://alice:secret@example.com/repo',
      'git+ssh://git:ssh-secret@example.com/repo',
      'password=hunter2',
      'pairingCode: "PAIR-123"',
      'Authorization: Basic dXNlcjpwYXNz',
      'Cookie: theme=dark; session=session-secret',
      '{"deviceCredential":"device-secret","apiKey":"api-secret"}',
      'C:\\Users\\alice\\TrellisBoard\\server',
      'open "C:\\Users\\Alice Smith\\TrellisBoard\\server" failed',
      '\\\\server\\share\\logs',
    ].join('\n'),
  )

  for (const secret of [
    'abc.def',
    'alice:secret',
    'git:ssh-secret',
    'hunter2',
    'PAIR-123',
    'dXNlcjpwYXNz',
    'session-secret',
    'device-secret',
    'api-secret',
    'C:\\Users\\alice',
    'Alice Smith',
    '\\\\server\\share',
  ]) {
    assert.equal(text.includes(secret), false)
  }
  assert.match(text, /Bearer \[REDACTED\]/)
  assert.match(text, /\[本地路径\]/)
})

test('小容量配置执行轮转并淘汰最旧历史', async () => {
  const workspace = makeWorkspace()
  const consoleWriter = quietConsole()
  const logger = createServerLogger({
    dataDir: workspace.dataDir,
    console: consoleWriter,
    maxBytes: 400,
    maxFiles: 3,
  })
  try {
    // pino-roll 在 drain 之后才切换文件，逐条 flush 才能稳定触发轮转。
    for (let index = 0; index < 20; index += 1) {
      logger.info(`message-${index}-${'x'.repeat(40)}`)
      await logger.flush()
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await logger.close()

    const dir = serverLogDir(workspace.dataDir)
    const logFiles = () => fs.readdirSync(dir).filter((name) => name.endsWith('.log'))
    assert.ok(logFiles().length > 1)
    await waitFor(() => logFiles().length <= 3)
    assert.ok(logFiles().length <= 3)
    const messages = readLogRecords(workspace.dataDir).map((record) => record.msg)
    assert.equal(
      messages.some((message) => message.startsWith('message-19-')),
      true,
    )
    assert.equal(
      messages.some((message) => message.startsWith('message-0-')),
      false,
    )
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('日志目录不可用时只降级一次且 close 不抛错', async () => {
  const workspace = makeWorkspace()
  const consoleWriter = quietConsole()
  fs.mkdirSync(workspace.dataDir, { recursive: true })
  fs.writeFileSync(path.join(workspace.dataDir, 'logs'), 'not-a-directory')
  const logger = createServerLogger({ dataDir: workspace.dataDir, console: consoleWriter })
  try {
    logger.info('first')
    logger.warn('second')
    await waitFor(() => consoleWriter.calls.error.length > 0)
    await logger.close()
    assert.equal(consoleWriter.calls.error.length, 1)
    assert.match(consoleWriter.calls.error[0][0], /已降级为仅控制台输出/)
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('close 等待已排队的写入', async () => {
  const workspace = makeWorkspace()
  const consoleWriter = quietConsole()
  const logger = createServerLogger({ dataDir: workspace.dataDir, console: consoleWriter })
  try {
    logger.info('queued-before-close')
    await logger.close()
    const messages = readLogRecords(workspace.dataDir).map((record) => record.msg)
    assert.deepEqual(messages, ['queued-before-close'])
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})
