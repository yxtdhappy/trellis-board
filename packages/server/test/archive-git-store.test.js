import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
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

test('服务端只读取 Git 归档目录且不创建工作副本', async () => {
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
    const cache = path.join(dataDir, 'archive-git', 'space-1.git')
    assert.equal(fs.existsSync(path.join(cache, 'HEAD')), true)
    assert.equal(fs.existsSync(path.join(cache, '.git')), false)
    const cachedObjects = git(cache, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname)')
    assert.equal(cachedObjects.includes(git(repo, 'rev-parse', 'HEAD:src/app.js')), false)
    assert.equal(
      cachedObjects.includes(git(repo, 'rev-parse', 'HEAD:.trellis/tasks/11-17-active/task.json')),
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
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
