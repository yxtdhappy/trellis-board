import { spawn } from 'node:child_process'
import path from 'node:path'

export class ProcessError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined)
    this.name = 'ProcessError'
    this.code = options.code ?? null
    this.exitCode = options.exitCode ?? null
    this.signal = options.signal ?? null
    this.timedOut = options.timedOut === true
    this.stdout = options.stdout ?? ''
    this.stderr = options.stderr ?? ''
  }
}

function killProcessTree(child) {
  if (!child.pid) {
    return
  }
  if (process.platform === 'win32') {
    const killerPath = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32',
      'taskkill.exe',
    )
    const killer = spawn(killerPath, ['/pid', String(child.pid), '/T', '/F'], {
      cwd: undefined,
      env: {
        SystemRoot: process.env.SystemRoot || 'C:\\Windows',
        PATH: process.env.PATH || '',
      },
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.on('error', () => {})
    killer.unref()
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // 进程已经退出。
    }
  }
}

export function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxOutputBytes = options.maxOutputBytes ?? 1_048_576
  const detached = process.platform !== 'win32'

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        detached,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(new ProcessError('无法启动子进程', { cause: error }))
      return
    }

    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
    }, timeoutMs)
    timer.unref?.()

    function append(chunks, chunk, currentBytes, streamName) {
      const nextBytes = currentBytes + chunk.length
      if (nextBytes > maxOutputBytes) {
        const remaining = Math.max(0, maxOutputBytes - currentBytes)
        if (remaining > 0) {
          chunks.push(chunk.subarray(0, remaining))
        }
        throw new ProcessError(`${streamName} 超过大小限制`, {
          code: 'OUTPUT_LIMIT',
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        })
      }
      chunks.push(chunk)
      return nextBytes
    }

    child.stdout.on('data', (chunk) => {
      try {
        stdoutBytes = append(stdout, chunk, stdoutBytes, '标准输出')
      } catch (error) {
        killProcessTree(child)
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(error)
        }
      }
    })
    child.stderr.on('data', (chunk) => {
      try {
        stderrBytes = append(stderr, chunk, stderrBytes, '标准错误')
      } catch (error) {
        killProcessTree(child)
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(error)
        }
      }
    })

    child.on('error', (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      reject(new ProcessError('子进程执行失败', { cause: error }))
    })

    child.on('close', (exitCode, signal) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      const result = {
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
      }
      if (timedOut) {
        reject(new ProcessError('子进程执行超时', { ...result, timedOut: true }))
        return
      }
      resolve(result)
    })

    if (options.stdin == null) {
      child.stdin.end()
    } else {
      child.stdin.end(options.stdin)
    }
  })
}

export function buildEnvironment(extra = {}) {
  const allowlist = [
    'PATH',
    'PATHEXT',
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'HOME',
    'APPDATA',
    'LOCALAPPDATA',
    'SSH_AUTH_SOCK',
    'PSModulePath',
  ]
  const environment = {}
  for (const key of allowlist) {
    if (process.env[key] != null) {
      environment[key] = process.env[key]
    }
  }
  return { ...environment, ...extra }
}
