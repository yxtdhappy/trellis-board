/**
 * Python 解释器解析与执行。
 *
 * 桌面客户端启动自检（`packages/desktop/src-tauri/src/agent/env/probe.rs`）会过滤
 * Windows App Execution Alias（0 字节占位文件）并实际跑一次版本探测，把可用解释器
 * 的绝对路径写进 `client.json`，由宿主注入为 `TRELLIS_PYTHON`。宿主侧按名字
 * `spawn('python')` 会重新交给 Windows PATH 解析，可能命中同一批 0 字节别名或
 * ACL 拒绝的文件（`spawn python EACCES`），所以这里按绝对路径重新解析一遍候选，
 * 并在 spawn 失败时继续尝试下一个候选。
 *
 * 顺序与 Rust 自检对齐：`TRELLIS_PYTHON` → PATH → Windows 常见安装目录 →
 * `py -3` → 裸 `python` / `python3` 兜底。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

/** 所有候选都无法 spawn 时使用的稳定错误码（插件协议把 positive code 放进 `data.code`）。 */
export const PYTHON_UNAVAILABLE = 1011

const UNAVAILABLE_MESSAGE =
  '未找到可执行的 Python：请重新运行运行环境初始化，或设置 TRELLIS_PYTHON 指向 python.exe'
// EFTYPE：Windows 上 spawn 0 字节 App Execution Alias 会返回“exec format error”，
// 与 PATH 命中不可执行同名文件的 EACCES 一样必须继续下一个候选。
const RETRYABLE_SPAWN_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EFTYPE'])
const PY_LAUNCHER_TIMEOUT_MS = 10_000
const PY_LAUNCHER_PROBE = 'import sys; print(sys.executable)'

export class PythonUnavailableError extends Error {
  /**
   * @param {Array<{ label: string, source: string, code: string }>} attempts
   */
  constructor(attempts = []) {
    super(UNAVAILABLE_MESSAGE)
    this.name = 'PythonUnavailableError'
    this.code = PYTHON_UNAVAILABLE
    this.attempts = attempts
  }
}

/**
 * 文件存在、是普通文件、大小大于 0（排除 Windows App Execution Alias），POSIX 下还需可执行。
 * 任何 `stat`/`access` 异常都视为不可用。
 */
export function isUsableExecutable(file) {
  if (!file) return false
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size === 0) return false
    if (process.platform !== 'win32') fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function labelFor(command, source) {
  // 只暴露候选名，不回显本机完整路径。
  return source === 'env' ? 'TRELLIS_PYTHON' : path.basename(command)
}

function dedupeKey(command, platform) {
  const normalized = canonicalPath(command).replaceAll('\\', '/')
  return platform === 'win32' ? normalized.toLowerCase() : normalized
}

function canonicalPath(file) {
  const value = String(file)
  if (!path.isAbsolute(value)) return value
  try {
    return fs.realpathSync(value)
  } catch {
    return value
  }
}

