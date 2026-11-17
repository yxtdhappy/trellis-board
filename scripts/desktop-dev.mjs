import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'

const rootDir = path.resolve(import.meta.dirname, '..')
const webDir = path.join(rootDir, 'packages', 'web')
const desktopDir = path.join(rootDir, 'packages', 'desktop')
const boardPort = process.env.TRELLIS_BOARD_DEV_PORT || '5200'
const serverPort = process.env.PORT || '4317'
const children = []
let stopping = false

function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(port) })
    socket.setTimeout(500)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

function stop(code) {
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

function run(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, stdio: 'inherit', env: env ?? process.env })
  child.on('exit', (code) => stop(code ?? 0))
  children.push(child)
  return child
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

console.log(`[desktop:dev] Board UI  http://localhost:${boardPort}（登录页服务器地址填这个，支持 HMR）`)
if (await listening(serverPort)) {
  console.log(`[desktop:dev] 复用已有服务端 http://127.0.0.1:${serverPort}`)
} else {
  run(process.execPath, ['--watch', path.join('packages', 'server', 'index.js')], rootDir)
}
run(
  process.execPath,
  [path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js'), '--port', boardPort, '--strictPort'],
  webDir,
  { ...process.env, VITE_CACHE_DIR: 'node_modules/.vite-board' },
)
run('cargo', ['tauri', 'dev'], desktopDir)
