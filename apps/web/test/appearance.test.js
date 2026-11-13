import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_THEME,
  fontPixels,
  normalizeFontSize,
  normalizeTheme,
  resolveTheme,
} from '../src/lib/appearance.js'

test('非法或缺失的主题偏好回落到跟随系统', () => {
  assert.equal(normalizeTheme(undefined), DEFAULT_THEME)
  assert.equal(normalizeTheme(null), DEFAULT_THEME)
  assert.equal(normalizeTheme('sepia'), DEFAULT_THEME)
  assert.equal(normalizeTheme('light'), 'light')
  assert.equal(normalizeTheme('dark'), 'dark')
  assert.equal(normalizeTheme('system'), 'system')
})

test('非法或缺失的字号偏好回落到标准档', () => {
  assert.equal(normalizeFontSize(undefined), DEFAULT_FONT_SIZE)
  assert.equal(normalizeFontSize('huge'), DEFAULT_FONT_SIZE)
  assert.equal(normalizeFontSize('sm'), 'sm')
  assert.equal(normalizeFontSize('xl'), 'xl')
})

test('跟随系统时按系统偏好解析，显式偏好忽略系统值', () => {
  assert.equal(resolveTheme('system', true), 'dark')
  assert.equal(resolveTheme('system', false), 'light')
  assert.equal(resolveTheme('light', true), 'light')
  assert.equal(resolveTheme('dark', false), 'dark')
  assert.equal(resolveTheme('bogus', true), 'dark')
})

test('字号档位映射到根字号像素，非法值用标准档', () => {
  assert.deepEqual(
    ['sm', 'md', 'lg', 'xl'].map((size) => fontPixels(size)),
    [14, 16, 18, 20],
  )
  assert.equal(fontPixels('bogus'), 16)
})
