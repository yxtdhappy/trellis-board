import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createGitManager, normalizeGitRemote } from '../server/team/git-manager.js'

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-sparse-onboarding-'))
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
}

function addManifestPaths(cwd, agentPaths) {
  const manifestPath = path.join(cwd, '.trellis', '.template-hashes.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  for (const agentPath of agentPaths) manifest.hashes[agentPath] = 'fixture'
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8')
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    env: process.env,
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 失败：${result.stderr || result.stdout}`)
  }
  return result
}

function testConfig() {
  return {
    allowLocalGitRemotes: true,
    publicUrl: new URL('http://127.0.0.1:4317'),
  }
}

function createRemote(root, { withTrellis, agentPaths = [] }) {
  const bare = path.join(root, 'remote.git')
  const seed = path.join(root, 'seed')
  git(root, ['init', '--bare', '--initial-branch=dev', bare])
  fs.mkdirSync(seed)
  git(seed, ['init', '--initial-branch=dev'])
  git(seed, ['config', 'user.name', 'Sparse Test'])
  git(seed, ['config', 'user.email', 'sparse@example.invalid'])
  write(path.join(seed, 'README.md'), '# business source\n')
  write(path.join(seed, 'src', 'index.js'), 'export const hidden = true\n')
  if (withTrellis) {
    write(path.join(seed, '.trellis', 'scripts', 'task.py'), '# task tool\n')
    write(path.join(seed, '.trellis', 'workflow.md'), '# workflow\n')
    write(path.join(seed, '.trellis', 'workspace', 'alice', 'index.md'), '# alice\n')
    write(
      path.join(seed, '.trellis', '.template-hashes.json'),
      JSON.stringify({
        __version: 2,
        hashes: {
          '.trellis/scripts/task.py': 'fixture',
          '.trellis/workflow.md': 'fixture',
          '.trellis/workspace/alice/index.md': 'fixture',
        },
      }),
    )
  }
  for (const agentPath of agentPaths) {
    write(path.join(seed, ...agentPath.split('/')), '# existing agent\n')
  }
  git(seed, ['add', '--', '.'])
  git(seed, ['commit', '-m', 'seed remote'])
  git(seed, ['remote', 'add', 'origin', pathToFileURL(bare).href])
  git(seed, ['push', '-u', 'origin', 'dev'])
  return { bare, seed, remoteUrl: pathToFileURL(bare).href }
}

function manager(root, trellisRunner) {
  return createGitManager({
    db: null,
    config: testConfig(),
    dataDir: path.join(root, 'data'),
    credentialService: null,
    logger: { warn() {}, error() {}, info() {} },
    trellisRunner,
  })
}

function project(remoteUrl) {
  return {
    id: 'project-1',
    workspaceKey: 'workspace-1',
    remoteUrl,
    syncBranch: 'dev',
  }
}

function writeInitializedTrellis(cwd, developerId, agentTools = ['codex']) {
  const files = {
    '.trellis/scripts/task.py': '# task tool\n',
    '.trellis/scripts/common/trellis_config.py': '# config parser\n',
    '.trellis/workflow.md': '# workflow\n',
    [`.trellis/workspace/${developerId}/index.md`]: `# ${developerId}\n`,
    'AGENTS.md': '# generated agents\n',
  }
  if (agentTools.includes('codex')) files['.codex/hooks/session-start.py'] = '# generated hook\n'
  if (agentTools.includes('opencode')) {
    files['.opencode/plugins/trellis.js'] = 'export const trellis = true\n'
  }
  const hashes = Object.fromEntries(Object.keys(files).map((file) => [file, 'fixture']))
  files['.trellis/.template-hashes.json'] = JSON.stringify({ __version: 2, hashes })
  for (const [relativePath, content] of Object.entries(files)) {
    write(path.join(cwd, relativePath), content)
  }
}

