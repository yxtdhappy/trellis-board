import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const KIT_DIR = path.join(ROOT_DIR, 'trellis-kit')
const APPLY_PY = path.join(KIT_DIR, 'apply.py')
const PYTHON = process.env.TRELLIS_PYTHON || 'python'

function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function runPython(args, cwd = ROOT_DIR) {
  return execFileSync(PYTHON, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PYTHONUTF8: '1', TRELLIS_CONTEXT_ID: 'test-session' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function runPythonResult(args, cwd = ROOT_DIR) {
  try {
    const stdout = runPython(args, cwd)
    return { status: 0, stdout, stderr: '' }
  } catch (error) {
    return {
      status: error.status ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    }
  }
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function listFiles(root) {
  const files = []
  const walk = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, rel)
      else if (entry.isFile()) files.push(rel)
    }
  }
  walk(root)
  return files.sort()
}

function initTempGitRepo(dir) {
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.name', 'Trellis Test'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  fs.writeFileSync(path.join(dir, 'README.md'), '# test\n', 'utf8')
  git(dir, ['add', 'README.md'])
  git(dir, ['commit', '-m', 'init'])
  fs.cpSync(path.join(ROOT_DIR, '.trellis', 'scripts'), path.join(dir, '.trellis', 'scripts'), {
    recursive: true,
    filter: (src) => !src.includes('__pycache__'),
  })
  runPython([APPLY_PY, '--target', dir, '--force'], ROOT_DIR)
  fs.mkdirSync(path.join(dir, '.trellis', 'tasks'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.trellis', '.developer'), 'name=tester\n', 'utf8')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'chore: init trellis'])
  git(dir, ['checkout', '-b', 'feat/test'])
}

test('skill source and overlay scripts stay byte-identical and dead claude skills removed', () => {
  const repoSkill = path.join(ROOT_DIR, '.agents/skills/trellis-task-state/SKILL.md')
  const overlaySkill = path.join(KIT_DIR, 'overlay/.agents/skills/trellis-task-state/SKILL.md')
  const skillText = fs.readFileSync(repoSkill, 'utf8')

  assert.equal(fs.readFileSync(repoSkill).equals(fs.readFileSync(overlaySkill)), true)
  assert.match(skillText, /--force-degraded/)
  assert.match(skillText, /## Evidence source/)
  assert.equal(fs.existsSync(path.join(KIT_DIR, 'overlay/.claude/skills')), false)

  const manifest = JSON.parse(fs.readFileSync(path.join(KIT_DIR, 'manifest.json'), 'utf8'))
  const dupClaudeSkills = manifest.components.filter(
    (item) => item.platform === 'claude-code' && String(item.target).endsWith('/SKILL.md'),
  )
  assert.equal(dupClaudeSkills.length, 0)

  const openCodePlugins = manifest.components.filter(
    (item) => item.platform === 'opencode' && String(item.target).startsWith('.opencode/plugins/'),
  )
  assert.equal(openCodePlugins.length, 3)
  for (const plugin of openCodePlugins) {
    const source = fs.readFileSync(path.join(KIT_DIR, 'overlay', plugin.source), 'utf8')
    assert.match(source, /export default \{ id: "[^"]+", setup: server \}/)
    assert.match(source, /api\.(session|tool)\.hook\(/)
    assert.doesNotMatch(source, /effect: server/)
    assert.doesNotMatch(source, /MESSAGES_TRANSFORM_HOOK\]:/)
  }

  for (const rel of ['.opencode/lib/session-utils.js', '.opencode/lib/trellis-context.js']) {
    assert.match(
      fs.readFileSync(path.join(KIT_DIR, 'overlay', rel), 'utf8'),
      /windowsHide:\s*true/,
      `${rel} must hide Windows child consoles`,
    )
  }
  for (const rel of [
    '.trellis/scripts/common/git.py',
    '.trellis/scripts/common/session_context.py',
  ]) {
    assert.match(
      fs.readFileSync(path.join(KIT_DIR, 'overlay', rel), 'utf8'),
      /CREATE_NO_WINDOW/,
      `${rel} must hide Windows child consoles`,
    )
  }

  for (const rel of ['.trellis/scripts/task.py', '.trellis/scripts/common/task_store.py']) {
    assert.equal(
      fs
        .readFileSync(path.join(ROOT_DIR, rel))
        .equals(fs.readFileSync(path.join(KIT_DIR, 'overlay', rel))),
      true,
      `${rel} differs from overlay`,
    )
  }

  withTempDir('trellis-kit-skills-', (tmp) => {
    runPython([APPLY_PY, '--target', tmp, '--force', '--platform', 'claude-code'])
    runPython([APPLY_PY, '--target', tmp, '--force', '--platform', 'codex'])
    runPython([APPLY_PY, '--target', tmp, '--force', '--platform', 'opencode'])

    for (const plugin of openCodePlugins) {
      assert.equal(
        fs.readFileSync(path.join(tmp, plugin.target), 'utf8').includes('export default { id:'),
        true,
        `${plugin.target} was not applied`,
      )
    }

    assert.equal(
      fs
        .readFileSync(path.join(tmp, '.claude/skills/trellis-task-state/SKILL.md'))
        .equals(fs.readFileSync(repoSkill)),
      true,
    )
    assert.equal(
      fs
        .readFileSync(path.join(tmp, '.agents/skills/trellis-task-state/SKILL.md'))
        .equals(fs.readFileSync(repoSkill)),
      true,
    )
  })
})

test('state_persist_degraded can be resolved by start --commit-state', () => {
  withTempDir('trellis-degraded-', (repo) => {
    initTempGitRepo(repo)
    const taskPy = path.join(repo, '.trellis/scripts/task.py')
    const created = runPython(
      [
        taskPy,
        'create',
        'Degraded recovery',
        '--slug',
        'degraded-recovery',
        '--description',
        'test recovery',
        '--work-type',
        'backend',
        '--task-type',
        'complex',
        '--base-branch',
        'main',
        '--no-start',
      ],
      repo,
    ).trim()
    const taskPath = path.join(repo, created)
    fs.writeFileSync(path.join(taskPath, 'design.md'), '# Design\n', 'utf8')
    fs.writeFileSync(path.join(taskPath, 'implement.md'), '# Implement\n', 'utf8')

    runPython(
      [taskPy, 'start', created, '--no-commit-state', '--force-degraded', '--reason', 'test'],
      repo,
    )

    const degradedVerify = runPythonResult([taskPy, 'verify', created, '--strict'], repo)
    assert.notEqual(degradedVerify.status, 0)
    assert.match(degradedVerify.stdout, /state_persist_degraded/)
    assert.doesNotMatch(degradedVerify.stdout, /doctor --fix/)

    runPython([taskPy, 'start', created, '--commit-state'], repo)
    assert.equal(
      git(repo, ['status', '--porcelain', '--', `${created}/.state-events.jsonl`]).trim(),
      '',
    )

    fs.writeFileSync(path.join(repo, 'work.txt'), 'done\n', 'utf8')
    git(repo, ['add', 'work.txt'])
    git(repo, ['commit', '-m', 'feat: work'])
    runPython([taskPy, 'set-commit', created, 'HEAD'], repo)

    fs.writeFileSync(path.join(taskPath, 'implementation-report.md'), '# Impl\n', 'utf8')
    fs.writeFileSync(
      path.join(taskPath, 'check-report.md'),
      '---\nmode: independent\nagent: trellis-check\nsession: test\n---\n# Check\n',
      'utf8',
    )
    runPython([taskPy, 'stamp-check', created, '--scope', 'work.txt', '--base', 'HEAD'], repo)
    runPython([taskPy, 'set-commit', created, 'HEAD'], repo)

    const cleanVerify = runPythonResult([taskPy, 'verify', created, '--strict'], repo)
    assert.equal(cleanVerify.status, 0, cleanVerify.stdout + cleanVerify.stderr)

    const archived = runPythonResult([taskPy, 'archive', created, '--no-commit'], repo)
    assert.equal(archived.status, 0, archived.stdout + archived.stderr)
  })
})

test('task_type_pending cannot bypass verify or archive while legacy unlabeled tasks remain allowed', () => {
  withTempDir('trellis-pending-', (repo) => {
    initTempGitRepo(repo)
    const taskPy = path.join(repo, '.trellis/scripts/task.py')

    const pendingDir = runPython(
      [
        taskPy,
        'create',
        'Pending task',
        '--slug',
        'pending-task',
        '--description',
        'missing task_type',
        '--work-type',
        'backend',
        '--base-branch',
        'main',
        '--no-start',
      ],
      repo,
    ).trim()
    runPython([taskPy, 'start', pendingDir], repo)

    const verifyRes = runPythonResult([taskPy, 'verify', pendingDir], repo)
    assert.notEqual(verifyRes.status, 0)
    assert.match(verifyRes.stdout, /task_type_pending/)

    const archivePending = runPythonResult([taskPy, 'archive', pendingDir, '--no-commit'], repo)
    assert.notEqual(archivePending.status, 0)
    assert.match(archivePending.stderr, /task_type_pending/)

    const legacyDir = runPython(
      [
        taskPy,
        'create',
        'Legacy task',
        '--slug',
        'legacy-task',
        '--description',
        'legacy unlabeled',
        '--allow-unlabeled',
        '--base-branch',
        'main',
        '--no-start',
      ],
      repo,
    ).trim()
    runPython([taskPy, 'start', legacyDir], repo)

    const archiveLegacy = runPythonResult([taskPy, 'archive', legacyDir, '--no-commit'], repo)
    assert.equal(archiveLegacy.status, 0, archiveLegacy.stderr)
  })
})

test('apply.py syncs TRELLIS-BOARD workflow rules into AGENTS.md idempotently', () => {
  const snippet = fs
    .readFileSync(path.join(KIT_DIR, 'snippets/agents-workflow-rules.md'), 'utf8')
    .trim()
  const rootAgents = fs.readFileSync(path.join(ROOT_DIR, 'AGENTS.md'), 'utf8')
  assert.equal(rootAgents.includes(snippet), true)

  withTempDir('trellis-agents-md-', (tmp) => {
    const agentsPath = path.join(tmp, 'AGENTS.md')
    fs.writeFileSync(
      agentsPath,
      '<!-- TRELLIS:START -->\n# Trellis Instructions\n<!-- TRELLIS:END -->\n\n# Custom Project Rule\nKeep this.\n',
      'utf8',
    )

    runPython([APPLY_PY, '--target', tmp, '--force'])
    const afterFirst = fs.readFileSync(agentsPath, 'utf8')
    assert.match(afterFirst, /<!-- TRELLIS:START -->[\s\S]*<!-- TRELLIS:END -->/)
    assert.match(afterFirst, /# Custom Project Rule/)
    assert.equal(afterFirst.includes(snippet), true)

    runPython([APPLY_PY, '--target', tmp, '--force'])
    const afterSecond = fs.readFileSync(agentsPath, 'utf8')
    assert.equal(afterSecond, afterFirst)
    assert.equal(afterSecond.split('## Trellis Workflow 优先规则').length - 1, 1)

    fs.writeFileSync(
      agentsPath,
      afterSecond.replace('## Trellis Workflow 优先规则', '## Trellis Workflow 优先规则 (stale)'),
      'utf8',
    )
    const conflict = runPythonResult([APPLY_PY, '--target', tmp])
    assert.notEqual(conflict.status, 0)
    assert.match(conflict.stderr, /conflict:/)

    runPython([APPLY_PY, '--target', tmp, '--force'])
    assert.equal(fs.readFileSync(agentsPath, 'utf8'), afterFirst)
  })

  withTempDir('trellis-agents-create-', (tmp) => {
    runPython([APPLY_PY, '--target', tmp, '--agent-only'])
    assert.equal(fs.existsSync(path.join(tmp, 'AGENTS.md')), false)

    runPython([APPLY_PY, '--target', tmp])
    assert.equal(fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf8').trim(), snippet)
  })
})

test('apply.py records optional features without copying their descriptors', () => {
  withTempDir('trellis-kit-feature-', (target) => {
    const markerPath = path.join(target, '.trellis', '.kit-version')

    runPython([APPLY_PY, '--target', target, '--force'], ROOT_DIR)
    let marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    assert.deepEqual(marker.features, [])
    assert.equal(fs.existsSync(path.join(target, 'features/company-spec/feature.json')), false)

    runPython([APPLY_PY, '--target', target, '--force', '--feature', 'company-spec'], ROOT_DIR)
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    assert.deepEqual(marker.features, ['company-spec'])
    assert.equal(fs.existsSync(path.join(target, 'features/company-spec/feature.json')), false)

    runPython([APPLY_PY, '--target', target, '--force'], ROOT_DIR)
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    assert.deepEqual(marker.features, ['company-spec'])

    const unknown = runPythonResult(
      [APPLY_PY, '--target', target, '--force', '--feature', 'unknown'],
      ROOT_DIR,
    )
    assert.notEqual(unknown.status, 0)
    assert.match(unknown.stderr, /unknown feature/)

    const agentOnly = runPythonResult(
      [APPLY_PY, '--target', target, '--force', '--agent-only', '--feature', 'company-spec'],
      ROOT_DIR,
    )
    assert.notEqual(agentOnly.status, 0)
    assert.match(agentOnly.stderr, /--agent-only/)
  })
})

test('every manifest component matches the self-contained overlay', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(KIT_DIR, 'manifest.json'), 'utf8'))
  for (const component of manifest.components) {
    if (!component.source) continue
    const source = path.join(ROOT_DIR, component.source)
    const overlay = path.join(KIT_DIR, 'overlay', component.source)
    if (!fs.existsSync(source)) {
      // 平台源文件可能位于被 gitignore 的目录（如 .claude/），CI 只检出 overlay。
      assert.equal(
        fs.existsSync(overlay),
        true,
        `missing overlay for ${component.id}: ${component.source}`,
      )
      continue
    }
    if (component.directory) {
      assert.equal(
        fs.existsSync(overlay),
        true,
        `missing overlay directory for ${component.id}: ${component.source}`,
      )
      const sourceFiles = listFiles(source)
      const overlayFiles = listFiles(overlay)
      assert.deepEqual(overlayFiles, sourceFiles, `${component.id} overlay file list differs`)
      for (const rel of sourceFiles) {
        assert.equal(
          fs.readFileSync(path.join(source, rel)).equals(fs.readFileSync(path.join(overlay, rel))),
          true,
          `${component.id} overlay differs: ${rel}`,
        )
      }
    } else {
      assert.equal(
        fs.existsSync(overlay),
        true,
        `missing overlay file for ${component.id}: ${component.source}`,
      )
      assert.equal(
        fs.readFileSync(source).equals(fs.readFileSync(overlay)),
        true,
        `${component.id} overlay differs: ${component.source}`,
      )
    }
  }
})

test('portable package stays single-file and build.rs embeds trellis-kit', (t) => {
  if (process.platform !== 'win32') {
    t.skip('portable packaging is Windows-only')
    return
  }

  const pwsh = process.env.TRELLIS_PWSH || 'pwsh'
  try {
    execFileSync(pwsh, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    t.skip('pwsh is not available')
    return
  }

  withTempDir('trellis-portable-', (sandbox) => {
    const release = path.join(sandbox, 'release')
    const output = path.join(release, 'bundle', 'portable')
    fs.mkdirSync(release, { recursive: true })
    fs.writeFileSync(path.join(release, 'trellis-board-client.exe'), 'fake executable')

    execFileSync(
      pwsh,
      [
        '-NoProfile',
        '-File',
        path.join(ROOT_DIR, 'packages/desktop/package-portable.ps1'),
        '-ReleaseDirectory',
        release,
        '-OutputDirectory',
        output,
      ],
      { cwd: ROOT_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )

    const packageDir = fs
      .readdirSync(output)
      .find(
        (name) =>
          name.startsWith('TrellisBoard_') && fs.statSync(path.join(output, name)).isDirectory(),
      )
    assert.ok(packageDir, 'portable package directory missing')

    for (const relative of [
      'trellis-board-client.exe',
      'VERSION.txt',
      'SHA256SUMS.txt',
      '使用说明.txt',
    ]) {
      assert.equal(
        fs.existsSync(path.join(output, packageDir, relative)),
        true,
        `portable package is missing ${relative}`,
      )
    }
    assert.equal(
      fs.existsSync(path.join(output, packageDir, 'trellis-kit')),
      false,
      'portable package must not ship trellis-kit as a sibling directory',
    )

    const buildSource = fs.readFileSync(
      path.join(ROOT_DIR, 'packages/desktop/src-tauri/build.rs'),
      'utf8',
    )
    assert.match(buildSource, /trellis-kit/)
    assert.match(buildSource, /embedded_kit_assets/)
    assert.equal(
      fs.existsSync(path.join(ROOT_DIR, 'packages/desktop/src-tauri/src/kit_assets.rs')),
      true,
    )
  })
})