function environmentPathDirs(env, platform) {
  const raw = env.PATH || env.Path || ''
  const separator = platform === 'win32' ? ';' : ':'
  return String(raw)
    .split(separator)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function windowsInstallDirs(env) {
  const dirs = []
  const localAppData = String(env.LOCALAPPDATA || '').trim()
  if (localAppData) dirs.push(path.join(localAppData, 'Programs', 'Python'))
  const programFiles = String(env.ProgramFiles || env.PROGRAMFILES || '').trim()
  if (programFiles) dirs.push(programFiles)
  const systemDrive = String(env.SystemDrive || '').trim()
  if (systemDrive) {
    dirs.push(/[\\/]$/.test(systemDrive) ? systemDrive : `${systemDrive}${path.sep}`)
  }
  return dirs
}

function readSubdirectories(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^python/i.test(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .sort((left, right) => right.localeCompare(left, 'en'))
  } catch {
    return []
  }
}

function resolvePyLauncher(env) {
  const systemRoot = String(env.SystemRoot || '').trim()
  const systemLauncher = systemRoot ? path.join(systemRoot, 'py.exe') : ''
  // PATH 里可能先命中 WindowsApps 的 0 字节 py.exe，优先用系统目录里的真实启动器。
  const command = systemLauncher && isUsableExecutable(systemLauncher) ? systemLauncher : 'py'
  try {
    const output = execFileSync(command, ['-3', '-c', PY_LAUNCHER_PROBE], {
      encoding: 'utf8',
      timeout: PY_LAUNCHER_TIMEOUT_MS,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const executable = String(output)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    if (executable && isUsableExecutable(executable)) {
      return { command: executable, prefixArgs: [], resolved: true }
    }
  } catch {
    // 反解失败时退回 `py -3` 直接执行，由 spawn 结果决定是否继续下一个候选。
  }
  return { command, prefixArgs: ['-3'], resolved: false }
}

/**
 * 解析 Python 候选列表（每次调用重新解析，不缓存，避免 Python 被卸载/替换后使用陈旧路径）。
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} [options]
 * @returns {Array<{ command: string, prefixArgs: string[], source: string, label: string }>}
 */
export function resolvePythonCandidates({ env = process.env, platform = process.platform } = {}) {
  const candidates = []
  const seen = new Set()
  let resolvedFromDisk = false

  const add = (command, source, prefixArgs = []) => {
    const key = dedupeKey(command, platform)
    if (!command || seen.has(key)) return
    seen.add(key)
    candidates.push({ command, prefixArgs, source, label: labelFor(command, source) })
  }

  // 1. 显式指定（桌面宿主把 client.json 的 python_runtime.path 注入到这里）。
  //    允许是 `python3` 这类名字，因此不做文件校验，spawn 失败自然进入下一个候选。
  const explicit = String(env.TRELLIS_PYTHON || '').trim()
  if (explicit) add(explicit, 'env')

  // 2. PATH 扫描：Windows 只认 `.exe`，`shell: false` 下 `.cmd`/`.bat` 不能直接执行。
  const names = platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python']
  for (const dir of environmentPathDirs(env, platform)) {
    for (const name of names) {
      const file = path.join(dir, name)
      if (!isUsableExecutable(file)) continue
      add(file, 'path')
      resolvedFromDisk = true
    }
  }

  if (platform === 'win32') {
    // 3. 常见安装目录：`%LOCALAPPDATA%\Programs\Python`、`%ProgramFiles%\Python*`、`%SystemDrive%\Python*`。
    for (const root of windowsInstallDirs(env)) {
      for (const dir of readSubdirectories(root)) {
        const file = path.join(dir, 'python.exe')
        if (!isUsableExecutable(file)) continue
        add(file, 'common-prefix')
        resolvedFromDisk = true
      }
    }

    // 4. `py -3`：只在 PATH / 常见目录都没解析出解释器时探测，避免每次解析都
    //    同步拉起 `py.exe`（Windows 上可能阻塞数百毫秒到 10s）。
    if (!resolvedFromDisk) {
      const launcher = resolvePyLauncher(env)
      add(launcher.command, 'py-launcher', launcher.prefixArgs)
      if (launcher.resolved) resolvedFromDisk = true
    }
  }

  // 5. 裸名字兜底：前面都没解析出可用路径时，兼容非常规安装。
  if (!resolvedFromDisk) {
    for (const name of names) add(name, 'fallback')
  }

  return candidates
}

/** 取第一个候选，供只需要一个解释器的调用方（如 team 工具链预检）使用。 */
export function resolvePython({ env = process.env, platform = process.platform } = {}) {
  const [first] = resolvePythonCandidates({ env, platform })
  return first
}

/**
 * 兼容旧导出：只要命令名，供仍按名字回退的调用方使用。
 *
 * @deprecated 新代码用 `resolvePythonCandidates` / `runPythonScript`；名字回退无法绕开
 *   不可执行的同名文件（`spawn python EACCES`）。
 */
export function pythonCommandCandidates(env = process.env) {
  return resolvePythonCandidates({ env }).map((candidate) => candidate.command)
}

function spawnCandidate(candidate, scriptPath, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(candidate.command, [...candidate.prefixArgs, scriptPath, ...args], {
      cwd,
      windowsHide: true,
      shell: false,
      env: { ...env, PYTHONUTF8: '1' },
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      // 是否换候选取决于 error.code，由 `tryPythonCandidates` 统一判定。
      reject(error)
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      // 脚本已启动但退出码非 0：脚本自身失败，换解释器没有意义，不重试。
      reject(
        new Error(stderr.trim() || stdout.trim() || `${path.basename(scriptPath)} 退出码 ${code}`),
      )
    })
  })
}

/**
 * 用第一个可启动的 Python 执行脚本。
 *
 * spawn 失败（`ENOENT` / `EACCES` / `EPERM` / `EFTYPE`）时继续下一个候选；全部失败抛
 * `PythonUnavailableError`。脚本正常启动但退出码非 0 时直接报错，不重试。
 *
 * @param {string} scriptPath
 * @param {string[]} [args]
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} [options]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
export async function runPythonScript(
  scriptPath,
  args = [],
  { cwd, env = process.env, platform = process.platform } = {},
) {
  const { result } = await tryPythonCandidates(
    (candidate) => spawnCandidate(candidate, scriptPath, args, { cwd, env }),
    { env, platform },
  )
  return result
}

/**
 * 按候选顺序执行一次需要 Python 的操作；`run` 收到候选后自行 spawn/执行。
 *
 * 只有 spawn 失败（`ENOENT` / `EACCES` / `EPERM`）才继续下一个候选；其它错误
 * （包括脚本退出码非 0）原样抛出。全部候选都 spawn 失败时抛
 * `PythonUnavailableError`。
 *
 * @template T
 * @param {(candidate: { command: string, prefixArgs: string[], source: string, label: string }) => Promise<T>} run
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform }} [options]
 * @returns {Promise<{ candidate: { command: string, prefixArgs: string[], source: string, label: string }, result: T }>}
 */
export async function tryPythonCandidates(
  run,
  { env = process.env, platform = process.platform } = {},
) {
  const attempts = []
  for (const candidate of resolvePythonCandidates({ env, platform })) {
    try {
      return { candidate, result: await run(candidate) }
    } catch (error) {
      if (!RETRYABLE_SPAWN_CODES.has(error?.code)) throw error
      attempts.push({ label: candidate.label, source: candidate.source, code: error.code })
    }
  }
  throw new PythonUnavailableError(attempts)
}
