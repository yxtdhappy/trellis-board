import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'

export const ROOT_DIR = path.resolve(import.meta.dirname, '..', '..')

export function runNodeBin(pkgBinParts, args, { cwd = ROOT_DIR, env = process.env } = {}) {
  const binPath = path.join(ROOT_DIR, 'node_modules', ...pkgBinParts)
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd,
    stdio: 'inherit',
    env,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

export function runSyncCommand(
  command,
  args,
  { cwd = ROOT_DIR, env = process.env, shell = false } = {},
) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env,
    shell,
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

export function commandAvailable(command, checkArgs = ['--version'], { shell = false } = {}) {
  const result = spawnSync(command, checkArgs, {
    stdio: 'ignore',
    shell,
  })
  return !result.error && result.status === 0
}

export function resolveTauriCommand() {
  const winShell = process.platform === 'win32'
  if (commandAvailable('tauri', ['--version'], { shell: winShell })) {
    return { command: 'tauri', prefixArgs: [], shell: winShell }
  }
  return { command: 'cargo', prefixArgs: ['tauri'], shell: false }
}

export function resolvePowerShellCommand() {
  if (commandAvailable('pwsh', ['-Version'])) {
    return {
      command: 'pwsh',
      prefixArgs:
        process.platform === 'win32'
          ? ['-NoProfile', '-ExecutionPolicy', 'Bypass']
          : ['-NoProfile'],
    }
  }
  if (
    process.platform === 'win32' &&
    commandAvailable('powershell', ['-NoProfile', '-Command', 'exit 0'])
  ) {
    return {
      command: 'powershell',
      prefixArgs: ['-NoProfile', '-ExecutionPolicy', 'Bypass'],
    }
  }
  return null
}

export function createProcessGroup() {
  const children = []
  let stopping = false
  let signalsBound = false

  function stop(code = 0) {
    if (stopping) return
    stopping = true
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        child.kill('SIGTERM')
      }
    }
    process.exit(code)
  }

  function bindSignals() {
    if (signalsBound) return
    signalsBound = true
    process.on('SIGINT', () => stop(0))
    process.on('SIGTERM', () => stop(0))
  }

  function spawnChild(command, args, { cwd = ROOT_DIR, env = process.env, shell = false } = {}) {
    bindSignals()
    const child = spawn(command, args, { cwd, stdio: 'inherit', env, shell })
    child.on('exit', (code) => stop(code ?? 0))
    children.push(child)
    return child
  }

  return { spawnChild, stop }
}
