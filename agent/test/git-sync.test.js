import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  assertGitOperationAllowed,
  GIT_ARGUMENT_CONTRACT,
  inspectRepository,
  normalizeRemoteIdentity,
  syncRepository,
} from '../git-sync.js'
import { AGENT_ERROR_CODE, AgentError } from '../protocol.js'

function git(cwd, args, allowFailure = false) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    env: process.env,
  })
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function initRepository(withIgnore = false) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-agent-git-'))
  const remote = path.join(base, 'remote.git')
  const seed = path.join(base, 'seed')
  const local = path.join(base, 'local')
  fs.mkdirSync(seed, { recursive: true })
  git(base, ['init', '--bare', '--initial-branch=main', remote])
  git(seed, ['init', '-b', 'main'])
  git(seed, ['config', 'user.email', 'agent-test@example.invalid'])
  git(seed, ['config', 'user.name', 'Agent Test'])
  write(path.join(seed, '.trellis', 'tasks', '.keep'), 'tasks\n')
  write(path.join(seed, '.trellis', 'workspace', '.keep'), 'workspace\n')
  write(path.join(seed, 'README.md'), 'initial\n')
  write(path.join(seed, '.gitattributes'), '* text=auto eol=lf\n')
  if (withIgnore) {
    write(path.join(seed, '.gitignore'), 'ignored.txt\n')
  }
  git(seed, ['add', '.'])
  git(seed, ['commit', '-m', 'initial'])
  const remoteUrl = pathToFileURL(remote).href
  git(seed, ['remote', 'add', 'origin', remoteUrl])
  git(seed, ['push', '-u', 'origin', 'main'])
  git(base, ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'clone', remoteUrl, local])
  git(local, ['config', 'user.email', 'agent-test@example.invalid'])
  git(local, ['config', 'user.name', 'Agent Test'])
  return { base, remote, seed, local, remoteUrl }
}

function hooksDir(base) {
  const target = path.join(base, 'hooks')
  fs.mkdirSync(target, { recursive: true })
  return target
}

function remoteIdentity(repo) {
  return normalizeRemoteIdentity(repo.remoteUrl, { allowFileRemote: true }).identityHash
}

function hasCode(code) {
  return (error) => error instanceof AgentError && error.code === code
}

test('远端归一化忽略协议、用户名、默认端口和 .git 后缀', () => {
  const ssh = normalizeRemoteIdentity('git@Example.COM:Org/Repo.git')
  const https = normalizeRemoteIdentity('https://example.com/Org/Repo')
  const sshUrl = normalizeRemoteIdentity('ssh://deploy@example.com:22/Org/Repo.git')
  const httpsDefaultPort = normalizeRemoteIdentity('https://example.com:443/Org/Repo.git')
  assert.equal(ssh.identityHash, https.identityHash)
  assert.equal(sshUrl.identityHash, https.identityHash)
  assert.equal(httpsDefaultPort.identityHash, https.identityHash)
  assert.equal(ssh.path, 'Org/Repo')
  assert.throws(
    () => normalizeRemoteIdentity('https://user:token@example.com/org/repo.git'),
    hasCode(AGENT_ERROR_CODE.REMOTE_INVALID),
  )
  assert.throws(
    () => normalizeRemoteIdentity('C:\\work\\repo'),
    hasCode(AGENT_ERROR_CODE.REMOTE_INVALID),
  )
  assert.equal(
    normalizeRemoteIdentity('C:\\work\\repo.git', { allowFileRemote: true }).identityHash,
    normalizeRemoteIdentity('file:///C:/work/repo', { allowFileRemote: true }).identityHash,
  )
})

test('Git 操作白名单拒绝危险命令', () => {
  assert.deepEqual(GIT_ARGUMENT_CONTRACT.forbidden.includes('checkout'), true)
  assert.deepEqual(GIT_ARGUMENT_CONTRACT.forbidden.includes('push'), true)
  assert.throws(() => assertGitOperationAllowed('reset'), hasCode(AGENT_ERROR_CODE.GIT_FAILED))
  assert.doesNotThrow(() => assertGitOperationAllowed('fetch'))
})

test('干净仓库完成 fetch 和 ff-only 同步并更新 HEAD', async () => {
  const repo = initRepository()
  try {
    const hooks = hooksDir(repo.base)
    const expected = remoteIdentity(repo)
    const before = await inspectRepository({
      repoPath: repo.local,
      branchName: 'main',
      hooksDir: hooks,
      expectedRemoteIdentity: expected,
      allowFileRemote: true,
    })
    assert.equal(before.clean, true)

    write(path.join(repo.seed, 'README.md'), 'remote update\n')
    git(repo.seed, ['add', 'README.md'])
    git(repo.seed, ['commit', '-m', 'remote update'])
    git(repo.seed, ['push', 'origin', 'main'])
    const result = await syncRepository({
      repoPath: repo.local,
      branchName: 'main',
      hooksDir: hooks,
      expectedRemoteIdentity: expected,
      allowFileRemote: true,
    })
    const head = spawnSync('git', ['-C', repo.local, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      shell: false,
    }).stdout.trim()
    assert.equal(result.head, head)
    assert.equal(fs.readFileSync(path.join(repo.local, 'README.md'), 'utf8'), 'remote update\n')
  } finally {
    fs.rmSync(repo.base, { recursive: true, force: true })
  }
})

