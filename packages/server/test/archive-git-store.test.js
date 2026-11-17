import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { createArchiveGitStore } from '../team/archive-git-store.js'
import { createArchiveSnapshotStore } from '../team/archive-local-snapshot.js'

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

test('服务端完整读取 Git 归档普通文件并发布内容寻址本地快照', async () => {
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
    writeFile(repo, '.trellis/tasks/archive/2026-11/11-16-old/report.xlsx', Buffer.from('xlsx'))
    writeFile(repo, '.trellis/tasks/archive/2026-11/11-16-old/Main.class', Buffer.from('cafe'))
    writeFile(repo, '.trellis/tasks/archive/2026-11/11-16-old/diagram.pen', Buffer.from('pen'))
    for (let index = 0; index < 3; index += 1) {
      writeFile(
        repo,
        `.trellis/tasks/archive/2026-11/11-16-old/large-${index}.bin`,
        Buffer.alloc(12 * 1024 * 1024, 0x41 + index),
      )
    }
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
      git(repo, 'rev-parse', 'HEAD:.trellis/tasks/archive/2026-11/11-16-old/screenshot.png'),
      git(repo, 'rev-parse', 'HEAD:.trellis/tasks/archive/2026-11/11-16-old/helper.ps1'),
      git(repo, 'rev-parse', 'HEAD:.trellis/tasks/archive/2026-11/11-16-old/report.xlsx'),
      git(repo, 'rev-parse', 'HEAD:.trellis/tasks/archive/2026-11/11-16-old/Main.class'),
      git(repo, 'rev-parse', 'HEAD:.trellis/tasks/archive/2026-11/11-16-old/diagram.pen'),
      git(repo, 'rev-parse', 'HEAD:.trellis/tasks/archive/2026-11/11-16-old/large-0.bin'),
      git(repo, 'rev-parse', 'HEAD:.trellis/tasks/archive/2026-11/11-16-old/large-1.bin'),
      git(repo, 'rev-parse', 'HEAD:.trellis/tasks/archive/2026-11/11-16-old/large-2.bin'),
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
    const snapshots = createArchiveSnapshotStore({ db: {}, dataDir })
    const staging = snapshots.createStaging('space-1', 'attempt-1')
    const snapshot = await store.readSnapshot({
      taskSpaceId: 'space-1',
      project: { remote_url: remoteUrl },
      taskSpace: { branch_name: 'main' },
      snapshotWriter: staging,
    })
    const published = snapshots.publish({
      staging,
      head: snapshot.head,
      files: snapshot.files,
    })
    assert.equal(snapshot.fileCount, 10)
    assert.deepEqual(snapshot.files.map((file) => file.relativePath).sort(), [
      '.trellis/tasks/archive/2026-11/11-16-old/Main.class',
      '.trellis/tasks/archive/2026-11/11-16-old/diagram.pen',
      '.trellis/tasks/archive/2026-11/11-16-old/helper.ps1',
      '.trellis/tasks/archive/2026-11/11-16-old/large-0.bin',
      '.trellis/tasks/archive/2026-11/11-16-old/large-1.bin',
      '.trellis/tasks/archive/2026-11/11-16-old/large-2.bin',
      '.trellis/tasks/archive/2026-11/11-16-old/prd.md',
      '.trellis/tasks/archive/2026-11/11-16-old/report.xlsx',
      '.trellis/tasks/archive/2026-11/11-16-old/screenshot.png',
      '.trellis/tasks/archive/2026-11/11-16-old/task.json',
    ])
    assert.equal(
      snapshot.files.find((file) => file.relativePath.endsWith('/task.json')).taskId,
      'old',
    )
    assert.equal(
      snapshot.files.find((file) => file.relativePath.endsWith('/screenshot.png')).mimeType,
      'image/png',
    )
    const prd = published.files.find((file) => file.relativePath.endsWith('/prd.md'))
    const expectedPrdSha = crypto.createHash('sha256').update('# 完成\n').digest('hex')
    assert.equal(prd.sha256, expectedPrdSha)
    assert.equal(
      fs.readFileSync(
        path.join(dataDir, 'archive-snapshots', ...prd.storageKey.split('/')),
        'utf8',
      ),
      '# 完成\n',
    )
    assert.equal(
      fs.existsSync(path.join(dataDir, 'archive-snapshots', ...published.storageRoot.split('/'))),
      true,
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
    assert.ok(readCalls.length >= 2)
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
      true,
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
        snapshotWriter: snapshots.createStaging('space-1', 'attempt-invalid-path'),
      }),
      /归档任务目录格式无效/,
    )
    published.release()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
