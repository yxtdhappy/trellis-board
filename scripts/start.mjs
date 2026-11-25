import { CliUsageError, applyEnv, formatEnvSummary, formatHelp, resolveCliEnv } from './lib/cli.mjs'
import { ROOT_DIR } from './lib/proc.mjs'

let resolved
try {
  resolved = resolveCliEnv({
    command: 'start',
    argv: process.argv.slice(2),
    rootDir: ROOT_DIR,
  })
} catch (error) {
  if (error instanceof CliUsageError) {
    console.error(`[start] ${error.message}`)
    process.exit(2)
  }
  throw error
}

if (resolved.help) {
  console.log(
    formatHelp({
      command: 'start',
      usage: 'yarn start [选项]',
      summary: '启动 Trellis Board Team 服务端（同进程加载，支持 CLI 参数与跨平台环境变量）。',
    }),
  )
  process.exit(0)
}

for (const warning of resolved.warnings) {
  console.warn(warning)
}

applyEnv(process.env, resolved.env, resolved.deletedKeys)

const summary = formatEnvSummary('[start]', resolved, [
  'PORT',
  'TRELLIS_BOARD_APP_NAME',
  'TRELLIS_BOARD_BASE_PATH',
  'TRELLIS_BOARD_TRUST_PROXY',
  'TRELLIS_BOARD_DATA_DIR',
  'TRELLIS_BOARD_PLUGINS_DIR',
  'TRELLIS_CLIENT_UPDATES_DIR',
  'TRELLIS_WATCH_DEBOUNCE_MS',
])
if (summary) console.log(summary)

const { runServerEntry } = await import('../packages/server/index.js')
runServerEntry()
