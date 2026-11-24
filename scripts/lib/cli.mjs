import fs from 'node:fs'
import path from 'node:path'
import { ENV_SCHEMA, envToFlag, getSchemaForScope } from './env-schema.mjs'

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const SENSITIVE_KEY_PATTERN = /(TOKEN|SECRET|PASSWORD|KEY)/i

export class CliUsageError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CliUsageError'
  }
}

export function parseDotEnvText(text) {
  const result = {}
  const lines = String(text ?? '').split(/\r?\n/)
  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const line = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed
    const eqIndex = line.indexOf('=')
    if (eqIndex <= 0) continue
    const key = line.slice(0, eqIndex).trim()
    if (!ENV_KEY_PATTERN.test(key)) continue
    let value = line.slice(eqIndex + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      const quote = value[0]
      value = value.slice(1, -1)
      if (quote === '"') {
        value = value
          .replaceAll('\\n', '\n')
          .replaceAll('\\r', '\r')
          .replaceAll('\\t', '\t')
          .replaceAll('\\"', '"')
          .replaceAll('\\\\', '\\')
      }
    } else {
      const commentIndex = value.search(/\s+#/)
      if (commentIndex !== -1) {
        value = value.slice(0, commentIndex).trim()
      }
    }
    result[key] = value
  }
  return result
}

export function loadEnvFile(filePath, { required = false } = {}) {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    return { file: filePath, loaded: true, values: parseDotEnvText(content) }
  } catch (error) {
    if (!required && error?.code === 'ENOENT') {
      return { file: filePath, loaded: false, values: {} }
    }
    throw new CliUsageError(`无法读取环境文件 ${filePath}：${error?.message || error}`)
  }
}

function levenshtein(a, b) {
  const m = a.length
  const n = b.length
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i += 1) dp[i][0] = i
  for (let j = 0; j <= n; j += 1) dp[0][j] = j
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}

function suggestFlags(flagName, candidates) {
  const clean = flagName.replace(/^--/, '')
  const scored = []
  for (const candidate of candidates) {
    const dist = levenshtein(clean, candidate.replace(/^--/, ''))
    if (dist <= 3) scored.push({ candidate, dist })
  }
  scored.sort((a, b) => a.dist - b.dist || a.candidate.localeCompare(b.candidate))
  return [...new Set(scored.map((item) => item.candidate))].slice(0, 3)
}

function parseBooleanValue(raw, flagName) {
  if (raw === true || raw === undefined) return true
  const normalized = String(raw).trim().toLowerCase()
  if (normalized === '' || normalized === 'true' || normalized === '1') return true
  if (normalized === 'false' || normalized === '0') return false
  throw new CliUsageError(`参数 --${flagName} 只接受 true/false/1/0，收到: ${raw}`)
}

function validateSchemaValue(entry, rawValue, { cwd, flagLabel }) {
  if (entry.type === 'boolean') {
    const boolVal = parseBooleanValue(rawValue, flagLabel)
    if (entry.presenceOnly) {
      return boolVal ? { delete: false, value: entry.trueValue || '1' } : { delete: true }
    }
    return {
      delete: false,
      value: boolVal ? entry.trueValue || 'true' : entry.falseValue || 'false',
    }
  }

  const text = String(rawValue ?? '')
  if (!text) {
    throw new CliUsageError(`参数 --${flagLabel} 不能为空`)
  }

  if (entry.type === 'path') {
    return { delete: false, value: path.resolve(cwd, text) }
  }

  if (entry.type === 'port') {
    const num = Number(text)
    if (!Number.isInteger(num) || num < 1 || num > 65535) {
      throw new CliUsageError(`参数 --${flagLabel} 必须是 1 到 65535 的整数，收到: ${text}`)
    }
    return { delete: false, value: String(num) }
  }

  if (entry.type === 'int') {
    const num = Number(text)
    const min = entry.min ?? Number.MIN_SAFE_INTEGER
    const max = entry.max ?? Number.MAX_SAFE_INTEGER
    if (!Number.isInteger(num) || num < min || num > max) {
      throw new CliUsageError(`参数 --${flagLabel} 必须是 ${min} 到 ${max} 的整数，收到: ${text}`)
    }
    return { delete: false, value: String(num) }
  }

  if (entry.type === 'enum') {
    if (!entry.values.includes(text)) {
      throw new CliUsageError(
        `参数 --${flagLabel} 无效值: ${text}（只接受 ${entry.values.join(' | ')}）`,
      )
    }
    return { delete: false, value: text }
  }

  return { delete: false, value: text }
}

