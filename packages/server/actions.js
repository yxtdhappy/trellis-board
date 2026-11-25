import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { pythonCommandCandidates } from './python.js'
import { getRepositories } from './repositories.js'
import { slugifyTaskTitle, TASK_SLUG_PATTERN } from '@trellis-board/shared/slug.js'
import { isWorkType, WORK_TYPE_IDS } from '@trellis-board/shared/work-types.js'

const ALLOWED_PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3'])
const WORK_TYPE_FLAG = '--work-type'
const CREATED_TASK_DIR_PATTERN = /\.trellis[\\/]tasks[\\/]([A-Za-z0-9._-]+)/

function cleanText(value, label, maxLength) {
  if (typeof value !== 'string') throw new Error(`${label}必须是字符串`)
  const clean = value.trim()
  if (!clean) throw new Error(`${label}不能为空`)
  if (clean.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符`)
  return clean
}

function isPathInside(target, parent) {
  const relative = path.relative(parent, target)
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  )
}

/**
 * 目标仓库的 task.py 是否支持某个扩展参数。
 *
 * `--work-type` 是 trellis-board 在 `.trellis/scripts/task.py` 里加的本地扩展，
 * 上游 Trellis 0.6.17 的 task.py 没有它；传过去会被 argparse 以
 * `unrecognized arguments` 拒掉整条命令，任务建不出来。
 */
export function taskScriptSupports(repoPath, flag) {
  try {
    const script = path.join(repoPath, '.trellis', 'scripts', 'task.py')
    return fs.readFileSync(script, 'utf8').includes(flag)
  } catch {
    return false
  }
}

/**
 * 找出 task.py create 刚建好的任务目录（相对 `.trellis/tasks`）。
 *
 * 优先从命令输出里取，输出没有目录行时退回 `MM-DD-<slug>` 约定。
 */
export function findCreatedTaskDir(repoPath, slug, output) {
  const tasksRoot = path.join(repoPath, '.trellis', 'tasks')
  const candidates = []
  const matched = typeof output === 'string' ? output.match(CREATED_TASK_DIR_PATTERN) : null
  if (matched) candidates.push(matched[1])
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  candidates.push(`${month}-${day}-${slug}`)
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(tasksRoot, candidate, 'task.json'))) return candidate
  }
  return ''
}

/** 目标仓库当前检出的分支；分离 HEAD、非 git 仓库或 git 不可用时返回空串。 */
export function readCheckedOutBranch(repoPath) {
  try {
    const branch = execFileSync('git', ['-C', repoPath, 'branch', '--show-current'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return branch.trim()
  } catch {
    return ''
  }
}

/**
 * 给新建任务补上分支归属。
 *
 * `task.py create` 把 `branch` 写成 null（`common/task_store.py` 的初始 dict），
 * 只有 `task.py start` / `set-branch` 才会填。插件下发固定带 `--no-start`，于是
 * 新建任务没有分支归属：首次上传时服务端校验任务目录后整批拒绝
 * `TASK_OWNERSHIP_REQUIRED`，看板上就变成需要手动选分支的"未归属任务"。
 * 创建后按当前检出分支补齐，已经写过的分支保持不变。
 */
export function stampCreatedTaskBranch(repoPath, taskDir, branch) {
  if (!taskDir || !branch) return false
  const taskJsonPath = path.join(repoPath, '.trellis', 'tasks', taskDir, 'task.json')
  let task
  try {
    task = JSON.parse(fs.readFileSync(taskJsonPath, 'utf8'))
  } catch {
    return false
  }
  if (task.branch) return false
  task.branch = branch
  const temporaryPath = `${taskJsonPath}.${process.pid}.tmp`
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(task, null, 2)}\n`, 'utf8')
    fs.renameSync(temporaryPath, taskJsonPath)
    return true
  } catch {
    try {
      fs.rmSync(temporaryPath, { force: true })
    } catch {
      // 清理临时文件的失败不影响创建结果
    }
    return false
  }
}

function runTaskPython(repoPath, args) {
  const script = path.join(repoPath, '.trellis', 'scripts', 'task.py')
  if (!fs.existsSync(script)) throw new Error('仓库没有 .trellis/scripts/task.py')
  return new Promise((resolve, reject) => {
    const candidates = pythonCommandCandidates(process.env)
    let index = 0
    const attempt = () => {
      const command = candidates[index]
      const child = spawn(command, [script, ...args], {
        cwd: repoPath,
        windowsHide: true,
        shell: false,
        env: { ...process.env, PYTHONUTF8: '1' },
      })
      let stdout = ''
      let stderr = ''
      let failed = false
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })
      child.on('error', (error) => {
        failed = true
        if (error.code === 'ENOENT' && index + 1 < candidates.length) {
          index += 1
          attempt()
          return
        }
        reject(error)
      })
      child.on('close', (code) => {
        if (failed) return
        if (code === 0) resolve({ stdout, stderr })
        else reject(new Error(stderr.trim() || stdout.trim() || `task.py 退出码 ${code}`))
      })
    }
    attempt()
  })
}

