import { spawn } from 'node:child_process'
import { pythonCommandCandidates } from '../python.js'

const OUTPUT_LIMIT = 64 * 1024
const ALLOWED_ENV_KEYS = [
  'PATH',
  'SystemRoot',
  'SystemDrive',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'COMSPEC',
]

export function minimalEnvironment(extra = {}) {
  const env = {}
  for (const key of ALLOWED_ENV_KEYS) {
    if (process.env[key] != null) env[key] = process.env[key]
  }
  return { ...env, ...extra }
}

export function sanitizeProcessOutput(value, { maxBytes = OUTPUT_LIMIT, redact = [] } = {}) {
  let result = String(value || '')
    .replace(/(?:https?|ssh):\/\/[^/\s@]+@/gi, (match) => match.replace(/[^/]+@$/, '***@'))
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***')
  for (const secret of redact) {
    const value = String(secret || '')
    if (value) result = result.split(value).join('[redacted]')
  }
  return result.slice(0, maxBytes)
}

export function terminateTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      shell: false,
      stdio: 'ignore',
    })
    killer.on('error', () => {
      try {
        child.kill()
      } catch {
        // 进程可能已结束。
      }
    })
    return
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // 进程可能已结束。
  }
}

export function runProcess(
  command,
  args,
  {
    cwd,
    env = minimalEnvironment(),
    timeoutMs = 30_000,
    allowFailure = false,
    maxOutputBytes = OUTPUT_LIMIT,
    redact = [],
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let stdoutStored = 0
    let stderrStored = 0
    let truncated = false
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      terminateTree(child)
      reject(new Error(`${command} 执行超过 ${timeoutMs}ms，已终止`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      const remaining = maxOutputBytes - stdoutStored
      if (remaining > 0) {
        const next = chunk.subarray(0, remaining)
        stdout.push(next)
        stdoutStored += next.length
      }
      if (stdoutBytes > maxOutputBytes) truncated = true
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length
      const remaining = maxOutputBytes - stderrStored
      if (remaining > 0) {
        const next = chunk.subarray(0, remaining)
        stderr.push(next)
        stderrStored += next.length
      }
      if (stderrBytes > maxOutputBytes) truncated = true
    })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const candidates = command === 'python' ? pythonCommandCandidates(env) : []
      const next = candidates[candidates.indexOf('python') + 1]
      if (error.code === 'ENOENT' && next) {
        runProcess(next, args, {
          cwd,
          env,
          timeoutMs,
          allowFailure,
          maxOutputBytes,
          redact,
        }).then(resolve, reject)
        return
      }
      reject(error)
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const result = {
        code,
        signal,
        stdout: sanitizeProcessOutput(Buffer.concat(stdout).toString('utf8'), {
          maxBytes: maxOutputBytes,
          redact,
        }),
        stderr: sanitizeProcessOutput(Buffer.concat(stderr).toString('utf8'), {
          maxBytes: maxOutputBytes,
          redact,
        }),
        truncated,
      }
      if (code === 0 || allowFailure) {
        resolve(result)
        return
      }
      reject(new Error(result.stderr.trim() || result.stdout.trim() || `${command} 退出码 ${code}`))
    })
  })
}