function parseCommandOptionValue(opt, rawValue) {
  if (opt.type === 'boolean') {
    return parseBooleanValue(rawValue, opt.name)
  }
  const text = String(rawValue ?? '')
  if (!text) {
    throw new CliUsageError(`参数 --${opt.name} 不能为空`)
  }
  if (opt.type === 'enum' && !opt.values.includes(text)) {
    throw new CliUsageError(
      `参数 --${opt.name} 无效值: ${text}（只接受 ${opt.values.join(' | ')}）`,
    )
  }
  return text
}

function readNextValue(argv, index, token, flagLabel) {
  const eqIndex = token.indexOf('=')
  if (eqIndex !== -1) {
    return { value: token.slice(eqIndex + 1), nextIndex: index }
  }
  if (index + 1 >= argv.length) {
    throw new CliUsageError(`参数 ${flagLabel} 缺少值`)
  }
  return { value: argv[index + 1], nextIndex: index + 1 }
}

function buildOptionTables(command, commandOptions) {
  const schemaEntries = getSchemaForScope(command)
  const schemaFlagMap = new Map()
  const allFlagNames = ['--help', '--env', '--env-file']

  for (const entry of schemaEntries) {
    const fullFlag = envToFlag(entry.env)
    schemaFlagMap.set(entry.flag, entry)
    schemaFlagMap.set(fullFlag, entry)
    allFlagNames.push(`--${entry.flag}`)
    if (fullFlag !== entry.flag) allFlagNames.push(`--${fullFlag}`)
    if (entry.type === 'boolean') {
      allFlagNames.push(`--no-${entry.flag}`)
      if (fullFlag !== entry.flag) allFlagNames.push(`--no-${fullFlag}`)
    }
  }

  const cmdFlagMap = new Map()
  const cmdShortMap = new Map()
  for (const opt of commandOptions) {
    cmdFlagMap.set(opt.name, opt)
    allFlagNames.push(`--${opt.name}`)
    if (opt.type === 'boolean') {
      allFlagNames.push(`--no-${opt.name}`)
    }
    if (opt.short) {
      cmdShortMap.set(opt.short, opt)
    }
  }

  return { schemaEntries, schemaFlagMap, cmdFlagMap, cmdShortMap, allFlagNames }
}

