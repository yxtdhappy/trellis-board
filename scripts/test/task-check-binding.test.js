import assert from 'node:assert/strict'
import crypto from 'node:crypto'
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

function createTask(dir, workType = 'backend', withCheckReport = true) {
  runTask(dir, [
    'create',
    'Binding test',
    '--slug',
    'binding-test',
    '--description',
    'check binding smoke test',
    '--work-type',
    workType,
    '--task-type',
    'complex',
    '--assignee',
    'test',
    '--no-start',
  ])
  const taskDir = path.join(
    dir,
    '.trellis',
    'tasks',
    fs.readdirSync(path.join(dir, '.trellis', 'tasks'))[0],
  )
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'feature.js'), 'export const value = 1\n')
  if (withCheckReport) {
    fs.writeFileSync(
      path.join(taskDir, 'check-report.md'),
      '---\nmode: independent\nagent: trellis-check\nsession: ses_test\n---\n\n## Check Complete\n',
    )
  }
  fs.writeFileSync(path.join(taskDir, 'implementation-report.md'), '# Implementation Report\n')
  return taskDir
}

function commitWork(dir, message = 'feat: binding test') {
  git(dir, ['add', 'src', '.trellis'])
  git(dir, ['commit', '-qm', message])
  return git(dir, ['rev-parse', 'HEAD'])
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
    const commit = commitWork(dir, 'feat: changed after stamp')
    const result = runTask(dir, ['set-commit', taskDir, commit], 1)
    assert.match(result.stderr, /checked worktree differs from the commit/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a hand-written commit in a check report cannot bypass stamping', () => {
  const dir = makeRepo()
  try {
    const taskDir = createTask(dir)
    const base = git(dir, ['rev-parse', 'HEAD'])
    fs.writeFileSync(
      path.join(taskDir, 'check-report.md'),
      `---\nmode: independent\nagent: trellis-check\nsession: ses_test\ncommit: ${base}\n---\n\n## Check Complete\n`,
    )
    const commit = commitWork(dir, 'feat: manual commit bypass')
    const setResult = runTask(dir, ['set-commit', taskDir, commit], 1)
    assert.match(setResult.stderr, /is not stamped/)
    const verifyResult = runTask(dir, ['verify', taskDir, '--strict'], 1)
    assert.match(verifyResult.stdout + verifyResult.stderr, /check_report_unbound/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('stale frontend evidence cannot close the check gate', () => {
  const dir = makeRepo()
  try {
    const taskDir = createTask(dir, 'frontend', false)
    const base = git(dir, ['rev-parse', 'HEAD'])
    const commit = commitWork(dir, 'feat: frontend work')
    runTask(dir, ['set-commit', taskDir, commit])
    runTask(dir, [
      'set-evidence',
      taskDir,
      '--type',
      'visual',
      '--artifact',
      'screenshot.png',
      '--commit',
      base,
      '--confirmed-by',
      'owner',
    ])
    const stale = runTask(dir, ['verify', taskDir, '--strict'], 4)
    assert.match(stale.stdout + stale.stderr, /frontend_evidence_missing/)

    runTask(dir, [
      'set-evidence',
      taskDir,
      '--type',
      'visual',
      '--artifact',
      'screenshot.png',
      '--commit',
      commit,
      '--confirmed-by',
      'owner',
    ])
    runTask(dir, ['verify', taskDir, '--strict'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('check override created before commit is bound when set-commit lands', () => {
  const dir = makeRepo()
  try {
    const taskDir = createTask(dir, 'backend', false)
    runTask(dir, ['set-check-override', taskDir, '--by', 'owner', '--reason', 'accepted'])
    const commit = commitWork(dir, 'feat: override work')
    runTask(dir, ['set-commit', taskDir, commit])
    const data = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8'))
    assert.equal(data.meta.check_override.commit, commit)
    runTask(dir, ['verify', taskDir, '--strict'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('verify returns exit 4 and authorize-no-evidence records an override', () => {
  const dir = makeRepo()
  try {
    const taskDir = createTask(dir, 'backend', false)
    const commit = commitWork(dir, 'feat: decision work')
    runTask(dir, ['set-commit', taskDir, commit])
    const decision = runTask(dir, ['verify', taskDir, '--strict'], 4)
    assert.match(decision.stdout + decision.stderr, /check_evidence_missing/)
    runTask(dir, [
      'verify',
      taskDir,
      '--strict',
      '--authorize-no-evidence',
      '--by',
      'owner',
      '--reason',
      'accepted',
    ])
    const data = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8'))
    assert.equal(data.meta.check_override.commit, commit)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('line-ending changes after binding keep the check report valid', () => {
  const dir = makeRepo()
  try {
    const taskDir = createTask(dir)
    runTask(dir, ['stamp-check', taskDir, '--scope', 'src'])
    const reportPath = path.join(taskDir, 'check-report.md')
    const stamped = fs.readFileSync(reportPath, 'utf8')
    assert.equal(fs.readFileSync(reportPath).includes('\r\n'), false)
    fs.writeFileSync(reportPath, stamped.replace(/\n/g, '\r\n'))
    const commit = commitWork(dir, 'feat: crlf binding')
    runTask(dir, ['set-commit', taskDir, commit])
    fs.writeFileSync(reportPath, stamped)
    runTask(dir, ['verify', taskDir, '--strict'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('content changes after binding are still rejected', () => {
  const dir = makeRepo()
  try {
    const taskDir = createTask(dir)
    runTask(dir, ['stamp-check', taskDir, '--scope', 'src'])
    const reportPath = path.join(taskDir, 'check-report.md')
    const stamped = fs.readFileSync(reportPath, 'utf8')
    fs.writeFileSync(reportPath, stamped.replace(/\n/g, '\r\n'))
    const commit = commitWork(dir, 'feat: crlf content change')
    runTask(dir, ['set-commit', taskDir, commit])
    fs.writeFileSync(reportPath, stamped.replace('## Check Complete', '## Check Changed'))
    const result = runTask(dir, ['verify', taskDir, '--strict'], 1)
    assert.match(result.stdout + result.stderr, /check_report_changed_after_binding/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('legacy raw-byte bindings remain valid for unchanged reports', () => {
  const dir = makeRepo()
  try {
    const taskDir = createTask(dir)
    runTask(dir, ['stamp-check', taskDir, '--scope', 'src'])
    const reportPath = path.join(taskDir, 'check-report.md')
    const stamped = fs.readFileSync(reportPath, 'utf8')
    fs.writeFileSync(reportPath, stamped.replace(/\n/g, '\r\n'))
    const commit = commitWork(dir, 'feat: legacy binding')
    runTask(dir, ['set-commit', taskDir, commit])
    const taskJsonPath = path.join(taskDir, 'task.json')
    const data = JSON.parse(fs.readFileSync(taskJsonPath, 'utf8'))
    data.meta.check_binding.report_sha256 = crypto
      .createHash('sha256')
      .update(fs.readFileSync(reportPath))
      .digest('hex')
    fs.writeFileSync(taskJsonPath, `${JSON.stringify(data, null, 2)}\n`)
    runTask(dir, ['verify', taskDir, '--strict'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('BOM and CR-only reports hash the same as canonical LF', () => {
  const dir = makeRepo()
  try {
    const taskDir = createTask(dir)
    runTask(dir, ['stamp-check', taskDir, '--scope', 'src'])
    const reportPath = path.join(taskDir, 'check-report.md')
    const stamped = fs.readFileSync(reportPath, 'utf8')
    const commit = commitWork(dir, 'feat: bom and cr binding')
    runTask(dir, ['set-commit', taskDir, commit])
    fs.writeFileSync(
      reportPath,
      `${String.fromCharCode(0xfeff)}${stamped.replaceAll(String.fromCharCode(10), String.fromCharCode(13, 10))}`,
    )
    runTask(dir, ['verify', taskDir, '--strict'])
    fs.writeFileSync(reportPath, stamped.replace(/\n/g, '\r'))
    runTask(dir, ['verify', taskDir, '--strict'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
