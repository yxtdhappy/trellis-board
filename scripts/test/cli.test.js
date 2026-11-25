import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  CliUsageError,
  applyEnv,
  formatEnvSummary,
  formatHelp,
  parseDotEnvText,
  resolveCliEnv,
} from '../lib/cli.mjs'

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-cli-test-'))
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('parseDotEnvText parses comments, quotes, export prefix, and empty values', () => {
  const parsed = parseDotEnvText(`
# comment
PORT=4500
export TRELLIS_BOARD_DATA_DIR=
SINGLE='hello world'
DOUBLE="line1\\nline2"
INLINE=abc # trailing comment
`)
  assert.deepEqual(parsed, {
    PORT: '4500',
    TRELLIS_BOARD_DATA_DIR: '',
    SINGLE: 'hello world',
    DOUBLE: 'line1\nline2',
    INLINE: 'abc',
  })
})

test('resolveCliEnv supports short flags, full kebab flags, and standalone --', () => {
  const cwd = path.resolve('/tmp/workspace-a')
  const res1 = resolveCliEnv({
    command: 'dev',
    argv: ['--', '--plugins-dir=./plugins-local', '--port', '4600'],
    env: {},
    cwd,
  })
  assert.equal(res1.env.TRELLIS_BOARD_PLUGINS_DIR, path.resolve(cwd, './plugins-local'))
  assert.equal(res1.env.PORT, '4600')
  assert.equal(res1.sources.TRELLIS_BOARD_PLUGINS_DIR, 'cli')
  assert.equal(res1.sources.PORT, 'cli')

  const res2 = resolveCliEnv({
    command: 'dev',
    argv: ['--trellis-board-plugins-dir', './other-plugins'],
    env: {},
    cwd,
  })
  assert.equal(res2.env.TRELLIS_BOARD_PLUGINS_DIR, path.resolve(cwd, './other-plugins'))
})

test('resolveCliEnv supports repeatable -e/--env KEY=VALUE and rejects invalid keys', () => {
  const res = resolveCliEnv({
    command: 'dev',
    argv: ['-e', 'FOO=bar', '--env=PORT=4800', '-e', 'FOO=baz=1'],
    env: {},
  })
  assert.equal(res.env.FOO, 'baz=1')
  assert.equal(res.env.PORT, '4800')
  assert.equal(res.sources.FOO, 'cli')

  assert.throws(
    () => resolveCliEnv({ command: 'dev', argv: ['-e', '123BAD=1'], env: {} }),
    CliUsageError,
  )
  assert.throws(
    () => resolveCliEnv({ command: 'dev', argv: ['--env=NO_EQUALS'], env: {} }),
    CliUsageError,
  )
})

test('resolveCliEnv enforces priority: CLI > npm_config > Shell env > --env-file > root .env', () => {
  withTempDir((rootDir) => {
    fs.writeFileSync(
      path.join(rootDir, '.env'),
      'PORT=4317\nTRELLIS_BOARD_DATA_DIR=\nTRELLIS_WATCH_DEBOUNCE_MS=400\n',
    )
    const customEnvFile = path.join(rootDir, 'custom.env')
    fs.writeFileSync(
      customEnvFile,
      'PORT=4400\nTRELLIS_WATCH_DEBOUNCE_MS=600\nVITE_API_TARGET=http://127.0.0.1:4400\n',
    )

    // Root .env empty TRELLIS_BOARD_DATA_DIR= must not count as set; --env-file overrides root .env;
    // Shell env overrides --env-file; npm_config_* overrides Shell env; CLI overrides all.
    const res = resolveCliEnv({
      command: 'dev',
      argv: ['--env-file', customEnvFile, '--port=4900'],
      env: {
        PORT: '4500',
        TRELLIS_WATCH_DEBOUNCE_MS: '800',
        npm_config_trellis_watch_debounce_ms: '900',
        npm_config_cache: '/ignored/npm/cache',
      },
      cwd: rootDir,
      rootDir,
    })

    assert.equal(res.env.PORT, '4900')
    assert.equal(res.sources.PORT, 'cli')
    assert.equal(res.env.TRELLIS_WATCH_DEBOUNCE_MS, '900')
    assert.equal(res.sources.TRELLIS_WATCH_DEBOUNCE_MS, 'npm_config')
    assert.equal(res.env.VITE_API_TARGET, 'http://127.0.0.1:4400')
    assert.equal(res.sources.VITE_API_TARGET, 'env-file')
    assert.equal(res.env.TRELLIS_BOARD_DATA_DIR, undefined)
    assert.equal(res.warnings.length, 1)
    assert.match(res.warnings[0], /npm_config_trellis_watch_debounce_ms/)
    // Non-whitelisted npm_config_* must not be turned into a config source
    assert.equal(res.sources.cache, undefined)
  })
})

