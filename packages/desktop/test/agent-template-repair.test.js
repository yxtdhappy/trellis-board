import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const helperSource = fs.readFileSync(
  path.join(root, 'packages/desktop/src-tauri/src/agent/agent_template_repair.mjs'),
  'utf8',
)

// 复现部分 DLP/网络盘机器上 realpath/stat 盘符根时内部 lstat "D:" 报 EISDIR 的行为。
const EISDIR_PATCH = String.raw`
const fs = require('node:fs')
const blocked = (value) => /^[A-Za-z]:\\?$/.test(String(value))
function eisdir() {
  const error = new Error("EISDIR: illegal operation on a directory, lstat 'D:'")
  error.code = 'EISDIR'
  error.syscall = 'lstat'
  error.path = 'D:'
  return error
}
for (const name of ['realpathSync', 'statSync', 'lstatSync']) {
  const original = fs[name]
  fs[name] = function patched(target, ...args) {
    if (blocked(target)) throw eisdir()
    return original.call(this, target, ...args)
  }
}
`

// 模拟 Node JS 版 realpathSync 在盘符根上触发 DLP 的 lstat EISDIR；native 版必须仍可用。
const JS_REALPATH_PATCH = String.raw`
const fs = require('node:fs')
const native = fs.realpathSync.native
function blocked() {
  const error = new Error("EISDIR: illegal operation on a directory, lstat 'D:'")
  error.code = 'EISDIR'
  error.syscall = 'lstat'
  error.path = 'D:'
  throw error
}
blocked.native = native
fs.realpathSync = blocked
`

function createFakePackage(dir, platformTemplates) {
  const packageRoot = path.join(dir, 'trellis')
  fs.mkdirSync(path.join(packageRoot, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(packageRoot, 'dist', 'configurators'), { recursive: true })
  fs.mkdirSync(path.join(packageRoot, 'dist', 'commands'), { recursive: true })
  fs.mkdirSync(path.join(packageRoot, 'dist', 'utils'), { recursive: true })
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ type: 'module' }))
  fs.writeFileSync(path.join(packageRoot, 'bin', 'trellis.js'), '#!/usr/bin/env node\n')
  fs.writeFileSync(
    path.join(packageRoot, 'dist', 'configurators', 'index.js'),
    [
      'export const PLATFORM_IDS = ["pi", "omp"];',
      `const TEMPLATES = ${JSON.stringify(platformTemplates)};`,
      'export function collectPlatformTemplates(platformId) {',
      '  const entries = TEMPLATES[platformId] ?? [];',
      '  return new Map(entries.map(([relativePath, content]) => [relativePath, content]));',
      '}',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(packageRoot, 'dist', 'commands', 'init.js'),
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'export function resolveSupportedPython() {',
      '  fs.writeFileSync(path.join(process.cwd(), ".fake-python-called"), "1");',
      '  return { command: "python", version: "fake" };',
      '}',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(packageRoot, 'dist', 'utils', 'template-hash.js'),
    [
      'import fs from "node:fs";',
      'import path from "node:path";',
      'export function initializeHashes(cwd, options = {}) {',
      '  fs.writeFileSync(',
      '    path.join(cwd, ".fake-hashes.json"),',
      '    JSON.stringify({',
      '      trackedPaths: options.trackedPaths ?? [],',
      '      merge: options.merge === true,',
      '    }),',
      '  );',
      '  return (options.trackedPaths ?? []).length;',
      '}',
      '',
    ].join('\n'),
  )
  return { cliPath: path.join(packageRoot, 'bin', 'trellis.js') }
}

function runRepairHelper(cliPath, repoRoot, args) {
  return spawnSync(process.execPath, ['--input-type=module', '-', cliPath, repoRoot, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: helperSource,
    timeout: 60_000,
  })
}

function lastJsonLine(stdout) {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].startsWith('{')) {
      return JSON.parse(lines[index])
    }
  }
  throw new Error(`helper 没有输出 JSON: ${stdout}`)
}

function listFiles(dir) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listFiles(fullPath))
    } else {
      files.push(fullPath)
    }
  }
  return files
}

