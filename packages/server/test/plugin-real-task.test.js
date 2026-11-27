import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createTaskService } from '../plugins/task-service.js'
import { openPluginDatabase } from '@trellis-board/test-support/plugin-runtime.js'

const SOURCE_ROOT = process.cwd()

function hasPython3() {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function makeTrellisRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-real-task-'))
  fs.mkdirSync(path.join(root, '.trellis', 'tasks'), { recursive: true })
  fs.mkdirSync(path.join(root, '.trellis', 'workspace', 'alice'), { recursive: true })
  fs.mkdirSync(path.join(root, '.trellis', 'workspace', 'bob'), { recursive: true })
  fs.cpSync(path.join(SOURCE_ROOT, '.trellis', 'scripts'), path.join(root, '.trellis', 'scripts'), {
    recursive: true,
  })
  execFileSync('git', ['init', '-q'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: root })
  return root
}

test('真实 task.py：baseBranch、父任务与 extraFiles 落盘', { skip: !hasPython3() }, async () => {
  const repoRoot = makeTrellisRepo()
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-real-task-link-'))
  const db = openPluginDatabase({
    root: workspace,
    databaseFile: path.join(workspace, 'board.sqlite'),
    legacyFiles: [],
  })
  try {
    const service = createTaskService({
      repositories: [{ id: 'repo', name: 'repo', path: repoRoot }],
      db,
    })
    const parent = await service.create({
      repositoryId: 'repo',
      title: '父任务',
      description: '父任务描述',
      assignee: 'alice',
      priority: 'P1',
      slug: 'parent-link-check',
      taskType: 'complex',
      workType: 'backend',
      baseBranch: 'feature/base',
      extraFiles: { 'task.md': '# 平台原文\n\n父任务内容\n' },
    })
    const child = await service.create({
      repositoryId: 'repo',
      title: '子任务',
      description: '子任务描述',
      assignee: 'alice',
      priority: 'P2',
      slug: 'child-link-check',
      taskType: 'simple',
      workType: 'backend',
      baseBranch: 'feature/base',
      parentDir: parent.relativeDir,
    })

    const parentFull = path.join(repoRoot, '.trellis', 'tasks', parent.relativeDir)
    const childFull = path.join(repoRoot, '.trellis', 'tasks', child.relativeDir)
    const parentJson = JSON.parse(fs.readFileSync(path.join(parentFull, 'task.json'), 'utf8'))
    const childJson = JSON.parse(fs.readFileSync(path.join(childFull, 'task.json'), 'utf8'))
    assert.equal(parentJson.base_branch, 'feature/base')
    assert.equal(childJson.base_branch, 'feature/base')
    assert.equal(childJson.parent, parent.relativeDir)
    assert.deepEqual(parentJson.children, [child.relativeDir])
    assert.equal(
      fs.readFileSync(path.join(parentFull, 'task.md'), 'utf8'),
      '# 平台原文\n\n父任务内容\n',
    )
  } finally {
    try {
      db.close()
    } catch {
      // 关闭失败不掩盖前面的断言错误。
    }
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('真实 task.py：创建、写 prd、合并 meta、改派与阶段更新', { skip: !hasPython3() }, async () => {
  const repoRoot = makeTrellisRepo()
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-real-task-db-'))
  const dbFile = path.join(workspace, 'board.sqlite')
  const db = openPluginDatabase({ root: workspace, databaseFile: dbFile, legacyFiles: [] })
  try {
    const service = createTaskService({
      repositories: [{ id: 'repo', name: 'repo', path: repoRoot }],
      db,
    })
    const prd = '# 真实脚本验证\n\n- 目标：证明 task.py 接受 createTask 的参数\n'
    const task = await service.create({
      repositoryId: 'repo',
      title: '真实任务脚本集成',
      description: '由插件任务服务调用真实 task.py 创建',
      assignee: 'alice',
      priority: 'P1',
      slug: 'real-task-check',
      taskType: 'simple',
      workType: 'frontend',
      prd,
      meta: { agent: 'opencode', source: { type: 4, businessId: 10001 } },
    })

    assert.match(task.relativeDir, /^\d{2}-\d{2}-real-task-check$/)
    assert.equal(task.taskKey, `repo::${task.relativeDir}`)
    assert.equal(task.taskType, 'simple')
    assert.equal(task.workType, 'frontend')
    const full = path.join(repoRoot, '.trellis', 'tasks', task.relativeDir)
    const taskJson = JSON.parse(fs.readFileSync(path.join(full, 'task.json'), 'utf8'))
    assert.equal(taskJson.title, '真实任务脚本集成')
    assert.equal(taskJson.status, 'planning')
    assert.equal(taskJson.priority, 'P1')
    assert.equal(taskJson.assignee, 'alice')
    assert.equal(taskJson.creator, 'alice')
    assert.equal(taskJson.task_type, 'simple')
    assert.equal(taskJson.work_type, 'frontend')
    assert.equal(taskJson.meta.label_source, 'user-explicit')
    assert.equal(taskJson.meta.agent, 'opencode')
    assert.equal(taskJson.meta.source.businessId, 10001)
    assert.equal(fs.readFileSync(path.join(full, 'prd.md'), 'utf8'), prd)

    // 显式编号保留大写前缀，task.py 接受 T/R/B/W 形式的目录。
    const coded = await service.create({
      repositoryId: 'repo',
      title: '大写编号任务',
      description: '验证 T 前缀目录',
      assignee: 'alice',
      priority: 'P2',
      slug: 'T900001',
      taskType: 'simple',
      workType: 'backend',
    })
    assert.match(coded.relativeDir, /^\d{2}-\d{2}-T900001$/)
    const codedJson = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, '.trellis', 'tasks', coded.relativeDir, 'task.json'),
        'utf8',
      ),
    )
    assert.equal(codedJson.id, 'T900001')

    // 不带 --meta 时也允许后补 meta（插件 update 路径）。
    const assigned = await service.assign({
      repositoryId: 'repo',
      relativeDir: task.relativeDir,
      assignee: 'bob',
      meta: { agent: 'claude' },
    })
    assert.equal(assigned.assignee, 'bob')
    assert.equal(assigned.meta.agent, 'claude')
    assert.equal(assigned.meta.source.businessId, 10001)
    const afterAssign = JSON.parse(fs.readFileSync(path.join(full, 'task.json'), 'utf8'))
    assert.equal(afterAssign.assignee, 'bob')

    // 重复 create 会因目录已存在被 task.py 拒绝，插件侧应把它转成明确错误。
    await assert.rejects(
      service.create({
        repositoryId: 'repo',
        title: '真实任务脚本集成',
        description: '重复创建',
        assignee: 'alice',
        slug: 'real-task-check',
        taskType: 'simple',
        workType: 'frontend',
      }),
      /已存在|exists|refus/i,
    )
  } finally {
    try {
      db.close()
    } catch {
      // 关闭失败不掩盖前面的断言错误。
    }
    fs.rmSync(workspace, { recursive: true, force: true })
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test(
  'PATH 首位是不可执行的 python 时插件仍能创建真实任务',
  { skip: !hasPython3() || process.platform === 'win32' },
  async () => {
    const repoRoot = makeTrellisRepo()
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-real-task-broken-python-'))
    const db = openPluginDatabase({
      root: workspace,
      databaseFile: path.join(workspace, 'board.sqlite'),
      legacyFiles: [],
    })
    const blocked = path.join(workspace, 'blocked-python')
    fs.mkdirSync(blocked, { recursive: true })
    const plain = path.join(blocked, 'python')
    fs.writeFileSync(plain, '#!/bin/sh\n')
    fs.chmodSync(plain, 0o644)

    const previousPath = process.env.PATH
    const previousPython = process.env.TRELLIS_PYTHON
    process.env.PATH = `${blocked}${path.delimiter}${previousPath}`
    // 目录 spawn 会得到 EACCES，模拟 Windows 上不可执行的同名解释器。
    process.env.TRELLIS_PYTHON = blocked
    try {
      const service = createTaskService({
        repositories: [{ id: 'repo', name: 'repo', path: repoRoot }],
        db,
      })
      const task = await service.create({
        repositoryId: 'repo',
        title: '坏 Python 回退',
        description: 'PATH 首位不可执行时仍应回退到真实 python3',
        assignee: 'alice',
        priority: 'P1',
        slug: 'broken-python-fallback',
        taskType: 'simple',
        workType: 'backend',
      })
      assert.match(task.relativeDir, /^\d{2}-\d{2}-broken-python-fallback$/)
      assert.ok(
        fs.existsSync(path.join(repoRoot, '.trellis', 'tasks', task.relativeDir, 'task.json')),
      )
    } finally {
      process.env.PATH = previousPath
      if (previousPython === undefined) delete process.env.TRELLIS_PYTHON
      else process.env.TRELLIS_PYTHON = previousPython
      try {
        db.close()
      } catch {
        // 关闭失败不掩盖断言错误。
      }
      fs.rmSync(workspace, { recursive: true, force: true })
      fs.rmSync(repoRoot, { recursive: true, force: true })
    }
  },
)