test('resolveCliEnv validates port, int, enum, and presenceOnly booleans', () => {
  assert.throws(
    () => resolveCliEnv({ command: 'dev', argv: ['--port=99999'], env: {} }),
    CliUsageError,
  )
  assert.throws(
    () => resolveCliEnv({ command: 'dev', argv: ['--watch-debounce=50'], env: {} }),
    CliUsageError,
  )
  assert.throws(
    () => resolveCliEnv({ command: 'build', argv: ['--role=admin'], env: {} }),
    CliUsageError,
  )

  const enabled = resolveCliEnv({
    command: 'dev',
    argv: ['--http-trace'],
    env: {},
  })
  assert.equal(enabled.env.TRELLIS_DESKTOP_HTTP_TRACE, '1')
  assert.equal(enabled.deletedKeys.has('TRELLIS_DESKTOP_HTTP_TRACE'), false)

  const disabled = resolveCliEnv({
    command: 'dev',
    argv: ['--no-http-trace'],
    env: { TRELLIS_DESKTOP_HTTP_TRACE: '1' },
  })
  assert.equal(disabled.env.TRELLIS_DESKTOP_HTTP_TRACE, undefined)
  assert.equal(disabled.deletedKeys.has('TRELLIS_DESKTOP_HTTP_TRACE'), true)

  const targetEnv = { TRELLIS_DESKTOP_HTTP_TRACE: '1' }
  applyEnv(targetEnv, disabled.env, disabled.deletedKeys)
  assert.equal('TRELLIS_DESKTOP_HTTP_TRACE' in targetEnv, false)
})

test('resolveCliEnv rejects unknown flags with typo suggestions', () => {
  assert.throws(
    () =>
      resolveCliEnv({
        command: 'dev',
        argv: ['--trellis-board-plugin-dir=/tmp/p'],
        env: {},
      }),
    (err) => err instanceof CliUsageError && err.message.includes('--trellis-board-plugins-dir'),
  )
})

test('formatEnvSummary masks sensitive values and formatHelp renders sections', () => {
  const res = resolveCliEnv({
    command: 'dev',
    argv: ['--local-plugin-token=secret-abc', '--local-plugin-secret=xyz', '--port=4317'],
    env: {},
  })
  const summary = formatEnvSummary('[dev]', res, [
    'PORT',
    'VITE_LOCAL_PLUGIN_TOKEN',
    'VITE_LOCAL_PLUGIN_SECRET',
  ])
  assert.match(summary, /PORT=4317 \[cli\]/)
  assert.match(summary, /VITE_LOCAL_PLUGIN_TOKEN=\*\*\* \[cli\]/)
  assert.match(summary, /VITE_LOCAL_PLUGIN_SECRET=\*\*\* \[cli\]/)
  assert.doesNotMatch(summary, /secret-abc/)
  assert.doesNotMatch(summary, /xyz/)

  for (const cmd of ['dev', 'start', 'build', 'test']) {
    const text = formatHelp({
      command: cmd,
      usage: `yarn ${cmd} [选项]`,
      summary: `${cmd} help`,
    })
    assert.match(text, /通用透传与帮助:/)
    assert.match(text, /跨平台示例:/)
  }
})

test('resolveCliEnv supports --base-path and --trust-proxy / --no-trust-proxy', () => {
  const startSubpath = resolveCliEnv({
    command: 'start',
    argv: ['--base-path=/weint-spec-board', '--no-trust-proxy'],
    env: {},
  })
  assert.equal(startSubpath.env.TRELLIS_BOARD_BASE_PATH, '/weint-spec-board')
  assert.equal(startSubpath.env.TRELLIS_BOARD_TRUST_PROXY, 'false')
  assert.equal(startSubpath.sources.TRELLIS_BOARD_BASE_PATH, 'cli')
  assert.equal(startSubpath.sources.TRELLIS_BOARD_TRUST_PROXY, 'cli')

  const startRoot = resolveCliEnv({
    command: 'start',
    argv: ['--base-path=/', '--trust-proxy'],
    env: {},
  })
  assert.equal(startRoot.env.TRELLIS_BOARD_BASE_PATH, '/')
  assert.equal(startRoot.env.TRELLIS_BOARD_TRUST_PROXY, 'true')

  const devIsolation = resolveCliEnv({
    command: 'dev',
    argv: [],
    env: {},
    rootDir: path.resolve(import.meta.dirname, '../..'),
  })
  assert.equal(devIsolation.sources.TRELLIS_BOARD_BASE_PATH, '.env')
  assert.equal(devIsolation.env.TRELLIS_BOARD_BASE_PATH, '/weint-spec-board')
})

test('resolveCliEnv supports --app-name across dev, start, and build scopes', () => {
  for (const command of ['dev', 'start', 'build']) {
    const res = resolveCliEnv({
      command,
      argv: ['--app-name=Custom Board'],
      env: {},
    })
    assert.equal(res.env.TRELLIS_BOARD_APP_NAME, 'Custom Board')
    assert.equal(res.sources.TRELLIS_BOARD_APP_NAME, 'cli')
    const summary = formatEnvSummary(`[${command}]`, res, ['TRELLIS_BOARD_APP_NAME'])
    assert.match(summary, /TRELLIS_BOARD_APP_NAME=Custom Board \[cli\]/)
  }
})
