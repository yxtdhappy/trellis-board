import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createGitManager } from '../server/team/git-manager.js'

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-sparse-onboarding-'))
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
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

function createRemote(root, { withTrellis }) {
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

function writeInitializedTrellis(cwd, developerId) {
  const files = {
    '.trellis/scripts/task.py': '# task tool\n',
    '.trellis/scripts/common/trellis_config.py': '# config parser\n',
    '.trellis/workflow.md': '# workflow\n',
    [`.trellis/workspace/${developerId}/index.md`]: `# ${developerId}\n`,
    '.codex/hooks/session-start.py': '# generated hook\n',
    'AGENTS.md': '# generated agents\n',
  }
  const hashes = Object.fromEntries(Object.keys(files).map((file) => [file, 'fixture']))
  files['.trellis/.template-hashes.json'] = JSON.stringify({ __version: 2, hashes })
  for (const [relativePath, content] of Object.entries(files)) {
    write(path.join(cwd, relativePath), content)
  }
}

test('已有 .trellis 的项目只检出 .trellis', async (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { remoteUrl } = createRemote(root, { withTrellis: true })

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

test('缺少 .trellis 时自动初始化、提交、推送并继续只检出 .trellis', async (t) => {
  const root = makeRoot()
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const { bare, remoteUrl } = createRemote(root, { withTrellis: false })
  const initialHead = git(bare, ['rev-parse', 'dev']).stdout.trim()
  let invoked = null

  const result = await manager(root, async ({ cwd, agentTools, leadTrellisDevId }) => {
    invoked = { cwd, agentTools, leadTrellisDevId }
    writeInitializedTrellis(cwd, leadTrellisDevId)
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
