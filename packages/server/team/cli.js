import '../env-bootstrap.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { databaseFile as defaultDatabaseFile, parseTeamConfig } from '../config.js'
import { migrateLegacyRuntimeData } from '../data-migration.js'
import { openDatabase } from '../database.js'
import { createUser, hasActiveAdmin, listUsers } from './auth.js'

function parseArguments(argv) {
  const [command = 'help', ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (!value.startsWith('--')) throw new Error(`未知参数: ${value}`)
    const key = value.slice(2)
    const next = rest[index + 1]
    if (!next || next.startsWith('--')) {
      options[key] = true
    } else {
      options[key] = next
      index += 1
    }
  }
  return { command, options }
}

function readHidden(question) {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let value = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk) => {
        value += chunk
      })
      process.stdin.on('end', () => resolve(value.split(/\r?\n/)[0]))
      process.stdin.resume()
    })
  }
  return new Promise((resolve, reject) => {
    process.stderr.write(question)
    let value = ''
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    const finish = (error = null) => {
      process.stdin.off('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stderr.write('\n')
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\u0003') {
          finish(new Error('已取消'))
          return
        }
        if (char === '\r' || char === '\n') {
          finish()
          return
        }
        if (char === '\u007f' || char === '\b') {
          value = Array.from(value).slice(0, -1).join('')
        } else {
          value += char
        }
      }
    }
    process.stdin.on('data', onData)
  })
}

async function readPassword() {
  const first = await readHidden('管理员密码（输入不回显）: ')
  const second = await readHidden('再次输入管理员密码: ')
  if (first !== second) throw new Error('两次输入的密码不一致')
  return first
}

export async function initFirstAdmin({ config, databaseFile, username, displayName, password }) {
  if (config?.mode !== 'team') {
    throw new Error('首管理员只能在 team 模式配置下初始化')
  }
  const db = openDatabase({
    databaseFile,
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
  })
  try {
    if (hasActiveAdmin(db)) {
      throw new Error('系统已有有效管理员，拒绝重复初始化')
    }
    return await createUser(db, {
      username,
      displayName: displayName || username,
      password,
      systemAdmin: true,
      mustChangePassword: true,
    })
  } finally {
    db.close()
  }
}

export function diagnose({ config, databaseFile }) {
  const db = openDatabase({
    databaseFile,
    fallbackRepositories: [],
    importLegacyRepositories: false,
    legacyJsonImport: false,
  })
  try {
    const integrity = db.prepare('PRAGMA integrity_check').get()
    return {
      mode: config.mode,
      schemaVersion:
        db
          .prepare(`
        SELECT value FROM app_meta WHERE key = 'schema_version'
      `)
          .get()?.value || null,
      journalMode: db.prepare('PRAGMA journal_mode').get()?.journal_mode || null,
      integrity: Object.values(integrity || {})[0] || null,
      activeAdmin: hasActiveAdmin(db),
      users: listUsers(db).length,
      projects: Number(
        db
          .prepare(`
        SELECT COUNT(*) AS count FROM team_project
      `)
          .get().count,
      ),
      agents: Number(
        db
          .prepare(`
        SELECT COUNT(*) AS count FROM agent_device WHERE status = 'active'
      `)
          .get().count,
      ),
    }
  } finally {
    db.close()
  }
}

function usage() {
  process.stdout.write(
    [
      '用法:',
      '  node packages/server/team/cli.js init-admin --username <登录名> [--display-name <显示名>]',
      '  node packages/server/team/cli.js status',
      '',
      '环境变量:',
      '  TRELLIS_BOARD_DATA_DIR=<运行数据目录>',
      '  TRELLIS_BOARD_MODE=team',
      '  TRELLIS_BOARD_ALLOW_LOCAL_GIT_REMOTES=<true|false>',
      '  PORT=<监听端口，默认 4317>',
      '',
    ].join('\n'),
  )
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArguments(argv)
  if (command === 'help' || command === '--help' || command === '-h') {
    usage()
    return
  }
  const config = parseTeamConfig(process.env)
  const databaseFile = options.database
    ? path.resolve(String(options.database))
    : defaultDatabaseFile
  if (!options.database) migrateLegacyRuntimeData()
  if (command === 'init-admin') {
    const username = String(options.username || '').trim()
    if (!username) throw new Error('init-admin 必须提供 --username')
    const user = await initFirstAdmin({
      config,
      databaseFile,
      username,
      displayName: options['display-name'] ? String(options['display-name']) : username,
      password: await readPassword(),
    })
    process.stdout.write(
      JSON.stringify(
        {
          created: true,
          userId: user.id,
          username: user.username,
          mustChangePassword: user.mustChangePassword,
        },
        null,
        2,
      ) + '\n',
    )
    return
  }
  if (command === 'status' || command === 'diagnose') {
    process.stdout.write(
      JSON.stringify(
        diagnose({
          config,
          databaseFile,
        }),
        null,
        2,
      ) + '\n',
    )
    return
  }
  usage()
  throw new Error(`未知命令: ${command}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
