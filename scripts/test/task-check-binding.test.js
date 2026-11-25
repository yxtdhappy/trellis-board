import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const taskPy = path.join(repoRoot, '.trellis', 'scripts', 'task.py')
const python = process.env.PYTHON || 'python'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function runTask(cwd, args, expectedStatus = 0) {
  const result = spawnSync(python, [taskPy, ...args], { cwd, encoding: 'utf8' })
  assert.equal(
    result.status,
    expectedStatus,
    `task.py ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`,
  )
  return result
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-binding-'))
  git(dir, ['init', '-q'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-qm', 'chore: base'])
  return dir
}

function createTask(dir) {
  runTask(dir, [
    'create',
    'Binding test',
    '--slug',
    'binding-test',
    '--description',
    'check binding smoke test',
    '--work-type',
    'backend',
    '--task-type',
    'complex',
    '--assignee',
    'test',
    '--no-start',
  ])
  const taskDir = path.join(dir, '.trellis', 'tasks', fs.readdirSync(path.join(dir, '.trellis', 'tasks'))[0])
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'feature.js'), 'export const value = 1\n')
  fs.writeFileSync(
    path.join(taskDir, 'check-report.md'),
    '---\nmode: independent\nagent: trellis-check\nsession: ses_test\n---\n\n## Check Complete\n',
  )
  fs.writeFileSync(path.join(taskDir, 'implementation-report.md'), '# Implementation Report\n')
  return taskDir
}

test('stamp-check + set-commit bind the checked tree', () => {
  const dir = makeRepo()
  try {
    const taskDir = createTask(dir)
    runTask(dir, ['stamp-check', taskDir, '--scope', 'src'])
    git(dir, ['add', 'src', '.trellis'])
    git(dir, ['commit', '-qm', 'feat: binding test'])
    const commit = git(dir, ['rev-parse', 'HEAD'])
    runTask(dir, ['set-commit', taskDir, commit, '--persist'])
    const report = fs.readFileSync(path.join(taskDir, 'check-report.md'), 'utf8')
    assert.match(report, /^base: [0-9a-f]{40}$/m)
    assert.match(report, /^scope: src$/m)
    assert.match(report, /^diff: sha256:[0-9a-f]{64}$/m)
    runTask(dir, ['verify', taskDir, '--strict'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('set-commit rejects a commit whose checked tree changed after stamping', () => {
  const dir = makeRepo()
  try {
    const taskDir = createTask(dir)
    runTask(dir, ['stamp-check', taskDir, '--scope', 'src'])
    fs.writeFileSync(path.join(dir, 'src', 'feature.js'), 'export const value = 2\n')
    git(dir, ['add', 'src', '.trellis'])
    git(dir, ['commit', '-qm', 'feat: changed after stamp'])
    const commit = git(dir, ['rev-parse', 'HEAD'])
    const result = runTask(dir, ['set-commit', taskDir, commit], 1)
    assert.match(result.stderr, /checked worktree differs from the commit/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
