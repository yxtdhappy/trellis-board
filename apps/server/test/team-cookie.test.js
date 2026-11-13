import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SESSION_COOKIE,
  clearSessionCookie,
  parseCookieHeader,
  sessionCookie,
} from '../team/auth.js'

function parseSetCookie(header) {
  return new Map(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=')
        return index < 0 ? [part, ''] : [part.slice(0, index), part.slice(index + 1)]
      }),
  )
}

test('Cookie 头解析为 Map 并解码百分号编码', () => {
  const cookies = parseCookieHeader(`${SESSION_COOKIE}=abc; theme=dark; name=%E4%B8%AD%E6%96%87`)
  assert.equal(cookies instanceof Map, true)
  assert.equal(cookies.get(SESSION_COOKIE), 'abc')
  assert.equal(cookies.get('theme'), 'dark')
  assert.equal(cookies.get('name'), '中文')
})

test('重名 Cookie 取首个，空值保留，空头得到空 Map', () => {
  const cookies = parseCookieHeader('a=1; a=2; empty=')
  assert.equal(cookies.get('a'), '1')
  assert.equal(cookies.get('empty'), '')
  assert.equal(parseCookieHeader('').size, 0)
  assert.equal(parseCookieHeader(undefined).size, 0)
})

test('非法百分号序列保留原值', () => {
  const cookies = parseCookieHeader('bad=%ZZ; good=ok')
  assert.equal(cookies.get('bad'), '%ZZ')
  assert.equal(cookies.get('good'), 'ok')
})

test('会话 Cookie 带 HttpOnly、SameSite=Strict 与 Path=/', () => {
  const attributes = parseSetCookie(sessionCookie('token-value', { cookieSecure: false }))
  assert.equal(attributes.get(SESSION_COOKIE), 'token-value')
  assert.equal(attributes.has('HttpOnly'), true)
  assert.equal(attributes.get('SameSite'), 'Strict')
  assert.equal(attributes.get('Path'), '/')
  assert.equal(attributes.has('Secure'), false)
  assert.equal(attributes.has('Max-Age'), false)
})

test('HTTPS 请求的会话 Cookie 追加 Secure', () => {
  assert.equal(parseSetCookie(sessionCookie('t', { cookieSecure: true })).has('Secure'), true)
})

test('清除会话的 Cookie 带 Max-Age=0 且值为空', () => {
  const attributes = parseSetCookie(clearSessionCookie({ cookieSecure: true }))
  assert.equal(attributes.get(SESSION_COOKIE), '')
  assert.equal(attributes.get('Max-Age'), '0')
  assert.equal(attributes.has('Secure'), true)
  assert.equal(attributes.has('HttpOnly'), true)
})