export function resolveCliEnv({
  command,
  argv = [],
  env = process.env,
  cwd = process.cwd(),
  rootDir,
  commandOptions = [],
  allowPositionals = false,
} = {}) {
  const options = {}
  for (const opt of commandOptions) {
    if (opt.repeatable) {
      options[opt.name] = Array.isArray(opt.default) ? [...opt.default] : []
    } else if (opt.default !== undefined) {
      options[opt.name] = opt.default
    }
  }

  const { schemaEntries, schemaFlagMap, cmdFlagMap, cmdShortMap, allFlagNames } = buildOptionTables(
    command,
    commandOptions,
  )

  const envFiles = []
  const cliActions = []
  const positionals = []

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--') continue
    if (token === '-h' || token === '--help') {
      return {
        help: true,
        options,
        positionals,
        env: { ...env },
        deletedKeys: new Set(),
        sources: {},
        warnings: [],
      }
    }

    if (token === '-e' || token.startsWith('-e=')) {
      const { value, nextIndex } = readNextValue(argv, i, token, '-e')
      i = nextIndex
      const eq = value.indexOf('=')
      if (eq <= 0) {
        throw new CliUsageError(`参数 -e 格式必须为 KEY=VALUE，收到: ${value}`)
      }
      const key = value.slice(0, eq).trim()
      if (!ENV_KEY_PATTERN.test(key)) {
        throw new CliUsageError(`环境变量名非法: ${key}`)
      }
      cliActions.push({ key, delete: false, value: value.slice(eq + 1) })
      continue
    }

    if (token.startsWith('-') && !token.startsWith('--') && token.length === 2) {
      const shortName = token.slice(1)
      const opt = cmdShortMap.get(shortName)
      if (!opt) {
        throw new CliUsageError(`未知短参数: ${token}（使用 --help 查看支持的参数）`)
      }
      if (opt.type === 'boolean') {
        options[opt.name] = true
      } else {
        const { value, nextIndex } = readNextValue(argv, i, token, token)
        i = nextIndex
        const parsed = parseCommandOptionValue(opt, value)
        if (opt.repeatable) options[opt.name].push(parsed)
        else options[opt.name] = parsed
      }
      continue
    }

    if (token.startsWith('--')) {
      const eqIndex = token.indexOf('=')
      const rawKey = eqIndex === -1 ? token.slice(2) : token.slice(2, eqIndex)
      const hasInlineValue = eqIndex !== -1
      const inlineValue = hasInlineValue ? token.slice(eqIndex + 1) : undefined

      if (rawKey === 'env') {
        const { value, nextIndex } = readNextValue(argv, i, token, '--env')
        i = nextIndex
        const eq = value.indexOf('=')
        if (eq <= 0) {
          throw new CliUsageError(`参数 --env 格式必须为 KEY=VALUE，收到: ${value}`)
        }
        const key = value.slice(0, eq).trim()
        if (!ENV_KEY_PATTERN.test(key)) {
          throw new CliUsageError(`环境变量名非法: ${key}`)
        }
        cliActions.push({ key, delete: false, value: value.slice(eq + 1) })
        continue
      }

      if (rawKey === 'env-file') {
        const { value, nextIndex } = readNextValue(argv, i, token, '--env-file')
        i = nextIndex
        if (!value) throw new CliUsageError('参数 --env-file 不能为空')
        envFiles.push(path.resolve(cwd, value))
        continue
      }

      // Check command-specific option (--name or --no-name)
      const isNegated = rawKey.startsWith('no-')
      const baseName = isNegated ? rawKey.slice(3) : rawKey
      const cmdOpt = cmdFlagMap.get(rawKey) || (isNegated ? cmdFlagMap.get(baseName) : undefined)
      if (cmdOpt) {
        if (cmdOpt.type === 'boolean') {
          if (isNegated && cmdOpt.name === baseName) {
            if (hasInlineValue) {
              throw new CliUsageError(`否定参数 --${rawKey} 不接受赋值`)
            }
            options[cmdOpt.name] = false
          } else {
            options[cmdOpt.name] = parseCommandOptionValue(
              cmdOpt,
              hasInlineValue ? inlineValue : true,
            )
          }
        } else {
          if (isNegated && !cmdFlagMap.has(rawKey)) {
            throw new CliUsageError(`未知参数: --${rawKey}`)
          }
          const { value, nextIndex } = readNextValue(argv, i, token, `--${cmdOpt.name}`)
          i = nextIndex
          const parsed = parseCommandOptionValue(cmdOpt, value)
          if (cmdOpt.repeatable) options[cmdOpt.name].push(parsed)
          else options[cmdOpt.name] = parsed
        }
        continue
      }

      // Check schema option (--flag, --env-kebab, --no-flag, --no-env-kebab)
      const schemaEntry =
        schemaFlagMap.get(rawKey) || (isNegated ? schemaFlagMap.get(baseName) : undefined)
      if (schemaEntry && (!isNegated || schemaEntry.type === 'boolean')) {
        if (schemaEntry.type === 'boolean') {
          let rawBool
          if (isNegated && !schemaFlagMap.has(rawKey)) {
            if (hasInlineValue) {
              throw new CliUsageError(`否定参数 --${rawKey} 不接受赋值`)
            }
            rawBool = false
          } else {
            rawBool = hasInlineValue ? inlineValue : true
          }
          const validated = validateSchemaValue(schemaEntry, rawBool, {
            cwd,
            flagLabel: rawKey,
          })
          cliActions.push({ key: schemaEntry.env, ...validated })
        } else {
          const { value, nextIndex } = readNextValue(argv, i, token, `--${rawKey}`)
          i = nextIndex
          const validated = validateSchemaValue(schemaEntry, value, {
            cwd,
            flagLabel: rawKey,
          })
          cliActions.push({ key: schemaEntry.env, ...validated })
        }
        continue
      }

      const suggestions = suggestFlags(`--${rawKey}`, allFlagNames)
      const hint = suggestions.length > 0 ? `，是否想输入 ${suggestions.join(' 或 ')}？` : ''
      throw new CliUsageError(
        `未知参数: --${rawKey}${hint}（使用 --help 查看支持的参数，或使用 -e KEY=VALUE 透传任意环境变量）`,
      )
    }

    if (allowPositionals) {
      positionals.push(token)
      continue
    }

    throw new CliUsageError(`未知参数: ${token}（使用 --help 查看用法）`)
  }

  // Merge priority:
  // 1. CLI flags & -e
  // 2. npm_config_* (only whitelisted schema keys for this command)
  // 3. Incoming Shell env
  // 4. Explicit --env-file
  // 5. Default root .env (non-empty keys only)
  const mergedEnv = { ...env }
  const deletedKeys = new Set()
  const sources = {}
  const warnings = []

  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== '') {
      sources[key] = 'env'
    }
  }

  for (const filePath of envFiles) {
    const loaded = loadEnvFile(filePath, { required: true })
    for (const [key, value] of Object.entries(loaded.values)) {
      if (sources[key] !== 'env') {
        mergedEnv[key] = value
        sources[key] = 'env-file'
      }
    }
  }

  if (rootDir) {
    const defaultDotEnv = loadEnvFile(path.join(rootDir, '.env'), { required: false })
    for (const [key, value] of Object.entries(defaultDotEnv.values)) {
      if (value !== '' && (mergedEnv[key] === undefined || mergedEnv[key] === '')) {
        mergedEnv[key] = value
        sources[key] = '.env'
      }
    }
  }

  // npm_config_* fallback for whitelisted schema entries
  for (const entry of schemaEntries) {
    const npmKeys = [
      `npm_config_${entry.env.toLowerCase()}`,
      `npm_config_${entry.flag.replaceAll('-', '_')}`,
    ]
    for (const npmKey of [...new Set(npmKeys)]) {
      const raw = env[npmKey]
      if (raw !== undefined && raw !== '') {
        const validated = validateSchemaValue(entry, raw, { cwd, flagLabel: entry.flag })
        if (validated.delete) {
          delete mergedEnv[entry.env]
          deletedKeys.add(entry.env)
        } else {
          mergedEnv[entry.env] = validated.value
          deletedKeys.delete(entry.env)
        }
        sources[entry.env] = 'npm_config'
        warnings.push(
          `[cli] 检测到 ${npmKey} 透传 ${entry.env}；建议改用 yarn ${command} --${entry.flag}=... 或 npm run ${command} -- --${entry.flag}=...`,
        )
        break
      }
    }
  }

  // Apply CLI flags and -e actions in order
  for (const action of cliActions) {
    if (action.delete) {
      delete mergedEnv[action.key]
      deletedKeys.add(action.key)
      sources[action.key] = 'cli'
    } else {
      mergedEnv[action.key] = action.value
      deletedKeys.delete(action.key)
      sources[action.key] = 'cli'
    }
  }

  return {
    help: false,
    options,
    positionals,
    env: mergedEnv,
    deletedKeys,
    sources,
    warnings,
  }
}