test('dirty、错分支、本地领先和缺失工作区都拒绝且不清理文件', async () => {
  const repo = initRepository()
  try {
    const hooks = hooksDir(repo.base)
    const expected = remoteIdentity(repo)
    const dirtyFile = path.join(repo.local, 'dirty.txt')
    write(dirtyFile, 'keep me\n')
    await assert.rejects(
      () =>
        syncRepository({
          repoPath: repo.local,
          branchName: 'main',
          hooksDir: hooks,
          expectedRemoteIdentity: expected,
          allowFileRemote: true,
        }),
      hasCode(AGENT_ERROR_CODE.LOCAL_DIRTY),
    )
    assert.equal(fs.existsSync(dirtyFile), true)
    fs.rmSync(dirtyFile)

    git(repo.local, ['checkout', '-b', 'other'])
    await assert.rejects(
      () =>
        inspectRepository({
          repoPath: repo.local,
          branchName: 'main',
          hooksDir: hooks,
          expectedRemoteIdentity: expected,
          allowFileRemote: true,
        }),
      hasCode(AGENT_ERROR_CODE.BRANCH_MISMATCH),
    )
    git(repo.local, ['checkout', 'main'])
    write(path.join(repo.local, 'local.txt'), 'local\n')
    git(repo.local, ['add', 'local.txt'])
    git(repo.local, ['commit', '-m', 'local commit'])
    await assert.rejects(
      () =>
        syncRepository({
          repoPath: repo.local,
          branchName: 'main',
          hooksDir: hooks,
          expectedRemoteIdentity: expected,
          allowFileRemote: true,
        }),
      hasCode(AGENT_ERROR_CODE.LOCAL_AHEAD),
    )
    const localHead = spawnSync('git', ['-C', repo.local, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      shell: false,
    }).stdout.trim()
    assert.equal(localHead.length, 40)
  } finally {
    fs.rmSync(repo.base, { recursive: true, force: true })
  }
})

test('sparse checkout 和不可达远端返回稳定错误，任务同步不依赖 workspace', async () => {
  const repo = initRepository()
  try {
    const hooks = hooksDir(repo.base)
    const expected = remoteIdentity(repo)
    git(repo.local, ['config', 'core.sparseCheckout', 'true'])
    await assert.rejects(
      () =>
        inspectRepository({
          repoPath: repo.local,
          branchName: 'main',
          hooksDir: hooks,
          expectedRemoteIdentity: expected,
          allowFileRemote: true,
        }),
      hasCode(AGENT_ERROR_CODE.SPARSE_CHECKOUT),
    )
    git(repo.local, ['config', 'core.sparseCheckout', 'false'])
    fs.rmSync(path.join(repo.local, '.trellis', 'workspace'), { recursive: true, force: true })
    const inspected = await inspectRepository({
      repoPath: repo.local,
      branchName: 'main',
      hooksDir: hooks,
      expectedRemoteIdentity: expected,
      allowFileRemote: true,
    })
    assert.equal(inspected.branchName, 'main')
    write(path.join(repo.local, '.trellis', 'workspace', '.keep'), 'workspace\n')
    git(repo.local, [
      'remote',
      'set-url',
      'origin',
      pathToFileURL(path.join(repo.base, 'missing.git')).href,
    ])
    await assert.rejects(
      () =>
        syncRepository({
          repoPath: repo.local,
          branchName: 'main',
          hooksDir: hooks,
          allowFileRemote: true,
        }),
      hasCode(AGENT_ERROR_CODE.REMOTE_UNREACHABLE),
    )
  } finally {
    fs.rmSync(repo.base, { recursive: true, force: true })
  }
})

test('ignored 本地文件不会被远端新文件覆盖', async () => {
  const repo = initRepository(true)
  try {
    const hooks = hooksDir(repo.base)
    const expected = remoteIdentity(repo)
    write(path.join(repo.local, 'ignored.txt'), 'local ignored\n')
    write(path.join(repo.seed, 'ignored.txt'), 'remote tracked\n')
    git(repo.seed, ['add', '-f', 'ignored.txt'])
    git(repo.seed, ['commit', '-m', 'track ignored path'])
    git(repo.seed, ['push', 'origin', 'main'])
    await assert.rejects(
      () =>
        syncRepository({
          repoPath: repo.local,
          branchName: 'main',
          hooksDir: hooks,
          expectedRemoteIdentity: expected,
          allowFileRemote: true,
        }),
      hasCode(AGENT_ERROR_CODE.IGNORED_FILE_CONFLICT),
    )
    assert.equal(fs.readFileSync(path.join(repo.local, 'ignored.txt'), 'utf8'), 'local ignored\n')
  } finally {
    fs.rmSync(repo.base, { recursive: true, force: true })
  }
})