function withTempDir(t, callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-repair-'))
  try {
    callback(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

test('snapshot reports missing and existing templates without probing python', (t) => {
  withTempDir(t, (dir) => {
    const repo = path.join(dir, 'repo')
    fs.mkdirSync(path.join(repo, '.pi'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.pi', 'settings.json'), '{}')
    const { cliPath } = createFakePackage(path.join(dir, 'fake'), {
      pi: [
        ['.pi/settings.json', '{"template":true}'],
        ['.pi/extensions/trellis/index.ts', 'extension'],
      ],
    })

    const result = runRepairHelper(cliPath, repo, ['snapshot', 'pi'])

    assert.equal(result.status, 0, result.stderr)
    const payload = lastJsonLine(result.stdout)
    assert.deepEqual(payload.missing, ['.pi/extensions/trellis/index.ts'])
    assert.deepEqual(payload.existing, ['.pi/settings.json'])
    assert.equal(fs.existsSync(path.join(repo, '.fake-python-called')), false)
  })
})

test(
  'snapshot tolerates a drive root blocked by realpath/lstat',
  { skip: process.platform !== 'win32' },
  (t) => {
    withTempDir(t, (dir) => {
      const repo = path.join(dir, 'cwd')
      fs.mkdirSync(repo)
      const { cliPath } = createFakePackage(path.join(dir, 'fake'), {
        pi: [['.pi/extensions/trellis/index.ts', 'extension']],
      })
      const patchPath = path.join(dir, 'eisdir-patch.cjs')
      fs.writeFileSync(patchPath, EISDIR_PATCH)

      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '-', cliPath, 'D:', 'snapshot', 'pi'],
        {
          cwd: repo,
          encoding: 'utf8',
          input: helperSource,
          timeout: 60_000,
          env: {
            ...process.env,
            // NODE_OPTIONS 会吞掉双引号内的反斜杠，这里统一用正斜杠。
            NODE_OPTIONS: `--require "${patchPath.replaceAll('\\', '/')}"`,
          },
        },
      )

      assert.equal(result.status, 0, result.stderr)
      const payload = lastJsonLine(result.stdout)
      assert.deepEqual(payload.missing, ['.pi/extensions/trellis/index.ts'])
    })
  },
)

test(
  'repair uses native realpath when the JS realpath hits EISDIR',
  { skip: typeof fs.realpathSync.native !== 'function' },
  (t) => {
    withTempDir(t, (dir) => {
      const repo = path.join(dir, 'repo')
      fs.mkdirSync(repo)
      const { cliPath } = createFakePackage(path.join(dir, 'fake'), {
        pi: [['.pi/extensions/trellis/index.ts', 'extension']],
      })
      const patchPath = path.join(dir, 'js-realpath-patch.cjs')
      fs.writeFileSync(patchPath, JS_REALPATH_PATCH)
      // 与 Rust canonicalize 后传入的 Windows 扩展路径一致。
      const repoArg = process.platform === 'win32' ? `\\\\?\\${repo}` : repo

      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '-', cliPath, repoArg, 'repair', 'pi'],
        {
          cwd: repo,
          encoding: 'utf8',
          input: helperSource,
          timeout: 60_000,
          env: {
            ...process.env,
            NODE_OPTIONS: `--require "${patchPath.replaceAll('\\', '/')}"`,
          },
        },
      )

      assert.equal(result.status, 0, result.stderr)
      const payload = lastJsonLine(result.stdout)
      assert.deepEqual(payload.created, ['.pi/extensions/trellis/index.ts'])
      assert.equal(
        fs.readFileSync(path.join(repo, '.pi', 'extensions', 'trellis', 'index.ts'), 'utf8'),
        'extension',
      )
    })
  },
)

test('repair creates only missing templates with direct writes', (t) => {
  withTempDir(t, (dir) => {
    const repo = path.join(dir, 'repo')
    fs.mkdirSync(path.join(repo, '.pi'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.pi', 'settings.json'), 'user-owned')
    const { cliPath } = createFakePackage(path.join(dir, 'fake'), {
      pi: [
        ['.pi/settings.json', '{"template":true}'],
        ['.pi/extensions/trellis/index.ts', 'export const trellis = true;\n'],
      ],
    })

    const result = runRepairHelper(cliPath, repo, ['repair', 'pi'])

    assert.equal(result.status, 0, result.stderr)
    const payload = lastJsonLine(result.stdout)
    assert.deepEqual(payload.created, ['.pi/extensions/trellis/index.ts'])
    assert.equal(payload.skipped, 1)
    assert.equal(fs.readFileSync(path.join(repo, '.pi', 'settings.json'), 'utf8'), 'user-owned')
    assert.equal(
      fs.readFileSync(path.join(repo, '.pi', 'extensions', 'trellis', 'index.ts'), 'utf8'),
      'export const trellis = true;\n',
    )
    assert.equal(fs.existsSync(path.join(repo, '.fake-python-called')), true)
    assert.deepEqual(
      listFiles(repo).filter((file) => file.endsWith('.tmp')),
      [],
    )
  })
})

test('repair covers pi and omp in one pass and keeps shared user files', (t) => {
  withTempDir(t, (dir) => {
    const repo = path.join(dir, 'repo')
    fs.mkdirSync(path.join(repo, '.agents', 'skills', 'demo'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.agents', 'skills', 'demo', 'SKILL.md'), 'user skill')
    const { cliPath } = createFakePackage(path.join(dir, 'fake'), {
      pi: [
        ['.pi/extensions/trellis/index.ts', 'pi extension'],
        ['.agents/skills/demo/SKILL.md', 'shared template'],
      ],
      omp: [['.omp/extensions/trellis/index.ts', 'omp extension']],
    })

    const result = runRepairHelper(cliPath, repo, ['repair', 'pi', 'omp'])

    assert.equal(result.status, 0, result.stderr)
    assert.equal(
      fs.readFileSync(path.join(repo, '.pi', 'extensions', 'trellis', 'index.ts'), 'utf8'),
      'pi extension',
    )
    assert.equal(
      fs.readFileSync(path.join(repo, '.omp', 'extensions', 'trellis', 'index.ts'), 'utf8'),
      'omp extension',
    )
    assert.equal(
      fs.readFileSync(path.join(repo, '.agents', 'skills', 'demo', 'SKILL.md'), 'utf8'),
      'user skill',
    )
  })
})

test('repair fails closed when platforms disagree on a shared template path', (t) => {
  withTempDir(t, (dir) => {
    const repo = path.join(dir, 'repo')
    fs.mkdirSync(repo)
    const { cliPath } = createFakePackage(path.join(dir, 'fake'), {
      pi: [['.pi/shared.md', 'pi content']],
      omp: [['.pi/shared.md', 'omp content']],
    })

    const result = runRepairHelper(cliPath, repo, ['repair', 'pi', 'omp'])

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /多个平台的模板内容冲突/)
    assert.equal(fs.existsSync(path.join(repo, '.pi', 'shared.md')), false)
  })
})

test('repair rejects path traversal and rolls back files created in the same run', (t) => {
  withTempDir(t, (dir) => {
    const repo = path.join(dir, 'repo')
    fs.mkdirSync(repo)
    const { cliPath } = createFakePackage(path.join(dir, 'fake'), {
      pi: [
        ['.pi/created-before-failure.md', 'will be rolled back'],
        ['../outside.md', 'escape'],
      ],
    })

    const result = runRepairHelper(cliPath, repo, ['repair', 'pi'])

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /模板路径含非法段/)
    assert.equal(fs.existsSync(path.join(repo, '.pi', 'created-before-failure.md')), false)
    assert.equal(fs.existsSync(path.join(dir, 'outside.md')), false)
  })
})

test('repair rejects absolute, drive, ADS, NUL and empty-segment template paths', (t) => {
  withTempDir(t, (dir) => {
    const cases = [
      ['/abs.md', /绝对路径/],
      ['C:/drive.md', /绝对路径/],
      ['C:drive.md', /绝对路径/],
      ['.pi/nul\0.md', /模板路径非法/],
      ['.pi/drive\\path.md', /模板路径非法/],
      ['.pi/file:stream.md', /非法段/],
      ['.pi//double.md', /非法段/],
      ['.pi/./dot.md', /非法段/],
    ]
    cases.forEach(([templatePath, pattern], index) => {
      const repo = path.join(dir, `repo-${index}`)
      fs.mkdirSync(repo)
      const { cliPath } = createFakePackage(path.join(dir, `fake-${index}`), {
        pi: [[templatePath, 'x']],
      })

      const result = runRepairHelper(cliPath, repo, ['repair', 'pi'])

      assert.notEqual(result.status, 0, templatePath)
      assert.match(result.stderr, pattern, templatePath)
      assert.deepEqual(
        fs.readdirSync(repo).filter((name) => name !== '.fake-python-called'),
        [],
        templatePath,
      )
    })
  })
})

test('repair refuses parent directories that resolve outside the repository', (t) => {
  withTempDir(t, (dir) => {
    const repo = path.join(dir, 'repo')
    const outside = path.join(dir, 'outside')
    fs.mkdirSync(repo)
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(repo, '.pi'), 'junction')
    const { cliPath } = createFakePackage(path.join(dir, 'fake'), {
      pi: [['.pi/extensions/trellis/index.ts', 'escape']],
    })

    const result = runRepairHelper(cliPath, repo, ['repair', 'pi'])

    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /模板路径越界/)
    assert.equal(fs.existsSync(path.join(outside, 'extensions')), false)
  })
})

test('helper rejects duplicate and unknown platforms before touching the repository', (t) => {
  withTempDir(t, (dir) => {
    const repo = path.join(dir, 'repo')
    fs.mkdirSync(repo)
    const { cliPath } = createFakePackage(path.join(dir, 'fake'), {
      pi: [['.pi/settings.json', '{"template":true}']],
    })

    const duplicate = runRepairHelper(cliPath, repo, ['snapshot', 'pi', 'pi'])
    assert.notEqual(duplicate.status, 0)
    assert.match(duplicate.stderr, /不能重复选择/)

    const unknown = runRepairHelper(cliPath, repo, ['snapshot', 'cursor'])
    assert.notEqual(unknown.status, 0)
    assert.match(unknown.stderr, /不支持的 Agent 平台/)

    assert.deepEqual(fs.readdirSync(repo), [])
  })
})

test('hash registers only missing templates whose content still matches', (t) => {
  withTempDir(t, (dir) => {
    const repo = path.join(dir, 'repo')
    fs.mkdirSync(path.join(repo, '.pi', 'extensions', 'trellis'), { recursive: true })
    fs.writeFileSync(
      path.join(repo, '.pi', 'extensions', 'trellis', 'index.ts'),
      'template-extension',
    )
    fs.writeFileSync(path.join(repo, '.pi', 'settings.json'), 'user edited')
    const { cliPath } = createFakePackage(path.join(dir, 'fake'), {
      pi: [
        ['.pi/extensions/trellis/index.ts', 'template-extension'],
        ['.pi/settings.json', '{"template":true}'],
      ],
    })

    const result = runRepairHelper(cliPath, repo, [
      'hash',
      JSON.stringify({
        platforms: ['pi'],
        missing: ['.pi/extensions/trellis/index.ts', '.pi/settings.json', '.pi/missing.md', 42],
      }),
    ])

    assert.equal(result.status, 0, result.stderr)
    const payload = lastJsonLine(result.stdout)
    assert.deepEqual(payload.hashed, ['.pi/extensions/trellis/index.ts'])
    assert.deepEqual(payload.skipped, ['.pi/settings.json', '.pi/missing.md', 42])
    const hashes = JSON.parse(fs.readFileSync(path.join(repo, '.fake-hashes.json'), 'utf8'))
    assert.deepEqual(hashes.trackedPaths, ['.pi/extensions/trellis/index.ts'])
    assert.equal(hashes.merge, true)
  })
})

test('hash skips initializeHashes when no missing template qualifies', (t) => {
  withTempDir(t, (dir) => {
    const repo = path.join(dir, 'repo')
    fs.mkdirSync(path.join(repo, '.pi'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.pi', 'settings.json'), 'user edited')
    const { cliPath } = createFakePackage(path.join(dir, 'fake'), {
      pi: [['.pi/settings.json', '{"template":true}']],
    })

    const result = runRepairHelper(cliPath, repo, [
      'hash',
      JSON.stringify({
        platforms: ['pi'],
        missing: ['.pi/settings.json', '.pi/absent.md'],
      }),
    ])

    assert.equal(result.status, 0, result.stderr)
    const payload = lastJsonLine(result.stdout)
    assert.deepEqual(payload.hashed, [])
    assert.equal(fs.existsSync(path.join(repo, '.fake-hashes.json')), false)
  })
})