test('远端探测按目标分支读取 Agent 目录并清理临时克隆', async (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { seed, remoteUrl } = createRemote(root, {
    withTrellis: true,
    agentPaths: ['.codex/hooks/session-start.py'],
  })
  write(path.join(seed, '.codex', 'hooks', 'session-start.py'), '# codex dev\n')
  git(seed, ['add', '--', '.codex'])
  git(seed, ['commit', '-m', 'codex on dev'])
  git(seed, ['push', 'origin', 'dev'])
  git(seed, ['checkout', '-b', 'main'])
  git(seed, ['rm', '-r', '--', '.codex'])
  write(path.join(seed, '.claude', 'settings.json'), '{}\n')
  git(seed, ['add', '--', '.claude'])
  git(seed, ['commit', '-m', 'claude on main'])
  git(seed, ['push', '-u', 'origin', 'main'])
  git(seed, ['checkout', 'dev'])

  const instance = manager(root)
  const remote = normalizeGitRemote(remoteUrl, testConfig())
  const dev = await instance.probeRemote({
    actor: { userId: 'branch-probe-user' },
    remote,
    branch: 'dev',
  })
  assert.equal(dev.branch, 'dev')
  assert.equal(dev.hasTrellis, true)
  assert.deepEqual(dev.existingAgentTools, ['codex'])

  const main = await instance.probeRemote({
    actor: { userId: 'branch-probe-user' },
    remote,
    branch: 'main',
  })
  assert.equal(main.branch, 'main')
  assert.deepEqual(main.existingAgentTools, ['claude-code'])

  await assert.rejects(
    () =>
      instance.probeRemote({
        actor: { userId: 'branch-probe-user' },
        remote,
        branch: 'missing',
      }),
    (error) => error.status === 400 && /不存在共享分支/.test(error.message),
  )
  assert.deepEqual(
    fs
      .readdirSync(path.join(root, 'data', 'projects'))
      .filter((name) => name.startsWith('.probe-')),
    [],
  )
})

test('远端 tree 缺少被忽略的 Agent 目录时按模板清单识别', async (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { seed, remoteUrl } = createRemote(root, { withTrellis: true })
  write(path.join(seed, '.gitignore'), '.codex/\n')
  write(path.join(seed, '.codex', 'config.toml'), 'model = "fixture"\n')
  addManifestPaths(seed, ['.codex/config.toml'])
  git(seed, ['add', '--', '.gitignore', '.trellis/.template-hashes.json'])
  git(seed, ['commit', '-m', 'manifest records ignored codex'])
  git(seed, ['push', 'origin', 'dev'])
  assert.equal(git(seed, ['ls-tree', '-r', '--name-only', 'HEAD', '--', '.codex']).stdout, '')

  const result = await manager(root).probeRemote({
    actor: { userId: 'ignored-agent-probe-user' },
    remote: normalizeGitRemote(remoteUrl, testConfig()),
    branch: 'dev',
  })

  assert.equal(result.hasTrellis, true)
  assert.deepEqual(result.existingAgentTools, ['codex'])
})

test('模板清单缺失或损坏时安全回退到 tree 探测', async (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { seed, remoteUrl } = createRemote(root, {
    withTrellis: true,
    agentPaths: ['.claude/settings.json'],
  })
  const remote = normalizeGitRemote(remoteUrl, testConfig())
  const instance = manager(root)

  write(path.join(seed, '.trellis', '.template-hashes.json'), '{broken json')
  git(seed, ['add', '--', '.trellis/.template-hashes.json'])
  git(seed, ['commit', '-m', 'corrupt manifest'])
  git(seed, ['push', 'origin', 'dev'])
  const corrupt = await instance.probeRemote({
    actor: { userId: 'corrupt-manifest-user' },
    remote,
    branch: 'dev',
  })
  assert.deepEqual(corrupt.existingAgentTools, ['claude-code'])

  git(seed, ['rm', '--', '.trellis/.template-hashes.json'])
  git(seed, ['commit', '-m', 'remove manifest'])
  git(seed, ['push', 'origin', 'dev'])
  const missing = await instance.probeRemote({
    actor: { userId: 'missing-manifest-user' },
    remote,
    branch: 'dev',
  })
  assert.deepEqual(missing.existingAgentTools, ['claude-code'])
})

