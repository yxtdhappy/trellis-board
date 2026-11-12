import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { initializeTrellis } from '../desktop/sidecar/trellis-runtime.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME = {
  root: path.join(ROOT, 'trellis-runtime'),
  nodeFile: process.execPath,
  cliFile: path.join(ROOT, 'node_modules', '@mindfoldhq', 'trellis', 'bin', 'trellis.js'),
}

function failed(stdout, stderr) {
  return { exitCode: 1, stdout, stderr }
}

function succeeded(stdout = '') {
  return { exitCode: 0, stdout, stderr: '' }
}

function hasTemporaryFile(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.name.includes('.tmp')) return true
    if (entry.isDirectory() && hasTemporaryFile(target)) return true
  }
  return false
}

test('Pi 补齐脚本创建全部缺失文件、保留已有内容且不留临时文件', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-pi-repair-'))
  try {
    const existing = path.join(repo, '.agents', 'skills', 'trellis-before-dev', 'SKILL.md')
    fs.mkdirSync(path.dirname(existing), { recursive: true })
    fs.writeFileSync(existing, '用户已有内容\n')
    const existingPiAgent = path.join(repo, '.pi', 'agents', 'trellis-implement.md')
    fs.mkdirSync(path.dirname(existingPiAgent), { recursive: true })
    fs.writeFileSync(existingPiAgent, '用户已有 Pi agent\n')
    fs.mkdirSync(path.join(repo, '.pi', 'extensions', 'trellis'), { recursive: true })

    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, 'desktop', 'sidecar', 'trellis-pi-repair.mjs'), ROOT, repo],
      { cwd: ROOT, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout.trim()), { created: 49, skipped: 2 })
    assert.equal(fs.readFileSync(existing, 'utf8'), '用户已有内容\n')
    assert.equal(fs.readFileSync(existingPiAgent, 'utf8'), '用户已有 Pi agent\n')
    assert.ok(fs.statSync(path.join(repo, '.pi', 'extensions', 'trellis', 'index.ts')).size > 0)
    assert.ok(fs.statSync(path.join(repo, '.pi', 'settings.json')).size > 0)
    assert.equal(hasTemporaryFile(repo), false)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('Pi 初始化仅在 EXDEV 扩展写入失败时补齐并原样重试一次', async () => {
  const calls = []
  const processRunner = async (command, args, options) => {
    calls.push({ command, args: args.slice(), options })
    if (calls.length === 1) {
      return failed(
        '',
        'EXDEV: cross-device link not permitted, rename .pi\\extensions\\trellis\\.index.ts.1.tmp',
      )
    }
    if (calls.length === 2) return succeeded('{"created":2,"skipped":49}\n')
    return succeeded('initialized\n')
  }

  const result = await initializeTrellis({
    repoPath: path.join(ROOT, 'sample-repo'),
    developerId: 'alice',
    agentTools: ['codex', 'pi'],
    runtime: RUNTIME,
    processRunner,
  })

  assert.equal(result.initialized, true)
  assert.equal(result.stdout, 'initialized\n')
  assert.equal(calls.length, 3)
  assert.deepEqual(calls[1].args, [
    path.join(RUNTIME.root, 'trellis-pi-repair.mjs'),
    RUNTIME.root,
    path.join(ROOT, 'sample-repo'),
  ])
  assert.deepEqual(calls[2].args, calls[0].args)
  assert.equal(calls[2].command, RUNTIME.nodeFile)
})

test('非 Pi 的初始化错误不触发补齐或重试', async () => {
  const cases = [
    { agentTools: ['codex'], stderr: 'EXDEV: rename .pi/extensions/trellis/.index.ts.1.tmp' },
    { agentTools: ['pi'], stderr: 'ENOSPC: no space left on device' },
  ]
  for (const item of cases) {
    const calls = []
    const processRunner = async (command, args) => {
      calls.push({ command, args })
      return failed('', item.stderr)
    }

    await assert.rejects(
      () =>
        initializeTrellis({
          repoPath: path.join(ROOT, 'sample-repo'),
          developerId: 'alice',
          agentTools: item.agentTools,
          runtime: RUNTIME,
          processRunner,
        }),
      /Trellis 初始化失败/,
    )
    assert.equal(calls.length, 1)
  }
})

test('Pi 补齐失败后不重试初始化', async () => {
  const calls = []
  const processRunner = async () => {
    calls.push(calls.length + 1)
    if (calls.length === 1) {
      return failed('', 'EXDEV: rename .pi/extensions/trellis/.index.ts.1.tmp failed')
    }
    return failed('', '文件系统拒绝直写')
  }

  await assert.rejects(
    () =>
      initializeTrellis({
        repoPath: path.join(ROOT, 'sample-repo'),
        developerId: 'alice',
        agentTools: ['pi'],
        runtime: RUNTIME,
        processRunner,
      }),
    /Pi 模板补齐失败/,
  )
  assert.equal(calls.length, 2)
})

test('Pi 补齐后重试失败会明确报错且不再尝试第三次', async () => {
  const calls = []
  const processRunner = async () => {
    calls.push(calls.length + 1)
    if (calls.length === 1) {
      return failed('', 'EXDEV: rename .pi/extensions/trellis/.index.ts.1.tmp')
    }
    if (calls.length === 2) return succeeded()
    return failed('', '重试仍失败')
  }

  await assert.rejects(
    () =>
      initializeTrellis({
        repoPath: path.join(ROOT, 'sample-repo'),
        developerId: 'alice',
        agentTools: ['pi'],
        runtime: RUNTIME,
        processRunner,
      }),
    /Pi 模板补齐后 Trellis 初始化重试失败/,
  )
  assert.equal(calls.length, 3)
})