export async function createTask(input, { listRepositories = getRepositories } = {}) {
  const repositoryId = cleanText(input.repositoryId, '仓库', 200)
  const title = cleanText(input.title, '任务标题', 200)
  const description = cleanText(input.description, '任务描述', 3000)
  const assignee = cleanText(input.assignee, '负责人', 100)
  const priority = cleanText(input.priority || 'P2', '优先级', 2)
  if (!ALLOWED_PRIORITIES.has(priority)) throw new Error('优先级只能是 P0、P1、P2、P3')
  const workType =
    input.workType == null || input.workType === '' ? '' : cleanText(input.workType, '任务类型', 20)
  if (workType && !isWorkType(workType)) {
    throw new Error(`任务类型只能是 ${WORK_TYPE_IDS.join('、')}`)
  }
  const requestedSlug =
    input.slug == null || input.slug === '' ? '' : cleanText(input.slug, '任务标识', 100)
  const slug = requestedSlug || slugifyTaskTitle(title)
  if (!slug) {
    throw new Error('当前标题没有可用的英文标识，请填写任务标识，例如 board-task-export')
  }
  if (!TASK_SLUG_PATTERN.test(slug)) {
    throw new Error('任务标识只能包含英文字母、数字和单个中划线，例如 T100001 或 board-task-export')
  }
  const repo = listRepositories().find((candidate) => candidate.id === repositoryId)
  if (!repo) throw new Error(`仓库不在白名单中: ${repositoryId}`)
  if (!fs.existsSync(path.join(repo.path, '.trellis', 'tasks'))) {
    throw new Error('目标目录不是有效的 Trellis 仓库')
  }
  const workspace = path.join(repo.path, '.trellis', 'workspace', assignee)
  if (!fs.existsSync(workspace)) {
    throw new Error(
      `负责人 ${assignee} 尚未初始化 Trellis workspace；请先在目标仓库运行 init_developer.py ${assignee}`,
    )
  }

  const args = [
    'create',
    title,
    '--description',
    description,
    '--assignee',
    assignee,
    '--priority',
    priority,
    '--slug',
    slug,
    '--no-start',
  ]
  if (workType && taskScriptSupports(repo.path, WORK_TYPE_FLAG)) {
    // 目标仓库的 task.py 不支持该扩展参数时静默跳过：任务仍会建出来，
    // 只是 task.json 里没有 work_type，看板回退到 meta 里的类型来源。
    args.push(WORK_TYPE_FLAG, workType)
  }
  if (input.parentDir) args.push('--parent', cleanText(input.parentDir, '父任务目录', 1000))
  if (input.baseBranch) args.push('--base-branch', cleanText(input.baseBranch, '目标分支', 200))
  if (input.packageName) args.push('--package', cleanText(input.packageName, '包名', 100))

  const output = await runTaskPython(repo.path, args)
  const createdDir = findCreatedTaskDir(repo.path, slug, output.stdout)
  stampCreatedTaskBranch(repo.path, createdDir, readCheckedOutBranch(repo.path))
  return { repository: repo, output }
}

export async function assignTask(input, { listRepositories = getRepositories } = {}) {
  const taskPath = cleanText(input.taskDir, '任务目录', 1000)
  const repositoryId = cleanText(input.repositoryId, '仓库', 200)
  const assignee = cleanText(input.assignee, '负责人', 100)
  const repo = listRepositories().find((candidate) => candidate.id === repositoryId)
  if (!repo) throw new Error(`仓库不在白名单中: ${repositoryId}`)
  if (!fs.existsSync(path.join(repo.path, '.trellis', 'workspace', assignee))) {
    throw new Error(`负责人 ${assignee} 尚未初始化 Trellis workspace`)
  }
  const fullTaskPath = path.resolve(repo.path, taskPath)
  const tasksRoot = path.resolve(repo.path, '.trellis', 'tasks')
  if (!isPathInside(fullTaskPath, tasksRoot)) {
    throw new Error('任务目录必须在目标仓库的 .trellis/tasks 下')
  }
  if (isPathInside(fullTaskPath, path.join(tasksRoot, 'archive'))) {
    throw new Error('归档任务只读，不能更新派发')
  }

  const taskJsonPath = path.join(fullTaskPath, 'task.json')
  let task
  try {
    task = JSON.parse(fs.readFileSync(taskJsonPath, 'utf8'))
  } catch (error) {
    throw new Error(`无法读取 task.json: ${error.message}`)
  }
  task.assignee = assignee
  const temporaryPath = `${taskJsonPath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(task, null, 2)}\n`, 'utf8')
  fs.renameSync(temporaryPath, taskJsonPath)
  return { taskPath, assignee }
}
