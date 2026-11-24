import path from 'node:path'
import { CliUsageError, applyEnv, formatEnvSummary, formatHelp, resolveCliEnv } from './lib/cli.mjs'
import {
  ROOT_DIR,
  resolvePowerShellCommand,
  resolveTauriCommand,
  runNodeBin,
  runSyncCommand,
} from './lib/proc.mjs'

const COMMAND_OPTIONS = [
  {
    name: 'target',
    type: 'enum',
    values: ['web', 'desktop-ui', 'desktop', 'portable', 'all'],
    default: 'web',
    description: '构建目标：web | desktop-ui | desktop | portable | all',
  },
  {
    name: 'skip-typecheck',
    type: 'boolean',
    default: false,
    description: '跳过 tsc -b 类型检查',
  },
  {
    name: 'skip-ui',
    type: 'boolean',
    default: false,
    description: '--target=desktop 时跳过前置构建 desktop-ui',
  },
]

let resolved
try {
  resolved = resolveCliEnv({
    command: 'build',
    argv: process.argv.slice(2),
    rootDir: ROOT_DIR,
    commandOptions: COMMAND_OPTIONS,
  })
} catch (error) {
  if (error instanceof CliUsageError) {
    console.error(`[build] ${error.message}`)
    process.exit(2)
  }
  throw error
}

if (resolved.help) {
  console.log(
    formatHelp({
      command: 'build',
      usage: 'yarn build [--target=web|desktop-ui|desktop|portable|all] [选项]',
      summary: '统一构建入口：构建服务端 Web 页面、桌面登录壳、Tauri 客户端与便携 ZIP 包。',
      commandOptions: COMMAND_OPTIONS,
      examples: [
        'Linux/macOS:  VITE_TRELLIS_ROLE=client yarn build',
        'PowerShell:   $env:TRELLIS_UPDATE_SERVER="https://example.com"; yarn build --target=desktop',
        '通用 CLI:     yarn build --role=client / yarn build --target=all',
      ],
    }),
  )
  process.exit(0)
}

for (const warning of resolved.warnings) {
  console.warn(warning)
}

applyEnv(process.env, resolved.env, resolved.deletedKeys)

const { target, 'skip-typecheck': skipTypecheck, 'skip-ui': skipUi } = resolved.options
const webDir = path.join(ROOT_DIR, 'packages', 'web')
const desktopDir = path.join(ROOT_DIR, 'packages', 'desktop')

const summary = formatEnvSummary(`[build:${target}]`, resolved, [
  'VITE_TRELLIS_ROLE',
  'TRELLIS_UPDATE_SERVER',
])
if (summary) console.log(summary)

function runTypecheck() {
  if (skipTypecheck) return
  runNodeBin(['typescript', 'bin', 'tsc'], ['-b'], { cwd: webDir, env: process.env })
}

function buildWeb({ runTsc = true } = {}) {
  if (runTsc) runTypecheck()
  runNodeBin(['vite', 'bin', 'vite.js'], ['build'], { cwd: webDir, env: process.env })
}

function buildDesktopUi({ runTsc = true } = {}) {
  if (target === 'desktop-ui' && resolved.sources.VITE_TRELLIS_ROLE === 'cli') {
    console.warn('[build] desktop-ui 由桌面壳在运行时注入角色，已忽略 --role')
  }
  if (runTsc) runTypecheck()
  const desktopUiEnv = { ...process.env }
  delete desktopUiEnv.VITE_TRELLIS_ROLE
  runNodeBin(['vite', 'bin', 'vite.js'], ['build', '--config', 'vite.desktop.config.ts'], {
    cwd: webDir,
    env: desktopUiEnv,
  })
}

function buildDesktopBinary() {
  if (!skipUi) buildDesktopUi()
  const tauri = resolveTauriCommand()
  runSyncCommand(tauri.command, [...tauri.prefixArgs, 'build'], {
    cwd: desktopDir,
    env: process.env,
    shell: tauri.shell,
  })
}

function packagePortable() {
  const ps = resolvePowerShellCommand()
  if (!ps) {
    console.error('[build] 未找到 pwsh 或 Windows PowerShell，无法打包便携包')
    process.exit(1)
  }
  const scriptPath = path.join(desktopDir, 'package-portable.ps1')
  runSyncCommand(ps.command, [...ps.prefixArgs, '-File', scriptPath], {
    cwd: ROOT_DIR,
    env: process.env,
  })
}

if (target === 'web') {
  buildWeb()
} else if (target === 'desktop-ui') {
  buildDesktopUi()
} else if (target === 'all') {
  buildWeb({ runTsc: true })
  buildDesktopUi({ runTsc: false })
} else if (target === 'desktop') {
  buildDesktopBinary()
} else if (target === 'portable') {
  packagePortable()
}
