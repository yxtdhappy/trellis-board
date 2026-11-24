import fs from 'node:fs'
import path from 'node:path'
import { CliUsageError, applyEnv, formatEnvSummary, formatHelp, resolveCliEnv } from './lib/cli.mjs'
import { ROOT_DIR, runNodeBin, runSyncCommand } from './lib/proc.mjs'

const COMMAND_OPTIONS = [
  {
    name: 'scope',
    type: 'enum',
    values: [
      'core',
      'plugins',
      'all',
      'server',
      'web',
      'shared',
      'desktop',
      'scripts',
      'rust',
      'lint',
    ],
    default: 'core',
    description:
      '测试范围：core(默认) | plugins | all | server | web | shared | desktop | scripts | rust | lint',
  },
  {
    name: 'file',
    type: 'string',
    repeatable: true,
    description: '按测试文件相对路径子串过滤（可多次指定，也可直接传位置参数）',
  },
  {
    name: 'grep',
    short: 't',
    type: 'string',
    description: '透传给 node --test --test-name-pattern 的用例名正则',
  },
]

let resolved
try {
  resolved = resolveCliEnv({
    command: 'test',
    argv: process.argv.slice(2),
    rootDir: ROOT_DIR,
    commandOptions: COMMAND_OPTIONS,
    allowPositionals: true,
  })
} catch (error) {
  if (error instanceof CliUsageError) {
    console.error(`[test] ${error.message}`)
    process.exit(2)
  }
  throw error
}

if (resolved.help) {
  console.log(
    formatHelp({
      command: 'test',
      usage: 'yarn test [--scope=core|plugins|all|...] [--file=<substr>] [文件过滤词...]',
      summary: '统一测试与质量检查入口（Node 内置测试、插件测试、Rust 测试与代码检查）。',
      commandOptions: COMMAND_OPTIONS,
      examples: [
        'Linux/macOS:  TRELLIS_REAL_ACP=1 yarn test --scope=plugins --file=real.test.js',
        'PowerShell:   $env:TRELLIS_REAL_ACP="1"; yarn test --scope=plugins --file=real.test.js',
        '通用 CLI:     yarn test cli.test.js / yarn test --scope=all / yarn test --scope=lint',
      ],
    }),
  )
  process.exit(0)
}

for (const warning of resolved.warnings) {
  console.warn(warning)
}

applyEnv(process.env, resolved.env, resolved.deletedKeys)

const { scope, file: fileFlags, grep } = resolved.options
const filters = [...fileFlags, ...resolved.positionals].map((item) => item.toLowerCase())

const summary = formatEnvSummary(`[test:${scope}]`, resolved, [
  'TRELLIS_REAL_ACP',
  'TRELLIS_REAL_ACP_AGENT',
])
if (summary) console.log(summary)

function listTestFilesInDir(dirPath) {
  if (!fs.existsSync(dirPath)) return []
  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
    .map((entry) => path.relative(ROOT_DIR, path.join(dirPath, entry.name)).replaceAll('\\', '/'))
    .sort()
}

function listWorkspaceTests(parentDir) {
  const fullParent = path.join(ROOT_DIR, parentDir)
  if (!fs.existsSync(fullParent)) return []
  const dirs = fs
    .readdirSync(fullParent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  return dirs.flatMap((name) => listTestFilesInDir(path.join(fullParent, name, 'test')))
}

function collectFilesForScope(targetScope) {
  if (targetScope === 'core') {
    return [
      ...listWorkspaceTests('packages'),
      ...listTestFilesInDir(path.join(ROOT_DIR, 'scripts', 'test')),
    ]
  }
  if (targetScope === 'plugins') {
    return listWorkspaceTests('plugins')
  }
  if (targetScope === 'all') {
    return [
      ...listWorkspaceTests('packages'),
      ...listTestFilesInDir(path.join(ROOT_DIR, 'scripts', 'test')),
      ...listWorkspaceTests('plugins'),
    ]
  }
  if (targetScope === 'scripts') {
    return listTestFilesInDir(path.join(ROOT_DIR, 'scripts', 'test'))
  }
  return listTestFilesInDir(path.join(ROOT_DIR, 'packages', targetScope, 'test'))
}

if (scope === 'rust') {
  runSyncCommand('cargo', ['test', '--manifest-path', 'packages/desktop/src-tauri/Cargo.toml'], {
    cwd: ROOT_DIR,
    env: process.env,
  })
} else if (scope === 'lint') {
  const webDir = path.join(ROOT_DIR, 'packages', 'web')
  runNodeBin(['oxfmt', 'bin', 'oxfmt'], ['--check', '.'], { cwd: ROOT_DIR, env: process.env })
  runNodeBin(['oxlint', 'bin', 'oxlint'], [], { cwd: webDir, env: process.env })
  runNodeBin(['typescript', 'bin', 'tsc'], ['-b', '--noEmit'], { cwd: webDir, env: process.env })
} else {
  let files = collectFilesForScope(scope)
  if (filters.length > 0) {
    files = files.filter((relPath) =>
      filters.some((pattern) => relPath.toLowerCase().includes(pattern)),
    )
  }
  if (files.length === 0) {
    const filterText = filters.length > 0 ? `（过滤条件: ${filters.join(', ')}）` : ''
    console.error(`[test] scope=${scope} 未匹配到任何测试文件${filterText}`)
    process.exit(2)
  }
  const nodeArgs = ['--test']
  if (grep) nodeArgs.push(`--test-name-pattern=${grep}`)
  nodeArgs.push(...files)
  runSyncCommand(process.execPath, nodeArgs, { cwd: ROOT_DIR, env: process.env })
}
