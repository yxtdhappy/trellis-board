import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginsDir = fileURLToPath(new URL('../plugins/', import.meta.url))
const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

function manifests() {
  return fs
    .readdirSync(pluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .filter((entry) => {
      const tracked = spawnSync('git', ['ls-files', '--', `plugins/${entry.name}`], {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: false,
      })
      return tracked.status === 0 && tracked.stdout.trim()
    })
    .map((entry) => {
      const manifestPath = path.join(pluginsDir, entry.name, 'plugin.json')
      assert.ok(fs.existsSync(manifestPath), `${entry.name} 缺少 plugin.json`)
      return { dir: entry.name, manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) }
    })
}

test('plugins 目录遵循统一命名与清单约定', () => {
  const entries = manifests()
  const ids = new Set()
  const names = new Set()
  for (const { dir, manifest } of entries) {
    assert.equal(manifest.id, dir, `${dir} 的 id 必须与目录名一致`)
    assert.match(manifest.id, ID_PATTERN, `${dir} 的 id 必须是 kebab-case`)
    assert.ok(manifest.name?.trim(), `${dir} 缺少展示名称`)
    assert.notEqual(manifest.name, manifest.id, `${dir} 的展示名称不能与 id 相同`)
    assert.ok(manifest.description?.trim(), `${dir} 缺少 description`)
    assert.match(manifest.version, VERSION_PATTERN, `${dir} 的 version 必须是 semver`)
    assert.equal(manifest.apiVersion, 1, `${dir} 的 apiVersion 必须是 1`)
    assert.ok(manifest.engines?.board, `${dir} 缺少 engines.board`)
    assert.ok(Array.isArray(manifest.permissions), `${dir} 缺少 permissions`)
    assert.ok(!ids.has(manifest.id), `插件 id 重复: ${manifest.id}`)
    assert.ok(!names.has(manifest.name), `插件展示名称重复: ${manifest.name}`)
    ids.add(manifest.id)
    names.add(manifest.name)
  }
})