test('已有 .trellis 的项目只检出 .trellis', async (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { remoteUrl } = createRemote(root, {
    withTrellis: true,
    agentPaths: ['.codex/hooks/session-start.py'],
  })

  const result = await manager(root).cloneForTeam(project(remoteUrl), null, {
    agentTools: ['codex'],
    leadTrellisDevId: 'alice',
  })

  assert.equal(result.initialized, false)
  assert.deepEqual(
    fs.readdirSync(result.target).filter((name) => name !== '.git'),
    ['.trellis'],
  )
  assert.equal(fs.existsSync(path.join(result.target, 'README.md')), false)
  assert.equal(fs.existsSync(path.join(result.target, 'src', 'index.js')), false)
  assert.equal(fs.existsSync(path.join(result.target, '.trellis', 'scripts', 'task.py')), true)
})

test('已有 .trellis 且没有缺失 Agent 时跳过初始化', async (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { bare, remoteUrl } = createRemote(root, {
    withTrellis: true,
    agentPaths: ['.codex/hooks/session-start.py'],
  })
  const initialHead = git(bare, ['rev-parse', 'dev']).stdout.trim()

  const result = await manager(root, async () => {
    throw new Error('不应运行 Trellis 初始化')
  }).cloneForTeam(project(remoteUrl), null, {
    agentTools: ['codex'],
    leadTrellisDevId: 'alice',
  })

  assert.equal(result.initialized, false)
  assert.deepEqual(result.existingAgentTools, ['codex'])
  assert.deepEqual(result.initializedAgentTools, [])
  assert.equal(git(bare, ['rev-parse', 'dev']).stdout.trim(), initialHead)
})

