import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const ROOT_DIR = path.resolve(import.meta.dirname, '../..')
const HELPER = path.join(ROOT_DIR, 'trellis-kit/features/company-spec/apply.mjs')

function withTempDir(prefix, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content, 'utf8')
}

function computeHash(content) {
  return crypto.createHash('sha256').update(content.replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

function fakeTemplateFetcher() {
  return `
import fs from 'node:fs'
import path from 'node:path'

export function parseRegistrySource(source) {
  return { source, rawBaseUrl: 'https://fake.invalid/raw', preferGit: false }
}

export async function probeRegistryIndex() {
  return {
    templates: [{ id: 'wit-frontend-vue2', type: 'spec', path: 'specs/wit-frontend-vue2', name: 'Vue2' }],
    isNotFound: false,
    backend: 'git',
  }
}

export async function downloadTemplateById(cwd, templateId, strategy, template, registry, destDirOverride) {
  const source = process.env.COMPANY_SPEC_TEST_TEMPLATE
  fs.mkdirSync(path.dirname(destDirOverride), { recursive: true })
  fs.cpSync(source, destDirOverride, { recursive: true, force: true })
  return { success: true, message: 'ok' }
}
`
}

function fakeRegistryConfig() {
  return `
import fs from 'node:fs'
import path from 'node:path'

export function loadSpecRegistryConfig() { return null }

export function writeSpecRegistryConfig(cwd, config) {
  const file = path.join(cwd, '.trellis', 'config.yaml')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'registry:\\n  spec:\\n    source: ' + config.source + '\\n    template: ' + config.template + '\\n', 'utf8')
}
`
}

function fakeTemplateHash() {
  return `
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function computeHash(content) {
  return crypto.createHash('sha256').update(content.replace(/\\r\\n/g, '\\n'), 'utf8').digest('hex')
}

function hashesPath(cwd) {
  return path.join(cwd, '.trellis', '.template-hashes.json')
}

export function loadHashes(cwd) {
  const file = hashesPath(cwd)
  if (!fs.existsSync(file)) return {}
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  return parsed && parsed.__version === 2 && parsed.hashes ? parsed.hashes : {}
}

export function saveHashes(cwd, hashes) {
  const file = hashesPath(cwd)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ __version: 2, hashes }, null, 2), 'utf8')
}
`
}

function createFixture(root, { cliVersion = '0.6.17', cliEntry = 'dist/cli/index.js' } = {}) {
  const cliRoot = path.join(root, 'fake-cli')
  write(
    path.join(cliRoot, 'package.json'),
    JSON.stringify({ name: '@mindfoldhq/trellis', version: cliVersion }),
  )
  write(path.join(cliRoot, cliEntry), '')
  write(path.join(cliRoot, 'dist/utils/template-fetcher.js'), fakeTemplateFetcher())
  write(path.join(cliRoot, 'dist/utils/registry-config.js'), fakeRegistryConfig())
  write(path.join(cliRoot, 'dist/utils/template-hash.js'), fakeTemplateHash())

  const templateRoot = path.join(root, 'template')
  write(
    path.join(templateRoot, '.company-spec.json'),
    JSON.stringify({
      schema: 1,
      template: 'wit-frontend-vue2',
      version: '2026.11.1',
      generatedAt: '2026-11-25',
      bundles: ['common', 'frontend-vue2'],
      sources: [],
    }),
  )
  write(path.join(templateRoot, 'frontend/index.md'), 'template frontend\n')
  write(path.join(templateRoot, 'frontend/quality-guidelines.md'), 'template quality\n')
  write(path.join(templateRoot, 'guides/index.md'), 'template guides\n')

  const target = path.join(root, 'target')
  write(path.join(target, '.trellis/spec/frontend/index.md'), 'generic frontend\n')
  write(path.join(target, '.trellis/spec/guides/index.md'), 'generic guides\n')

  return {
    cliPath: path.join(cliRoot, cliEntry),
    templateRoot,
    target,
  }
}

function runHelper(fixture, args, env = {}) {
  const result = (() => {
    try {
      const stdout = execFileSync(process.execPath, [HELPER, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          COMPANY_SPEC_TEST_TEMPLATE: fixture.templateRoot,
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { status: 0, stdout, stderr: '' }
    } catch (error) {
      return {
        status: error.status ?? 1,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
      }
    }
  })()
  const line = result.stdout.trim().split('\n').at(-1)
  return { ...result, json: line ? JSON.parse(line) : null }
}

function baseArgs(fixture, mode, strategy) {
  return [
    '--cli',
    fixture.cliPath,
    '--target',
    fixture.target,
    '--registry',
    'ssh://git@git.example:1022/group/repo.git',
    '--template',
    'wit-frontend-vue2',
    '--mode',
    mode,
    ...(strategy ? ['--strategy', strategy] : []),
  ]
}

test('company-spec plan and apply replace creates backup, marker, config and hashes', () => {
  withTempDir('company-spec-', (root) => {
    const fixture = createFixture(root)
    const planned = runHelper(fixture, baseArgs(fixture, 'plan'))
    assert.equal(planned.status, 0, planned.stderr)
    assert.equal(planned.json.ok, true)
    assert.equal(planned.json.plan.action, 'apply')
    assert.equal(planned.json.plan.requiresBackup, true)
    assert.ok(planned.json.plan.files.conflict.length > 0)
    assert.equal(
      fs.readFileSync(path.join(fixture.target, '.trellis/spec/frontend/index.md'), 'utf8'),
      'generic frontend\n',
    )

    const applied = runHelper(fixture, baseArgs(fixture, 'apply', 'replace'))
    assert.equal(applied.status, 0, applied.stderr)
    assert.equal(applied.json.ok, true)
    assert.equal(applied.json.action, 'apply')
    assert.ok(applied.json.backupPath)
    assert.equal(
      fs.readFileSync(path.join(fixture.target, '.trellis/spec/frontend/index.md'), 'utf8'),
      'template frontend\n',
    )
    assert.equal(fs.existsSync(path.join(fixture.target, applied.json.backupPath)), true)
    const config = fs.readFileSync(path.join(fixture.target, '.trellis/config.yaml'), 'utf8')
    assert.match(config, /template: wit-frontend-vue2/)
    const hashes = JSON.parse(
      fs.readFileSync(path.join(fixture.target, '.trellis/.template-hashes.json'), 'utf8'),
    ).hashes
    assert.equal(hashes['.trellis/spec/frontend/index.md'], computeHash('template frontend\n'))
  })
})

test('company-spec update keep-local preserves local edits and keeps their old hash', () => {
  withTempDir('company-spec-', (root) => {
    const fixture = createFixture(root)
    assert.equal(runHelper(fixture, baseArgs(fixture, 'apply', 'replace')).json.ok, true)
    const edited = path.join(fixture.target, '.trellis/spec/frontend/quality-guidelines.md')
    fs.writeFileSync(edited, 'local quality\n', 'utf8')

    const planned = runHelper(fixture, baseArgs(fixture, 'plan'))
    assert.equal(planned.json.plan.action, 'update')
    assert.ok(planned.json.plan.files.conflict.includes('frontend/quality-guidelines.md'))

    const applied = runHelper(fixture, baseArgs(fixture, 'apply', 'keep-local'))
    assert.equal(applied.json.ok, true)
    assert.equal(fs.readFileSync(edited, 'utf8'), 'local quality\n')
    const hashes = JSON.parse(
      fs.readFileSync(path.join(fixture.target, '.trellis/.template-hashes.json'), 'utf8'),
    ).hashes
    assert.equal(
      hashes['.trellis/spec/frontend/quality-guidelines.md'],
      computeHash('template quality\n'),
    )
  })
})

test('company-spec update overwrite replaces local edits and backs up the spec', () => {
  withTempDir('company-spec-', (root) => {
    const fixture = createFixture(root)
    assert.equal(runHelper(fixture, baseArgs(fixture, 'apply', 'replace')).json.ok, true)
    const edited = path.join(fixture.target, '.trellis/spec/frontend/quality-guidelines.md')
    fs.writeFileSync(edited, 'local quality\n', 'utf8')

    const applied = runHelper(fixture, baseArgs(fixture, 'apply', 'overwrite'))
    assert.equal(applied.json.ok, true)
    assert.ok(applied.json.backupPath)
    assert.equal(fs.readFileSync(edited, 'utf8'), 'template quality\n')
  })
})

test('company-spec keeps user-deleted files on keep-local and revives them on overwrite', () => {
  withTempDir('company-spec-', (root) => {
    const fixture = createFixture(root)
    assert.equal(runHelper(fixture, baseArgs(fixture, 'apply', 'replace')).json.ok, true)
    const guides = path.join(fixture.target, '.trellis/spec/guides/index.md')
    fs.rmSync(guides)

    const planned = runHelper(fixture, baseArgs(fixture, 'plan'))
    assert.equal(planned.json.plan.action, 'update')
    assert.ok(planned.json.plan.files.keepDeleted.includes('guides/index.md'))

    assert.equal(runHelper(fixture, baseArgs(fixture, 'apply', 'keep-local')).json.ok, true)
    assert.equal(fs.existsSync(guides), false)

    assert.equal(runHelper(fixture, baseArgs(fixture, 'apply', 'overwrite')).json.ok, true)
    assert.equal(fs.readFileSync(guides, 'utf8'), 'template guides\n')
  })
})

test('company-spec deletes removed template files when unmodified and preserves modified ones', () => {
  withTempDir('company-spec-', (root) => {
    const fixture = createFixture(root)
    assert.equal(runHelper(fixture, baseArgs(fixture, 'apply', 'replace')).json.ok, true)
    fs.rmSync(path.join(fixture.templateRoot, 'guides/index.md'))

    const planned = runHelper(fixture, baseArgs(fixture, 'plan'))
    assert.equal(planned.json.plan.action, 'update')
    assert.ok(planned.json.plan.files.delete.includes('guides/index.md'))

    assert.equal(runHelper(fixture, baseArgs(fixture, 'apply', 'keep-local')).json.ok, true)
    assert.equal(fs.existsSync(path.join(fixture.target, '.trellis/spec/guides/index.md')), false)
  })
})

test('company-spec replaces when the target marker names another template', () => {
  withTempDir('company-spec-', (root) => {
    const fixture = createFixture(root)
    assert.equal(runHelper(fixture, baseArgs(fixture, 'apply', 'replace')).json.ok, true)
    const markerPath = path.join(fixture.target, '.trellis/spec/.company-spec.json')
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    marker.template = 'legacy-template'
    fs.writeFileSync(markerPath, JSON.stringify(marker), 'utf8')

    const planned = runHelper(fixture, baseArgs(fixture, 'plan'))
    assert.equal(planned.json.plan.action, 'replace')
    assert.equal(runHelper(fixture, baseArgs(fixture, 'apply', 'replace')).json.ok, true)
    const rewritten = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    assert.equal(rewritten.template, 'wit-frontend-vue2')
  })
})

test('company-spec reports helper_incompatible for an old CLI', () => {
  withTempDir('company-spec-', (root) => {
    const fixture = createFixture(root, { cliVersion: '0.6.16' })
    const planned = runHelper(fixture, baseArgs(fixture, 'plan'))
    assert.notEqual(planned.status, 0)
    assert.equal(planned.json.code, 'helper_incompatible')
  })
})

test('company-spec aborts with backup_failed when the backup path is blocked', () => {
  withTempDir('company-spec-', (root) => {
    const fixture = createFixture(root)
    assert.equal(runHelper(fixture, baseArgs(fixture, 'apply', 'replace')).json.ok, true)
    const markerPath = path.join(fixture.target, '.trellis/spec/.company-spec.json')
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
    marker.template = 'legacy-template'
    fs.writeFileSync(markerPath, JSON.stringify(marker), 'utf8')
    const blocked = path.join(fixture.target, '.trellis/.runtime/company-spec-backups')
    fs.rmSync(blocked, { recursive: true, force: true })
    write(blocked, 'blocked')

    const applied = runHelper(fixture, baseArgs(fixture, 'apply', 'replace'))
    assert.notEqual(applied.status, 0)
    assert.equal(applied.json.code, 'backup_failed')
  })
})

test('company-spec resolves dist/utils when --cli points to bin/trellis.js', () => {
  withTempDir('company-spec-bin-', (root) => {
    const fixture = createFixture(root, { cliEntry: 'bin/trellis.js' })
    const planned = runHelper(fixture, baseArgs(fixture, 'plan'))
    assert.equal(planned.status, 0, planned.stderr)
    assert.equal(planned.json.ok, true)
    assert.equal(planned.json.plan.action, 'apply')

    const applied = runHelper(fixture, baseArgs(fixture, 'apply', 'replace'))
    assert.equal(applied.status, 0, applied.stderr)
    assert.equal(applied.json.ok, true)
    assert.equal(applied.json.applied, true)
  })
})
