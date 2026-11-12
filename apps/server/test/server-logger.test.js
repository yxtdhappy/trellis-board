import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServerLogger, redactServerLogText, serverLogFile } from '../logger.js'

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

test('服务端日志固定写入运行数据目录的 logs/server.log', () => {
  assert.equal(
    serverLogFile(path.join('somewhere', 'TrellisBoard')),
    path.join('somewhere', 'TrellisBoard', 'logs', 'server.log'),
  )
})

test('日志调用立即返回且 close 会写入完整记录', async () => {
  const workspace = makeWorkspace()
  const consoleWriter = quietConsole()
  const logger = createServerLogger({ dataDir: workspace.dataDir, console: consoleWriter })
  try {
    const returned = logger.info('启动完成')
    assert.equal(returned, undefined)
    assert.equal(fs.existsSync(serverLogFile(workspace.dataDir)), false)

    await logger.close()
    const contents = fs.readFileSync(serverLogFile(workspace.dataDir), 'utf8')
    assert.match(contents, / INFO 启动完成\n$/)
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('控制台收到原始参数，文件记录四个日志级别', async () => {
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
    const contents = fs.readFileSync(serverLogFile(workspace.dataDir), 'utf8')
    for (const level of ['LOG', 'INFO', 'WARN', 'ERROR']) {
      assert.match(contents, new RegExp(` ${level} `))
    }
    assert.doesNotMatch(contents, /console-secret/)
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
    maxBytes: 120,
    maxFiles: 3,
    flushBytes: 1,
  })
  try {
    for (let index = 0; index < 8; index += 1) {
      logger.info(`message-${index}-${'x'.repeat(40)}`)
    }
    await logger.close()

    const file = serverLogFile(workspace.dataDir)
    const files = [file, `${file}.1`, `${file}.2`].filter((candidate) => fs.existsSync(candidate))
    const contents = files.map((candidate) => fs.readFileSync(candidate, 'utf8')).join('')
    assert.equal(files.length, 3)
    assert.doesNotMatch(contents, /message-0-/)
    assert.match(contents, /message-7-/)
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
    await logger.close()
    assert.equal(consoleWriter.calls.error.length, 1)
    assert.match(consoleWriter.calls.error[0][0], /已降级为仅控制台输出/)
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('内存缓冲达到上限后丢弃新增文件日志，服务调用不等待磁盘', async () => {
  const workspace = makeWorkspace()
  const consoleWriter = quietConsole()
  const logger = createServerLogger({
    dataDir: workspace.dataDir,
    console: consoleWriter,
    maxBufferBytes: 50,
    flushDelayMs: 10_000,
    flushBytes: 10_000,
  })
  try {
    logger.info('kept')
    logger.info('x'.repeat(200))
    assert.doesNotThrow(() => logger.info('also-dropped'))
    await logger.close()

    const contents = fs.readFileSync(serverLogFile(workspace.dataDir), 'utf8')
    assert.match(contents, /kept/)
    assert.doesNotMatch(contents, /x{200}|also-dropped/)
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})

test('close 等待已排队的异步 flush', async () => {
  const workspace = makeWorkspace()
  const consoleWriter = quietConsole()
  const logger = createServerLogger({
    dataDir: workspace.dataDir,
    console: consoleWriter,
    flushBytes: 1,
  })
  try {
    logger.info('queued-before-close')
    await logger.close()
    assert.match(fs.readFileSync(serverLogFile(workspace.dataDir), 'utf8'), /queued-before-close/)
  } finally {
    fs.rmSync(workspace.root, { recursive: true, force: true })
  }
})
