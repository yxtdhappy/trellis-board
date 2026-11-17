import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { createArchiveGitStore } from '../team/archive-git-store.js'

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function writeFile(root, relativePath, content) {
  const filePath = path.join(root, relativePath)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
}

test('服务端只读取 Git 归档白名单文件并跳过附件', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-archive-git-store-'))
  const repo = path.join(root, 'repo')
  const remote = path.join(root, 'remote.git')
  const remoteUrl = pathToFileURL(remote).href
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(repo)
  fs.mkdirSync(dataDir)
  try {
    git(repo, 'init', '--initial-branch=main')
    git(repo, 'config', 'user.name', 'Trellis Test')
    git(repo, 'config', 'user.email', 'trellis@example.com')
    writeFile(
      repo,
      '.trellis/tasks/archive/2026-11/11-16-old/task.json',
      JSON.stringify({ id: 'old', title: '归档任务', branch: 'main' }),
    )
    writeFile(repo, '.trellis/tasks/archive/2026-11/11-16-old/prd.md', '# 完成\n')
    writeFile(
      repo,
      '.trellis/tasks/archive/2026-11/11-16-old/screenshot.png',
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    )
    writeFile(repo, '.trellis/tasks/archive/2026-11/11-16-old/helper.ps1', 'Write-Output 1\n')
    writeFile(
      repo,
      '.trellis/tasks/11-17-active/task.json',
      JSON.stringify({ id: 'active', title: '活动任务', branch: 'main' }),
    )
    writeFile(repo, 'src/app.js', 'console.log("source")\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'fixture')
    git(root, 'init', '--bare', remote)
    git(remote, 'config', 'uploadpack.allowFilter', 'true')
    git(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
    git(repo, 'remote', 'add', 'origin', remoteUrl)
    git(repo, 'push', 'origin', 'main')
    const expectedFetchOids = [
      git(repo, 'rev-parse', 'HEAD:.trellis/tasks/archive/2026-11/11-16-old/task.json'),
      git(repo, 'rev-parse', 'HEAD:.trellis/tasks/archive/2026-11/11-16-old/prd.md'),
    ].sort()

    const spawnCalls = []
    const store = createArchiveGitStore({
      dataDir,
      config: { allowLocalGitRemotes: true },
      credentials: {
        resolveForRemote() {
          return {
            remote: { scheme: 'file', host: '', port: null, url: remoteUrl },
            origin: null,
            credential: null,
          }
        },
        async withAuth(_credential, callback) {
          return callback(null)
        },
      },
      spawnImpl(command, args, options) {
        const call = {
          command,
          args: [...args],
          env: { ...options.env },
          stdin: '',
        }
        spawnCalls.push(call)
        const child = spawn(command, args, options)
        if (args.includes('fetch') && args.includes('--stdin')) {
          const end = child.stdin.end.bind(child.stdin)
          child.stdin.end = (chunk, ...rest) => {
            call.stdin += String(chunk || '')
            return end(chunk, ...rest)
          }
        }
        return child
      },
      logger: { info() {}, warn() {} },
    })
    const snapshot = await store.readSnapshot({
      taskSpaceId: 'space-1',
      project: { remote_url: remoteUrl },
      taskSpace: { branch_name: 'main' },
    })
    assert.equal(snapshot.fileCount, 2)
    assert.deepEqual(snapshot.files.map((file) => file.relativePath).sort(), [
      '.trellis/tasks/archive/2026-11/11-16-old/prd.md',
      '.trellis/tasks/archive/2026-11/11-16-old/task.json',
    ])
    assert.equal(
      snapshot.files.find((file) => file.relativePath.endsWith('/task.json')).taskId,
      'old',
    )
    const fetchCalls = spawnCalls.filter(
      (call) =>
        call.command === 'git' && call.args.includes('fetch') && call.args.includes('--stdin'),
    )
    assert.equal(fetchCalls.length, 1)
    assert.ok(fetchCalls[0].args.includes('fetch.negotiationAlgorithm=noop'))
    const fetchIndex = fetchCalls[0].args.indexOf('fetch')
    assert.equal(fetchCalls[0].args[fetchIndex + 1], 'origin')
    assert.equal(fetchCalls[0].args.includes('fetch-pack'), false)
    assert.equal(fetchCalls[0].args.includes(remoteUrl), false)
    assert.equal(fetchCalls[0].env.GIT_NO_LAZY_FETCH, '1')
    assert.deepEqual(
      fetchCalls[0].stdin.trim().split(/\r?\n/).filter(Boolean).sort(),
      expectedFetchOids,
    )
    const readCalls = spawnCalls.filter(
      (call) => call.command === 'git' && call.args.includes('cat-file'),
    )
    assert.ok(readCalls.length > 0)
    assert.ok(readCalls.every((call) => call.env.GIT_NO_LAZY_FETCH === '1'))
    const cache = path.join(dataDir, 'archive-git', 'space-1.git')
    assert.equal(fs.existsSync(path.join(cache, 'HEAD')), true)
    assert.equal(fs.existsSync(path.join(cache, '.git')), false)
    const cachedObjects = git(
      cache,
      'cat-file',
      '--batch-all-objects',
      '--batch-check=%(objectname)',
    )
    assert.equal(cachedObjects.includes(git(repo, 'rev-parse', 'HEAD:src/app.js')), false)
    assert.equal(
      cachedObjects.includes(git(repo, 'rev-parse', 'HEAD:.trellis/tasks/11-17-active/task.json')),
      false,
    )
    assert.equal(
      cachedObjects.includes(
        git(repo, 'rev-parse', 'HEAD:.trellis/tasks/archive/2026-11/11-16-old/screenshot.png'),
      ),
      false,
    )
    assert.equal(
      cachedObjects.includes(
        git(repo, 'rev-parse', 'HEAD:.trellis/tasks/archive/2026-11/11-16-old/helper.ps1'),
      ),
      false,
    )

    const unchanged = await store.readSnapshot({
      taskSpaceId: 'space-1',
      project: { remote_url: remoteUrl },
      taskSpace: { branch_name: 'main' },
      knownHead: snapshot.head,
    })
    assert.equal(unchanged.skipped, true)
    assert.equal(unchanged.files, null)

    writeFile(
      repo,
      '.trellis/tasks/archive/2026-11/11-17-too-large/report.md',
      'x'.repeat(1024 * 1024 + 1),
    )
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'oversized archive')
    git(repo, 'push', 'origin', 'main')
    await assert.rejects(
      store.readSnapshot({
        taskSpaceId: 'space-1',
        project: { remote_url: remoteUrl },
        taskSpace: { branch_name: 'main' },
      }),
      (error) => error?.code === 'ARCHIVE_FILE_TOO_LARGE',
    )

    writeFile(
      repo,
      '.trellis/tasks/archive/2026-13/invalid-month/screenshot.png',
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    )
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'invalid archive path')
    git(repo, 'push', 'origin', 'main')
    await assert.rejects(
      store.readSnapshot({
        taskSpaceId: 'space-1',
        project: { remote_url: remoteUrl },
        taskSpace: { branch_name: 'main' },
      }),
      /归档任务目录格式无效/,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
