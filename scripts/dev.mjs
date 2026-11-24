import net from 'node:net'
import path from 'node:path'
import { resolveBoardRootDir } from '../packages/server/config.js'
import { CliUsageError, applyEnv, formatEnvSummary, formatHelp, resolveCliEnv } from './lib/cli.mjs'
import { ROOT_DIR, createProcessGroup, resolveTauriCommand } from './lib/proc.mjs'

const COMMAND_OPTIONS = [
  {
    name: 'mode',
    type: 'enum',
    values: ['full', 'web', 'server', 'desktop'],
    default: 'full',
    description: '启动模式：full(前后端) | web(仅Vite) | server(仅后端) | desktop(桌面联调)',
  },
  {
    name: 'isolate',
    type: 'boolean',
    default: true,
    description: '使用 <用户数据根>-dev 隔离 dev 数据目录（--no-isolate 直连生产目录）',
  },
]

let resolved
try {
  resolved = resolveCliEnv({
    command: 'dev',
    argv: process.argv.slice(2),
    rootDir: ROOT_DIR,
    commandOptions: COMMAND_OPTIONS,
  })
} catch (error) {
  if (error instanceof CliUsageError) {
    console.error(`[dev] ${error.message}`)
    process.exit(2)
  }
  throw error
}

if (resolved.help) {
  console.log(
    formatHelp({
      command: 'dev',
      usage: 'yarn dev [--mode=full|web|server|desktop] [选项]',
      summary: '统一开发入口：按模式启动服务端、Vite 前端与 Tauri 桌面客户端。',
      commandOptions: COMMAND_OPTIONS,
      examples: [
        'Linux/macOS:  TRELLIS_BOARD_PLUGINS_DIR=/tmp/p yarn dev',
        'PowerShell:   $env:TRELLIS_BOARD_PLUGINS_DIR="C:\\tmp\\p"; yarn dev',
        '通用 CLI:     yarn dev --plugins-dir=/tmp/p --port=4500 / yarn dev --mode=desktop',
      ],
    }),
  )
  process.exit(0)
}

for (const warning of resolved.warnings) {
  console.warn(warning)
}

const { mode, isolate } = resolved.options

if (isolate && (mode === 'full' || mode === 'server' || mode === 'desktop')) {
  const devRootDir = `${resolveBoardRootDir({ env: resolved.env })}-dev`
  if (!resolved.env.TRELLIS_BOARD_DATA_DIR) {
    resolved.env.TRELLIS_BOARD_DATA_DIR = path.join(devRootDir, 'server')
    resolved.sources.TRELLIS_BOARD_DATA_DIR = 'default'
  }
  if (!resolved.env.TRELLIS_BOARD_PLUGINS_DIR) {
    resolved.env.TRELLIS_BOARD_PLUGINS_DIR = path.join(devRootDir, 'plugins')
    resolved.sources.TRELLIS_BOARD_PLUGINS_DIR = 'default'
  }
  if (mode === 'desktop' && !resolved.env.TRELLIS_DESKTOP_HOME) {
    resolved.env.TRELLIS_DESKTOP_HOME = path.join(devRootDir, 'data')
    resolved.sources.TRELLIS_DESKTOP_HOME = 'default'
  }
}

if (resolved.sources.TRELLIS_BOARD_BASE_PATH === '.env') {
  resolved.env.TRELLIS_BOARD_BASE_PATH = ''
  resolved.sources.TRELLIS_BOARD_BASE_PATH = 'default'
}

applyEnv(process.env, resolved.env, resolved.deletedKeys)

const webDir = path.join(ROOT_DIR, 'packages', 'web')
const desktopDir = path.join(ROOT_DIR, 'packages', 'desktop')
const viteBin = path.join(ROOT_DIR, 'node_modules', 'vite', 'bin', 'vite.js')
const serverEntry = path.join('packages', 'server', 'index.js')

const summary = formatEnvSummary(`[dev:${mode}]`, resolved, [
  'PORT',
  'TRELLIS_BOARD_BASE_PATH',
  'TRELLIS_BOARD_TRUST_PROXY',
  'VITE_DEV_PORT',
  'VITE_TRELLIS_ROLE',
  'TRELLIS_BOARD_DATA_DIR',
  'TRELLIS_BOARD_PLUGINS_DIR',
  'TRELLIS_CLIENT_UPDATES_DIR',
  'TRELLIS_DESKTOP_HOME',
  'VITE_LOCAL_PLUGIN_PORT',
  'VITE_LOCAL_PLUGIN_TOKEN',
  'VITE_LOCAL_PLUGIN_SECRET',
])
if (summary) console.log(summary)

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

const group = createProcessGroup()

if (mode === 'full') {
  group.spawnChild(process.execPath, ['--watch', serverEntry], { cwd: ROOT_DIR })
  group.spawnChild(process.execPath, [viteBin], { cwd: webDir })
} else if (mode === 'web') {
  group.spawnChild(process.execPath, [viteBin], { cwd: webDir })
} else if (mode === 'server') {
  group.spawnChild(process.execPath, ['--watch', serverEntry], { cwd: ROOT_DIR })
} else if (mode === 'desktop') {
  const boardPort = resolved.env.VITE_DEV_PORT || resolved.env.TRELLIS_BOARD_DEV_PORT || '5200'
  const serverPort = resolved.env.PORT || '4317'
  console.log(
    `[dev:desktop] Board UI http://localhost:${boardPort}（登录页服务器地址填这个，支持 HMR）`,
  )
  if (await listening(serverPort)) {
    console.log(
      `[dev:desktop] 复用已有服务端 http://127.0.0.1:${serverPort}（数据目录由该进程决定，可能不是 dev 数据根）`,
    )
  } else {
    group.spawnChild(process.execPath, ['--watch', serverEntry], { cwd: ROOT_DIR })
  }
  group.spawnChild(process.execPath, [viteBin, '--port', boardPort, '--strictPort'], {
    cwd: webDir,
    env: {
      ...process.env,
      VITE_CACHE_DIR: resolved.env.VITE_CACHE_DIR || 'node_modules/.vite-board',
    },
  })
  const tauri = resolveTauriCommand()
  group.spawnChild(tauri.command, [...tauri.prefixArgs, 'dev'], {
    cwd: desktopDir,
    shell: tauri.shell,
  })
}
