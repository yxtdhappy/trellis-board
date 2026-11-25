import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_APP_NAME, readAppNameFromMeta, resolveAppName } from '../src/lib/app-name.js'

test('readAppNameFromMeta 从 meta 标签读取并去空白', () => {
  assert.equal(DEFAULT_APP_NAME, '')
  assert.equal(readAppNameFromMeta(null), '')
  assert.equal(
    readAppNameFromMeta({
      querySelector(selector) {
        assert.equal(selector, 'meta[name="trellis-app-name"]')
        return { getAttribute: () => '  Custom Board  ' }
      },
    }),
    'Custom Board',
  )
})

test('resolveAppName 遵循服务端 runtime > meta > 客户端回退优先级且无硬编码品牌', () => {
  assert.equal(
    resolveAppName({
      runtimeAppName: 'Runtime Board',
      metaAppName: 'Meta Board',
      clientAppName: 'Client Board',
    }),
    'Runtime Board',
  )
  assert.equal(
    resolveAppName({
      runtimeAppName: '   ',
      metaAppName: 'Meta Board',
      clientAppName: 'Client Board',
    }),
    'Meta Board',
  )
  assert.equal(
    resolveAppName({
      runtimeAppName: null,
      metaAppName: '',
      clientAppName: 'Client Board',
    }),
    'Client Board',
  )
  assert.equal(resolveAppName({}), '')
})
