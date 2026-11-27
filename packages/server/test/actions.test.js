import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { PYTHON_UNAVAILABLE } from '../python.js'

test('创建任务会拒绝空标题', async () => {
  const { createTask } = await import('../actions.js')
  await assert.rejects(
    () => createTask({ repositoryId: 'missing', title: '', description: 'x', assignee: 'dev' }),
    /任务标题不能为空/,
  )
})

test('纯中文标题未填写标识时会给出明确提示', async () => {
  const { createTask } = await import('../actions.js')
  await assert.rejects(
    () =>
      createTask({
        repositoryId: 'missing',
        title: '补齐看板任务导出能力',
        description: 'x',
        assignee: 'dev',
      }),
    /请填写任务标识/,
  )
})

test('无效任务标识会在调用 Trellis 前被拒绝', async () => {
  const { createTask } = await import('../actions.js')
  await assert.rejects(
    () =>
      createTask({
        repositoryId: 'missing',
        title: '补齐看板任务导出能力',
        description: 'x',
        assignee: 'dev',
        slug: 'Board Export',
      }),
    /任务标识只能包含/,
  )
})

test('大写任务编号标识会保留并继续后续校验', async () => {
  const { createTask } = await import('../actions.js')
  await assert.rejects(
    () =>
      createTask(
        {
          repositoryId: 'missing',
          title: '大写编号任务',
          description: 'x',
          assignee: 'dev',
          slug: 'T100001',
        },
        { listRepositories: () => [] },
      ),
    /仓库不在白名单中/,
  )
})

test('英文标题可以自动生成任务标识并继续后续校验', async () => {
  const { createTask } = await import('../actions.js')
  await assert.rejects(
    () =>
      createTask(
        {
          repositoryId: 'missing',
          title: 'Fix DBXConnectionPool timeout',
          description: 'x',
          assignee: 'dev',
        },
        { listRepositories: () => [] },
      ),
    /仓库不在白名单中/,
  )
})

test('个人版拒绝任意归档后代派发且非归档任务仍可更新', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-archive-assign-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  fs.mkdirSync(path.join(root, '.trellis', 'workspace', 'bob'), { recursive: true })
  const { assignTask } = await import('../actions.js')
  const repositories = () => [{ id: 'demo', name: 'Demo', path: root }]
  const archivedPaths = [
    '.trellis/tasks/archive/2026-11/11-08-old',
    '.trellis/tasks/archive/..hidden',
  ]

  for (const relativeDir of archivedPaths) {
    const taskDir = path.join(root, relativeDir)
    const taskJsonPath = path.join(taskDir, 'task.json')
    fs.mkdirSync(taskDir, { recursive: true })
    // 非法 JSON 证明归档校验发生在读取 task.json 之前。
    fs.writeFileSync(taskJsonPath, '{ invalid')
    await assert.rejects(
      () =>
        assignTask(
          {
            repositoryId: 'demo',
            taskDir: relativeDir,
            assignee: 'bob',
          },
          { listRepositories: repositories },
        ),
      /归档任务只读，不能更新派发/,
    )
    assert.equal(fs.readFileSync(taskJsonPath, 'utf8'), '{ invalid')
  }

  const activeDir = path.join(root, '.trellis', 'tasks', '11-08-active')
  const activeTaskJsonPath = path.join(activeDir, 'task.json')
  fs.mkdirSync(activeDir, { recursive: true })
  fs.writeFileSync(
    activeTaskJsonPath,
    `${JSON.stringify(
      {
        id: 'active',
        title: '进行中任务',
        status: 'in_progress',
        assignee: 'alice',
        creator: 'alice',
      },
      null,
      2,
    )}\n`,
  )

  await assignTask(
    {
      repositoryId: 'demo',
      taskDir: '.trellis/tasks/11-08-active',
      assignee: 'bob',
    },
    { listRepositories: repositories },
  )
  assert.equal(JSON.parse(fs.readFileSync(activeTaskJsonPath, 'utf8')).assignee, 'bob')
})

