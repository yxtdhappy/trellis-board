import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadProjectEnv } from '../env-file.js'

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-env-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('把文件中的键注入给定对象', (t) => {
  const dir = makeTempDir(t)
  fs.writeFileSync(path.join(dir, '.env'), 'A=1\n')
  const env = {}
  const result = loadProjectEnv({ directory: dir, env })
  assert.equal(env.A, '1')
  assert.equal(result.loaded, true)
  assert.equal(result.file, path.join(dir, '.env'))
})

test('已存在的键不被文件覆盖', (t) => {
  const dir = makeTempDir(t)
  fs.writeFileSync(path.join(dir, '.env'), 'PORT=1111\n')
  const env = { PORT: '9999' }
  loadProjectEnv({ directory: dir, env })
  assert.equal(env.PORT, '9999')
})

test('文件缺失时静默返回且不写值', (t) => {
  const dir = makeTempDir(t)
  const env = {}
  const result = loadProjectEnv({ directory: dir, env })
  assert.deepEqual(env, {})
  assert.equal(result.loaded, false)
  assert.equal(result.file, path.join(dir, '.env'))
})

test('支持注释、export 前缀与多行双引号值', (t) => {
  const dir = makeTempDir(t)
  fs.writeFileSync(
    path.join(dir, '.env'),
    ['# 注释不生效', 'export B="x y"', "C='z'", 'MULTI="line1', 'line2"'].join('\n') + '\n',
  )
  const env = {}
  loadProjectEnv({ directory: dir, env })
  assert.equal(env.B, 'x y')
  assert.equal(env.C, 'z')
  assert.equal(env.MULTI, 'line1\nline2')
  assert.equal(env['# 注释不生效'], undefined)
})

test('显式 file 参数覆盖默认路径', (t) => {
  const dir = makeTempDir(t)
  const file = path.join(dir, 'custom.env')
  fs.writeFileSync(file, 'D=4\n')
  const env = {}
  const result = loadProjectEnv({ file, env })
  assert.equal(env.D, '4')
  assert.equal(result.file, file)
})

test('默认路径固定在仓库根，与 cwd 无关', () => {
  const repoRoot = path.resolve(import.meta.dirname, '../../..')
  const result = loadProjectEnv({ env: {} })
  assert.equal(result.file, path.join(repoRoot, '.env'))
})

test('非 ENOENT 读取错误抛出可定位的中文错误', (t) => {
  const dir = makeTempDir(t)
  const envPath = path.join(dir, '.env')
  fs.mkdirSync(envPath)
  assert.throws(
    () => loadProjectEnv({ directory: dir, env: {} }),
    (error) => error.message.startsWith('读取 .env 失败：') && error.message.includes(envPath),
  )
})
