import test from 'node:test'
import assert from 'node:assert/strict'
import {
  appOriginWithBase,
  normalizeBasePath,
  readBasePath,
  stripBasePath,
  withBasePath,
} from '../src/lib/base-path.js'
import { safeReturnTo } from '../src/lib/safe-return-to.js'

test('normalizeBasePath 规范化并拦截非法路径', () => {
  assert.equal(normalizeBasePath(undefined), '')
  assert.equal(normalizeBasePath(''), '')
  assert.equal(normalizeBasePath('/'), '')
  assert.equal(normalizeBasePath('weint-spec-board/'), '/weint-spec-board')
  assert.equal(normalizeBasePath('/weint-spec-board/nested/'), '/weint-spec-board/nested')
  assert.equal(normalizeBasePath('/a//b'), '')
  assert.equal(normalizeBasePath('/../evil'), '')
  assert.equal(normalizeBasePath('/bad?query'), '')
})

test('readBasePath 从 meta 标签读取并归一化子路径', () => {
  assert.equal(readBasePath(null), '')
  assert.equal(
    readBasePath({
      querySelector(selector) {
        assert.equal(selector, 'meta[name="trellis-base-path"]')
        return { getAttribute: () => '/weint-spec-board/' }
      },
    }),
    '/weint-spec-board',
  )
})

test('withBasePath 与 stripBasePath 保持边界与幂等性', () => {
  const base = '/weint-spec-board'
  assert.equal(withBasePath('/', ''), '/')
  assert.equal(withBasePath('/', base), '/weint-spec-board/')
  assert.equal(withBasePath('/api/runtime', base), '/weint-spec-board/api/runtime')
  assert.equal(
    withBasePath('/login.html?returnTo=%2F', base),
    '/weint-spec-board/login.html?returnTo=%2F',
  )
  assert.equal(withBasePath('/weint-spec-board/api/runtime', base), '/weint-spec-board/api/runtime')
  assert.equal(withBasePath('/weint-spec-board', base), '/weint-spec-board')
  assert.equal(withBasePath('/weint-spec-board?x=1', base), '/weint-spec-board?x=1')
  assert.equal(
    withBasePath('/weint-spec-board-other', base),
    '/weint-spec-board/weint-spec-board-other',
  )
  assert.equal(withBasePath('https://example.com/a', base), 'https://example.com/a')
  assert.equal(withBasePath('//example.com/a', base), '//example.com/a')

  assert.equal(stripBasePath('/weint-spec-board', base), '/')
  assert.equal(stripBasePath('/weint-spec-board/login.html', base), '/login.html')
  assert.equal(
    stripBasePath('/weint-spec-board-other/login.html', base),
    '/weint-spec-board-other/login.html',
  )
  assert.equal(
    appOriginWithBase({ origin: 'http://spec-board.weintdata.cn' }, base),
    'http://spec-board.weintdata.cn/weint-spec-board',
  )
  assert.equal(appOriginWithBase({ origin: 'http://127.0.0.1:4317' }, ''), 'http://127.0.0.1:4317')
})

test('safeReturnTo 在子路径模式下限制回跳作用域', () => {
  const base = '/weint-spec-board'
  assert.equal(
    safeReturnTo('/weint-spec-board/admin.html?tab=users#top', undefined, base),
    '/weint-spec-board/admin.html?tab=users#top',
  )
  assert.equal(safeReturnTo('/weint-spec-board', undefined, base), '/weint-spec-board')
  assert.equal(safeReturnTo('/admin.html', undefined, base), '/weint-spec-board/')
  assert.equal(
    safeReturnTo('/weint-spec-board-other/admin.html', undefined, base),
    '/weint-spec-board/',
  )
  assert.equal(
    safeReturnTo('/weint-spec-board/login.html?next=1', undefined, base),
    '/weint-spec-board/',
  )
  assert.equal(safeReturnTo('/weint-spec-board/login', undefined, base), '/weint-spec-board/')
  assert.equal(safeReturnTo('//evil.example.com', undefined, base), '/weint-spec-board/')
  assert.equal(safeReturnTo('https://evil.example.com', undefined, base), '/weint-spec-board/')
})