function hasPython3() {
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** 造一个只记录 argv 的 task.py 桩；`--work-type` 是否“支持”由脚本内容决定。 */
function makeStubRepo({ supportsWorkType = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-actions-stub-'))
  fs.mkdirSync(path.join(root, '.trellis', 'tasks'), { recursive: true })
  fs.mkdirSync(path.join(root, '.trellis', 'workspace', 'alice'), { recursive: true })
  const scripts = path.join(root, '.trellis', 'scripts')
  fs.mkdirSync(scripts, { recursive: true })
  fs.writeFileSync(
    path.join(scripts, 'task.py'),
    [
      'import json, pathlib, sys',
      supportsWorkType ? '# p_create.add_argument("--work-type")' : '# upstream task.py',
      "pathlib.Path(__file__).with_name('argv.json').write_text(json.dumps(sys.argv[1:]), encoding='utf-8')",
      '',
    ].join('\n'),
  )
  return root
}

function readStubArgv(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.trellis', 'scripts', 'argv.json'), 'utf8'))
}

test('taskScriptSupports 依据脚本内容判断扩展参数', async () => {
  const { taskScriptSupports } = await import('../actions.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-actions-probe-'))
  assert.equal(taskScriptSupports(root, '--work-type'), false)
  fs.mkdirSync(path.join(root, '.trellis', 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(root, '.trellis', 'scripts', 'task.py'), 'x = "--work-type"\n')
  assert.equal(taskScriptSupports(root, '--work-type'), true)
})

test('task.py 不支持 --work-type 时创建任务不传该参数', { skip: !hasPython3() }, async () => {
  const { createTask } = await import('../actions.js')
  const root = makeStubRepo({ supportsWorkType: false })
  await createTask(
    {
      repositoryId: 'repo',
      title: 'probe task',
      description: 'probe',
      assignee: 'alice',
      priority: 'P2',
      slug: 'probe-task',
      workType: 'frontend',
    },
    { listRepositories: () => [{ id: 'repo', name: 'repo', path: root }] },
  )
  const argv = readStubArgv(root)
  assert.equal(argv[0], 'create')
  assert.ok(!argv.includes('--work-type'), `argv 不应包含 --work-type: ${argv.join(' ')}`)
})

test('task.py 支持 --work-type 时创建任务照旧传该参数', { skip: !hasPython3() }, async () => {
  const { createTask } = await import('../actions.js')
  const root = makeStubRepo({ supportsWorkType: true })
  await createTask(
    {
      repositoryId: 'repo',
      title: 'probe task',
      description: 'probe',
      assignee: 'alice',
      priority: 'P2',
      slug: 'probe-task',
      workType: 'backend',
    },
    { listRepositories: () => [{ id: 'repo', name: 'repo', path: root }] },
  )
  const argv = readStubArgv(root)
  assert.deepEqual(argv.slice(-2), ['--work-type', 'backend'])
})

test('createTask 把注入的 env 透传给 Python 解析器', { skip: !hasPython3() }, async () => {
  const { createTask } = await import('../actions.js')
  const root = makeStubRepo({ supportsWorkType: false })
  const listRepositories = () => [{ id: 'repo', name: 'repo', path: root }]
  const input = {
    repositoryId: 'repo',
    title: 'probe task',
    description: 'probe',
    assignee: 'alice',
    priority: 'P2',
    slug: 'probe-task',
  }

  // 注入空 PATH：解析器必须用注入的 env 而不是 process.env，否则会用宿主环境里的 Python。
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-actions-empty-path-'))
  const error = await createTask(input, {
    listRepositories,
    env: { PATH: emptyPath, SystemRoot: '', TRELLIS_PYTHON: '' },
  }).then(
    () => null,
    (thrown) => thrown,
  )
  assert.equal(error?.code, PYTHON_UNAVAILABLE)
  assert.equal(
    fs.existsSync(path.join(root, '.trellis', 'scripts', 'argv.json')),
    false,
    '解释器不可用时不应执行 task.py',
  )

  await createTask(input, { listRepositories, env: process.env })
  assert.deepEqual(readStubArgv(root).slice(0, 2), ['create', 'probe task'])
})

function hasGit() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** 桩：记录 argv，并在 create 时真的落一个 branch 为空的任务目录。 */
function makeCreatingStubRepo() {
  const root = makeStubRepo({ supportsWorkType: false })
  fs.writeFileSync(
    path.join(root, '.trellis', 'scripts', 'task.py'),
    [
      'import datetime, json, pathlib, sys',
      'args = sys.argv[1:]',
      'here = pathlib.Path(__file__)',
      "here.with_name('argv.json').write_text(json.dumps(args), encoding='utf-8')",
      "if args and args[0] == 'create':",
      "    slug = args[args.index('--slug') + 1]",
      "    day = datetime.date.today().strftime('%m-%d')",
      "    task_dir = here.parents[2] / '.trellis' / 'tasks' / f'{day}-{slug}'",
      '    task_dir.mkdir(parents=True, exist_ok=True)',
      "    (task_dir / 'task.json').write_text(json.dumps({'slug': slug, 'branch': None}), encoding='utf-8')",
      "    print(f'.trellis/tasks/{task_dir.name}')",
      '',
    ].join('\n'),
  )
  return root
}

test('findCreatedTaskDir 优先取命令输出里的任务目录', async () => {
  const { findCreatedTaskDir } = await import('../actions.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-actions-dir-'))
  const created = path.join(root, '.trellis', 'tasks', '11-25-board-task')
  fs.mkdirSync(created, { recursive: true })
  fs.writeFileSync(path.join(created, 'task.json'), '{}\n')
  assert.equal(
    findCreatedTaskDir(root, 'other-slug', '创建成功 .trellis/tasks/11-25-board-task'),
    '11-25-board-task',
  )
  assert.equal(findCreatedTaskDir(root, 'other-slug', 'no dir here'), '')
})

test('stampCreatedTaskBranch 不覆盖已有分支', async () => {
  const { stampCreatedTaskBranch } = await import('../actions.js')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-actions-branch-'))
  const taskDir = path.join(root, '.trellis', 'tasks', '11-25-board-task')
  fs.mkdirSync(taskDir, { recursive: true })
  const taskJsonPath = path.join(taskDir, 'task.json')
  fs.writeFileSync(
    taskJsonPath,
    `${JSON.stringify({ slug: 'board-task', branch: 'feature/x' }, null, 2)}\n`,
  )
  assert.equal(stampCreatedTaskBranch(root, '11-25-board-task', 'dev'), false)
  assert.equal(JSON.parse(fs.readFileSync(taskJsonPath, 'utf8')).branch, 'feature/x')
})

test('创建任务后按当前检出分支补齐分支归属', { skip: !hasPython3() || !hasGit() }, async () => {
  const { createTask, readCheckedOutBranch } = await import('../actions.js')
  const root = makeCreatingStubRepo()
  execFileSync('git', ['init', '-q', '-b', 'release/1.4', '.'], { cwd: root, stdio: 'ignore' })
  assert.equal(readCheckedOutBranch(root), 'release/1.4')
  await createTask(
    {
      repositoryId: 'repo',
      title: 'probe task',
      description: 'probe',
      assignee: 'alice',
      priority: 'P2',
      slug: 'probe-task',
    },
    { listRepositories: () => [{ id: 'repo', name: 'repo', path: root }] },
  )
  const created = fs
    .readdirSync(path.join(root, '.trellis', 'tasks'))
    .find((name) => name.endsWith('-probe-task'))
  assert.ok(created, '应当落出任务目录')
  const task = JSON.parse(
    fs.readFileSync(path.join(root, '.trellis', 'tasks', created, 'task.json'), 'utf8'),
  )
  assert.equal(task.branch, 'release/1.4')
})
