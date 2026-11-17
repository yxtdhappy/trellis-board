import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseSemver,
  compareSemver,
  satisfiesRange,
  validateManifest,
  manifestFailureMessage,
} from '../plugins/version.js'
import { HOST_API_VERSION } from '../plugins/protocol.js'

const baseManifest = {
  id: 'echo',
  name: 'echo',
  version: '1.0.0',
  apiVersion: HOST_API_VERSION,
  engines: { board: '>=0.1.0' },
  permissions: ['store'],
  http: { rootPaths: [] },
}

test('parseSemver 接受 x.y.z 与预发布标记', () => {
  assert.deepEqual(parseSemver('1.2.3'), {
    major: 1,
    minor: 2,
    patch: 3,
    prerelease: [],
  })
  assert.deepEqual(parseSemver('1.2.3-alpha.1')?.prerelease, ['alpha', '1'])
  assert.equal(parseSemver('1.2'), null)
  assert.equal(parseSemver('v1.2.3'), null)
  assert.equal(parseSemver(undefined), null)
})

test('compareSemver 遵循 semver 优先级', () => {
  assert.ok(compareSemver('1.0.0', '1.0.1') < 0)
  assert.ok(compareSemver('1.0.0-alpha', '1.0.0') < 0)
  assert.ok(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10') < 0)
  assert.equal(compareSemver('2.0.0', '2.0.0'), 0)
})

test('satisfiesRange 覆盖 >=、<=、^、~、精确与 *', () => {
  assert.equal(satisfiesRange('>=0.2.0', '0.1.0').reason, 'board-too-old')
  assert.equal(satisfiesRange('<=1.0.0', '1.1.0').reason, 'board-too-new')
  assert.equal(satisfiesRange('^0.2.0', '0.3.0').reason, 'board-too-new')
  assert.equal(satisfiesRange('^0.2.0', '0.2.5').ok, true)
  assert.equal(satisfiesRange('~1.2.3', '1.2.9').ok, true)
  assert.equal(satisfiesRange('1.2.3', '1.2.4').reason, 'board-too-new')
  assert.equal(satisfiesRange('*', '9.9.9').ok, true)
  assert.equal(satisfiesRange('>=0.1.0 <1.0.0', '1.1.0').reason, 'board-too-new')
})

test('satisfiesRange 拒绝 || 与连字符区间', () => {
  assert.equal(satisfiesRange('1.0.0 || 2.0.0', '1.0.0').reason, 'invalid-manifest')
  assert.equal(satisfiesRange('1.0.0 - 2.0.0', '1.5.0').reason, 'invalid-manifest')
})

test('validateManifest 接受合法清单并补齐默认值', () => {
  const result = validateManifest(baseManifest, {
    configId: 'echo',
    hostVersion: '0.1.0',
    hostApiVersion: HOST_API_VERSION,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.manifest.permissions, ['store'])
  assert.deepEqual(result.manifest.http.rootPaths, [])
})

test('validateManifest 按顺序返回失败标记', () => {
  const options = {
    configId: 'echo',
    hostVersion: '0.1.0',
    hostApiVersion: HOST_API_VERSION,
  }
  assert.equal(validateManifest(null, options).reason, 'invalid-manifest')
  assert.equal(validateManifest({ ...baseManifest, id: '' }, options).reason, 'invalid-manifest')
  assert.equal(validateManifest({ ...baseManifest, id: 'other' }, options).reason, 'id-mismatch')
  assert.equal(
    validateManifest({ ...baseManifest, version: '1.0' }, options).reason,
    'invalid-version',
  )
  assert.equal(validateManifest({ ...baseManifest, apiVersion: 2 }, options).reason, '1006')
  assert.equal(
    validateManifest({ ...baseManifest, engines: { board: '>=9.0.0' } }, options).reason,
    'board-too-old',
  )
  assert.equal(
    validateManifest({ ...baseManifest, engines: { board: '<=0.0.9' } }, options).reason,
    'board-too-new',
  )
  assert.equal(
    validateManifest(baseManifest, { ...options, pinnedVersion: '1.0.1' }).reason,
    'pinned-mismatch',
  )
})

test('validateManifest 拒绝通配根路径与非法 permissions', () => {
  const options = {
    configId: 'echo',
    hostVersion: '0.1.0',
    hostApiVersion: HOST_API_VERSION,
  }
  assert.equal(
    validateManifest({ ...baseManifest, http: { rootPaths: ['/a/*'] } }, options).reason,
    'invalid-manifest',
  )
  assert.equal(
    validateManifest({ ...baseManifest, permissions: [1] }, options).reason,
    'invalid-manifest',
  )
})

test('manifestFailureMessage 生成可读原因', () => {
  const message = manifestFailureMessage('board-too-old', {
    manifest: baseManifest,
    hostVersion: '0.1.0',
  })
  assert.match(message, /1\.0\.0/)
  assert.match(message, /0\.1\.0/)
})