export function applyEnv(targetEnv, mergedEnv, deletedKeys = new Set()) {
  for (const [key, value] of Object.entries(mergedEnv)) {
    if (value !== undefined) {
      targetEnv[key] = String(value)
    }
  }
  for (const key of deletedKeys) {
    delete targetEnv[key]
  }
}

const SECRET_ENV_SET = new Set(ENV_SCHEMA.filter((e) => e.secret).map((e) => e.env))

export function maskValue(key, value) {
  if (SECRET_ENV_SET.has(key) || SENSITIVE_KEY_PATTERN.test(key)) {
    return '***'
  }
  return String(value)
}

export function formatEnvSummary(prefix, resolved, keysToShow) {
  const parts = []
  for (const key of keysToShow) {
    const val = resolved.env[key]
    if (val === undefined || val === '') continue
    const source = resolved.sources[key] || 'default'
    parts.push(`${key}=${maskValue(key, val)} [${source}]`)
  }
  if (parts.length === 0) return ''
  return `${prefix} ${parts.join(' | ')}`
}

function padColumn(text, width) {
  return text.length + 2 > width ? `${text}  ` : text.padEnd(width)
}

export function formatHelp({ command, usage, summary, commandOptions = [], scope, examples }) {
  const lines = [`用法: ${usage}`, '', summary]

  if (commandOptions.length > 0) {
    lines.push('', '命令选项:')
    for (const opt of commandOptions) {
      const shortPrefix = opt.short ? `-${opt.short}, ` : ''
      const valueSuffix =
        opt.type === 'boolean'
          ? ''
          : opt.type === 'enum'
            ? `=<${opt.values.join('|')}>`
            : '=<value>'
      const label = padColumn(`  ${shortPrefix}--${opt.name}${valueSuffix}`, 44)
      const def = opt.default !== undefined ? `（默认 ${opt.default}）` : ''
      lines.push(`${label}${opt.description}${def}`)
    }
  }

  const schemaEntries = getSchemaForScope(scope ?? command)
  if (schemaEntries.length > 0) {
    lines.push('', '环境变量参数（同时支持 --<短参> 与 --<环境变量kebab>）:')
    for (const entry of schemaEntries) {
      const fullFlag = envToFlag(entry.env)
      const aliases =
        fullFlag === entry.flag ? `--${entry.flag}` : `--${entry.flag} / --${fullFlag}`
      const left = padColumn(`  ${aliases}`, 48)
      lines.push(`${left}${entry.env}: ${entry.description}`)
    }
  }

  const exampleLines = examples ?? [
    `Linux/macOS:  PORT=4500 yarn ${command}`,
    `PowerShell:   $env:PORT="4500"; yarn ${command}`,
    `通用 CLI:     yarn ${command} --port=4500 -e FOO=bar`,
  ]

  lines.push(
    '',
    '通用透传与帮助:',
    '  -e, --env KEY=VALUE                       透传任意环境变量（可多次指定）',
    '  --env-file=<path>                         加载指定 .env 文件（可多次指定）',
    '  -h, --help                                显示本帮助',
    '',
    '跨平台示例:',
    ...exampleLines.map((line) => `  ${line}`),
  )

  return lines.join('\n')
}