test('已有 .trellis 时只初始化缺失 Agent', async (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { bare, remoteUrl } = createRemote(root, {
    withTrellis: true,
    agentPaths: ['.codex/hooks/session-start.py'],
  })
  let invoked = null

  const result = await manager(root, async ({ cwd, agentTools }) => {
    invoked = agentTools
    assert.equal(
      fs.readFileSync(path.join(cwd, '.codex', 'hooks', 'session-start.py'), 'utf8'),
      '# existing agent\n',
    )
    const relativePath = '.opencode/plugins/trellis.js'
    write(path.join(cwd, ...relativePath.split('/')), 'export const trellis = true\n')
    const manifestPath = path.join(cwd, '.trellis', '.template-hashes.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    manifest.hashes[relativePath] = 'fixture'
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8')
    return { code: 0, stdout: 'initialized', stderr: '' }
  }).cloneForTeam(project(remoteUrl), null, {
    agentTools: ['codex', 'opencode'],
    leadTrellisDevId: 'alice',
  })

  assert.deepEqual(invoked, ['opencode'])
  assert.deepEqual(result.existingAgentTools, ['codex'])
  assert.deepEqual(result.initializedAgentTools, ['opencode'])
  const remoteHead = git(bare, ['rev-parse', 'dev']).stdout.trim()
  assert.equal(result.remoteCommitSha, remoteHead)
  assert.equal(
    git(bare, ['show', `${remoteHead}:.codex/hooks/session-start.py`]).stdout,
    '# existing agent\n',
  )
  assert.equal(
    git(bare, ['show', `${remoteHead}:.opencode/plugins/trellis.js`]).stdout,
    'export const trellis = true\n',
  )
})

test('缺少 .trellis 时自动初始化、提交、推送并继续只检出 .trellis', async (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { bare, remoteUrl } = createRemote(root, { withTrellis: false })
  const initialHead = git(bare, ['rev-parse', 'dev']).stdout.trim()
  let invoked = null

  const result = await manager(root, async ({ cwd, agentTools, leadTrellisDevId }) => {
    invoked = { cwd, agentTools, leadTrellisDevId }
    writeInitializedTrellis(cwd, leadTrellisDevId, agentTools)
    return { code: 0, stdout: 'initialized', stderr: '' }
  }).cloneForTeam(project(remoteUrl), null, {
    agentTools: ['codex', 'opencode'],
    leadTrellisDevId: 'alice',
  })

  assert.deepEqual(invoked.agentTools, ['codex', 'opencode'])
  assert.equal(invoked.leadTrellisDevId, 'alice')
  assert.equal(result.initialized, true)
  assert.deepEqual(
    fs.readdirSync(result.target).filter((name) => name !== '.git'),
    ['.trellis'],
  )
  assert.equal(fs.existsSync(path.join(result.target, 'README.md')), false)

  const remoteHead = git(bare, ['rev-parse', 'dev']).stdout.trim()
  assert.notEqual(remoteHead, initialHead)
  assert.equal(result.remoteCommitSha, remoteHead)
  assert.match(
    git(bare, ['log', '-1', '--format=%s', remoteHead]).stdout,
    /initialize Trellis workspace/,
  )
  assert.equal(git(bare, ['show', `${remoteHead}:.trellis/workflow.md`]).stdout, '# workflow\n')
})

test('初始化校验识别被 gitignore 但清单记录的 Agent 文件', async (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { bare, seed, remoteUrl } = createRemote(root, { withTrellis: false })
  write(path.join(seed, '.gitignore'), '.codex/\n')
  git(seed, ['add', '--', '.gitignore'])
  git(seed, ['commit', '-m', 'ignore generated codex files'])
  git(seed, ['push', 'origin', 'dev'])

  const result = await manager(root, async ({ cwd, leadTrellisDevId }) => {
    writeInitializedTrellis(cwd, leadTrellisDevId, ['codex'])
    assert.equal(fs.existsSync(path.join(cwd, '.codex', 'hooks', 'session-start.py')), true)
    assert.equal(
      git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']).stdout.includes('.codex/'),
      false,
    )
    return { code: 0, stdout: 'initialized', stderr: '' }
  }).cloneForTeam(project(remoteUrl), null, {
    agentTools: ['codex'],
    leadTrellisDevId: 'alice',
  })

  assert.equal(result.initialized, true)
  assert.deepEqual(
    fs.readdirSync(result.target).filter((name) => name !== '.git'),
    ['.trellis'],
  )
  const remoteHead = git(bare, ['rev-parse', 'dev']).stdout.trim()
  assert.equal(result.remoteCommitSha, remoteHead)
  assert.equal(git(bare, ['ls-tree', '-r', '--name-only', remoteHead, '--', '.codex']).stdout, '')
})

test('真实本地 Trellis CLI 可以完成自动初始化并推送', async (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { bare, remoteUrl } = createRemote(root, { withTrellis: false })

  const result = await manager(root).cloneForTeam(project(remoteUrl), null, {
    agentTools: ['codex'],
    leadTrellisDevId: 'alice',
  })

  assert.equal(result.initialized, true)
  assert.deepEqual(
    fs.readdirSync(result.target).filter((name) => name !== '.git'),
    ['.trellis'],
  )
  const remoteHead = git(bare, ['rev-parse', 'dev']).stdout.trim()
  assert.equal(result.remoteCommitSha, remoteHead)
  assert.equal(fs.existsSync(path.join(result.target, '.trellis', 'scripts', '__pycache__')), false)
  assert.equal(
    git(bare, ['cat-file', '-t', `${remoteHead}:.trellis/scripts/task.py`]).stdout.trim(),
    'blob',
  )
  assert.match(
    git(bare, ['show', `${remoteHead}:.trellis/workspace/alice/index.md`]).stdout,
    /alice/i,
  )
})

test('初始化推送遇到远端分叉时 fetch + rebase 后重试一次', async (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { bare, seed, remoteUrl } = createRemote(root, { withTrellis: false })

  const result = await manager(root, async ({ cwd, leadTrellisDevId }) => {
    writeInitializedTrellis(cwd, leadTrellisDevId)
    write(path.join(seed, 'README.md'), '# concurrent remote change\n')
    git(seed, ['add', '--', 'README.md'])
    git(seed, ['commit', '-m', 'concurrent remote change'])
    git(seed, ['push', 'origin', 'dev'])
    return { code: 0, stdout: 'initialized', stderr: '' }
  }).cloneForTeam(project(remoteUrl), null, {
    agentTools: ['codex'],
    leadTrellisDevId: 'alice',
  })

  const remoteHead = git(bare, ['rev-parse', 'dev']).stdout.trim()
  assert.equal(remoteHead, result.remoteCommitSha)
  const parents = git(bare, ['rev-list', '--parents', '-1', remoteHead]).stdout.trim().split(/\s+/)
  assert.match(
    git(bare, ['log', '-1', '--format=%s', parents[1]]).stdout,
    /concurrent remote change/,
  )
  assert.equal(
    git(bare, ['show', `${remoteHead}:README.md`]).stdout,
    '# concurrent remote change\n',
  )
  assert.equal(git(bare, ['show', `${remoteHead}:.trellis/workflow.md`]).stdout, '# workflow\n')
  assert.deepEqual(
    fs.readdirSync(result.target).filter((name) => name !== '.git'),
    ['.trellis'],
  )
})

test('初始化产生越界文件时拒绝推送并清理工作副本', async (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { bare, remoteUrl } = createRemote(root, { withTrellis: false })
  const initialHead = git(bare, ['rev-parse', 'dev']).stdout.trim()

  await assert.rejects(
    () =>
      manager(root, async ({ cwd }) => {
        write(path.join(cwd, '.trellis', 'scripts', 'task.py'), '# task tool\n')
        write(path.join(cwd, '.trellis', 'workflow.md'), '# workflow\n')
        write(path.join(cwd, '.trellis', 'workspace', 'alice', 'index.md'), '# alice\n')
        write(
          path.join(cwd, '.trellis', '.template-hashes.json'),
          JSON.stringify({
            __version: 2,
            hashes: {
              '.trellis/scripts/task.py': 'x',
              '.trellis/workflow.md': 'x',
              '.trellis/workspace/alice/index.md': 'x',
            },
          }),
        )
        write(path.join(cwd, 'src', 'leak.js'), 'not allowed\n')
        return { code: 0, stdout: '', stderr: '' }
      }).cloneForTeam(project(remoteUrl), null, {
        agentTools: ['codex'],
        leadTrellisDevId: 'alice',
      }),
    (error) => error.code === 'TRELLIS_INIT_INVALID',
  )

  assert.equal(git(bare, ['rev-parse', 'dev']).stdout.trim(), initialHead)
  assert.equal(fs.existsSync(path.join(root, 'data', 'projects', 'workspace-1')), false)
})

test('初始化推送失败时返回可恢复错误并清理工作副本', async (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { bare, remoteUrl } = createRemote(root, { withTrellis: false })
  const initialHead = git(bare, ['rev-parse', 'dev']).stdout.trim()
  const rejectPush = path.join(bare, 'hooks', 'pre-receive')
  write(rejectPush, '#!/bin/sh\nexit 1\n')
  fs.chmodSync(rejectPush, 0o755)

  await assert.rejects(
    () =>
      manager(root, async ({ cwd, leadTrellisDevId }) => {
        writeInitializedTrellis(cwd, leadTrellisDevId)
        return { code: 0, stdout: '', stderr: '' }
      }).cloneForTeam(project(remoteUrl), null, {
        agentTools: ['codex'],
        leadTrellisDevId: 'alice',
      }),
    (error) =>
      error.code === 'GIT_REMOTE_FAILED' &&
      error.recoverable === true &&
      error.details?.branch === 'dev',
  )

  assert.equal(git(bare, ['rev-parse', 'dev']).stdout.trim(), initialHead)
  assert.equal(fs.existsSync(path.join(root, 'data', 'projects', 'workspace-1')), false)
})

test('初始化不会覆盖远端已有文件', async (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { bare, remoteUrl } = createRemote(root, { withTrellis: false })
  const seed = path.join(root, 'seed')
  write(path.join(seed, 'AGENTS.md'), '# existing agents\n')
  git(seed, ['add', '--', 'AGENTS.md'])
  git(seed, ['commit', '-m', 'existing agents'])
  git(seed, ['push', 'origin', 'dev'])
  const initialHead = git(bare, ['rev-parse', 'dev']).stdout.trim()

  await assert.rejects(
    () =>
      manager(root, async ({ cwd }) => {
        writeInitializedTrellis(cwd, 'alice')
        return { code: 0, stdout: '', stderr: '' }
      }).cloneForTeam(project(remoteUrl), null, {
        agentTools: ['codex'],
        leadTrellisDevId: 'alice',
      }),
    (error) => error.code === 'TRELLIS_INIT_CONFLICT',
  )

  assert.equal(git(bare, ['rev-parse', 'dev']).stdout.trim(), initialHead)
  assert.equal(git(bare, ['show', 'dev:AGENTS.md']).stdout, '# existing agents\n')
})

test('缺少 .trellis 时临时检出已有 Agent 并保护其文件', async (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { bare, remoteUrl } = createRemote(root, {
    withTrellis: false,
    agentPaths: [
      '.claude/settings.json',
      '.agents/skills/trellis-start/SKILL.md',
      '.gitattributes',
    ],
  })

  const result = await manager(root, async ({ cwd, agentTools, leadTrellisDevId }) => {
    assert.equal(
      fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8'),
      '# existing agent\n',
    )
    assert.equal(
      fs.readFileSync(path.join(cwd, '.agents', 'skills', 'trellis-start', 'SKILL.md'), 'utf8'),
      '# existing agent\n',
    )
    assert.deepEqual(agentTools, ['codex'])
    writeInitializedTrellis(cwd, leadTrellisDevId)
    fs.appendFileSync(path.join(cwd, '.gitattributes'), '\njournal-*.md merge=union\n')
    return { code: 0, stdout: 'initialized', stderr: '' }
  }).cloneForTeam(project(remoteUrl), null, {
    agentTools: ['codex'],
    leadTrellisDevId: 'alice',
  })

  assert.equal(result.initialized, true)
  assert.deepEqual(result.existingAgentTools, ['claude-code'])
  assert.deepEqual(result.initializedAgentTools, ['codex'])
  const remoteHead = git(bare, ['rev-parse', 'dev']).stdout.trim()
  assert.equal(
    git(bare, ['show', `${remoteHead}:.claude/settings.json`]).stdout,
    '# existing agent\n',
  )
  assert.equal(
    git(bare, ['show', `${remoteHead}:.agents/skills/trellis-start/SKILL.md`]).stdout,
    '# existing agent\n',
  )
  assert.match(
    git(bare, ['show', `${remoteHead}:.gitattributes`]).stdout,
    /^# existing agent\n[\s\S]*journal-\*\.md merge=union\n$/,
  )
})

test('干净完整克隆可以收敛为 .trellis 稀疏检出', async (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { remoteUrl } = createRemote(root, { withTrellis: true })
  const worktree = path.join(root, 'data', 'projects', 'workspace-1')
  git(root, ['-c', 'core.autocrlf=false', 'clone', '--branch', 'dev', remoteUrl, worktree])
  const instance = manager(root)
  await instance.ensureSparseTrellis({
    id: 'project-1',
    workspaceKey: 'workspace-1',
    path: worktree,
    remoteUrl,
    syncBranch: 'dev',
  })
  assert.deepEqual(
    fs.readdirSync(worktree).filter((name) => name !== '.git'),
    ['.trellis'],
  )
})
