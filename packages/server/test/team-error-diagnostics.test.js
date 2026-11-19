import test from 'node:test'
import assert from 'node:assert/strict'
import { diagnosticError, errorSummary, sanitizeDiagnosticText } from '../team/error-diagnostics.js'
import { ERROR_CODES, TeamError } from '../team/errors.js'
import { createRefreshScheduler } from '../team/http.js'

test('TeamError 日志字段保留诊断并脱敏详情', () => {
  const error = new TeamError(
    503,
    ERROR_CODES.GIT_REMOTE_FAILED,
    '同步失败 C:\\Users\\alice\\private\\repo token=plain-secret',
    {
      details: {
        branch: 'dev',
        privateKey: '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
        sourcePath: 'C:\\Users\\alice\\private\\repo',
        token: 'plain-secret',
      },
    },
  )

  const diagnostic = diagnosticError(error)
  assert.equal(diagnostic.name, 'TeamError')
  assert.equal(diagnostic.code, ERROR_CODES.GIT_REMOTE_FAILED)
  assert.equal(diagnostic.status, 503)
  assert.match(diagnostic.message, /\[redacted-path\]/)
  assert.match(diagnostic.message, /token=\[redacted\]/)
  assert.deepEqual(diagnostic.details, {
    branch: 'dev',
    privateKey: '[redacted]',
    sourcePath: '[redacted-path]',
    token: '[redacted]',
  })
  assert.equal('stack' in diagnostic, false)
})

test('非 TeamError 日志包含脱敏后的 stack 和 cause', () => {
  const cause = new Error('cause token=cause-secret at /home/alice/private/repo')
  const error = new Error('connect failed at C:\\Users\\alice\\private\\repo')
  error.code = 'ECONNRESET'
  error.status = 502
  error.cause = cause

  const diagnostic = diagnosticError(error)
  assert.equal(diagnostic.name, 'Error')
  assert.equal(diagnostic.code, 'ECONNRESET')
  assert.equal(diagnostic.status, 502)
  assert.equal(diagnostic.message, 'connect failed at [redacted-path]')
  assert.match(diagnostic.stack, /\[redacted-path\]/)
  assert.doesNotMatch(diagnostic.stack, /C:\\Users\\alice/)
  assert.doesNotMatch(diagnostic.stack, /\/home\/alice/)
  assert.match(diagnostic.cause.message, /token=\[redacted\]/)
  assert.doesNotMatch(diagnostic.cause.message, /cause-secret|\/home\/alice/)
  assert.doesNotMatch(diagnostic.cause.stack, /\/home\/alice/)
})

test('定时刷新失败日志记录结构化 TeamError 字段', async () => {
  const warnings = []
  const error = new TeamError(502, ERROR_CODES.GIT_REMOTE_FAILED, '同步项目失败', {
    details: { branch: 'dev', token: 'scheduler-secret' },
  })
  const scheduler = createRefreshScheduler({
    refresh: async () => {
      throw error
    },
    logger: {
      warn(message, fields) {
        warnings.push({ message, fields })
      },
    },
  })

  scheduler.enqueue('project-1')
  await scheduler.stop()

  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].message, '团队项目定时拉取失败')
  assert.equal(warnings[0].fields.projectId, 'project-1')
  assert.equal(warnings[0].fields.name, 'TeamError')
  assert.equal(warnings[0].fields.code, ERROR_CODES.GIT_REMOTE_FAILED)
  assert.equal(warnings[0].fields.status, 502)
  assert.equal(warnings[0].fields.message, '同步项目失败')
  assert.equal(warnings[0].fields.error, '同步项目失败')
  assert.deepEqual(warnings[0].fields.details, {
    branch: 'dev',
    token: '[redacted]',
  })
})

test('错误摘要限制长度并始终附带脱敏 code', () => {
  const summary = errorSummary(
    new TeamError(502, ERROR_CODES.GIT_REMOTE_FAILED, `${'x'.repeat(1200)} token=secret`),
    '同步失败',
  )
  assert.match(summary, /^GIT_REMOTE_FAILED: /)
  assert.equal(summary.includes('secret'), false)
  assert.equal(summary.length <= 1000, true)
  assert.match(sanitizeDiagnosticText('Bearer abc.def'), /Bearer \*\*\*/)
})

test('Authorization、Cookie、JWT 和复合 token 键完整脱敏且不误改 code', () => {
  const text = [
    'Authorization: Bearer auth-secret',
    'Proxy-Authorization: Basic proxy-secret',
    'Cookie: session=cookie-secret; theme=dark',
    'Set-Cookie: refresh=set-cookie-secret; HttpOnly',
    'access_token=compound-secret',
    'jwt=eyJhbGciOiJIUzI1NiJ9.payload-signature.signature-value',
    'AUTHORIZATION_REQUIRED TOKEN_EXPIRED COOKIE_INVALID',
  ].join('\n')
  const sanitized = sanitizeDiagnosticText(text)

  for (const secret of [
    'auth-secret',
    'proxy-secret',
    'cookie-secret',
    'set-cookie-secret',
    'compound-secret',
    'payload-signature',
  ]) {
    assert.equal(sanitized.includes(secret), false)
  }
  assert.match(sanitized, /AUTHORIZATION_REQUIRED TOKEN_EXPIRED COOKIE_INVALID/)

  const diagnostic = diagnosticError(
    Object.assign(new Error('Authorization: Bearer top-level-secret'), {
      code: 'AUTHORIZATION_REQUIRED',
      details: { code: 'TOKEN_EXPIRED', access_token: 'nested-secret' },
    }),
  )
  assert.equal(diagnostic.code, 'AUTHORIZATION_REQUIRED')
  assert.deepEqual(diagnostic.details, {
    code: 'TOKEN_EXPIRED',
    access_token: '[redacted]',
  })
  assert.equal(diagnostic.message.includes('top-level-secret'), false)
})

test('递归详情处理循环引用、嵌套路径和绝对路径', () => {
  const details = {
    branch: 'dev',
    nested: {
      authorization: 'Bearer nested-secret',
      sourcePath: 'D:\\wit\\private\\repo',
    },
  }
  details.self = details
  const diagnostic = diagnosticError(
    new TeamError(
      502,
      ERROR_CODES.GIT_REMOTE_FAILED,
      'sync failed:"C:\\Users\\Alice\\My Project\\repo" and:/home/alice/private\nfile:///C:/Users/Alice/File Project/repo',
      { details },
    ),
  )

  assert.equal(diagnostic.message.includes('My Project'), false)
  assert.equal(diagnostic.message.includes('File Project'), false)
  assert.equal(diagnostic.message.includes('alice'), false)
  assert.match(diagnostic.message, /\[redacted-path\]/)
  assert.deepEqual(diagnostic.details.nested, {
    authorization: '[redacted]',
    sourcePath: '[redacted-path]',
  })
  assert.equal(diagnostic.details.self, '[circular]')
})

test('结构化诊断详情受总长度预算约束', () => {
  const diagnostic = diagnosticError(
    new TeamError(502, ERROR_CODES.GIT_REMOTE_FAILED, '同步失败', {
      details: {
        ['x'.repeat(4000)]: '长字段名也必须受预算约束',
        values: Array.from({ length: 50 }, (_, index) => `${index}:${'x'.repeat(2000)}`),
      },
    }),
  )
  const serialized = JSON.stringify(diagnostic)

  assert.match(serialized, /\[truncated\]/)
  assert.equal(serialized.length < 30_000, true)
})
