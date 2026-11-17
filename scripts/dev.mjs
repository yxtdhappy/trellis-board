import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { resolveBoardRootDir } from '../packages/server/config.js'

// dev 数据根与生产用户目录隔离；显式设置同名环境变量可指回生产数据。
const devRootDir = `${resolveBoardRootDir()}-dev`
process.env.TRELLIS_BOARD_DATA_DIR ||= path.join(devRootDir, 'server')
process.env.TRELLIS_BOARD_PLUGINS_DIR ||= path.join(devRootDir, 'plugins')

const rootDir = path.resolve(import.meta.dirname, '..')
const webDir = path.join(rootDir, 'packages', 'web')
const children = []
let stopping = false

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

function run(args, cwd) {
  const child = spawn(process.execPath, args, { cwd, stdio: 'inherit' })
  child.on('exit', (code) => stop(code ?? 0))
  children.push(child)
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

console.log(`[dev] 运行数据 ${process.env.TRELLIS_BOARD_DATA_DIR}`)
run(['--watch', path.join('packages', 'server', 'index.js')], rootDir)
run([path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js')], webDir)
