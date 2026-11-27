#!/usr/bin/env node
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const SPEC_DIR = '.trellis/spec'
const MARKER_NAME = '.company-spec.json'
const STATE_PATH = '.trellis/.runtime/company-spec-state.json'
const BACKUP_ROOT = '.trellis/.runtime/company-spec-backups'
const MIN_CLI_VERSION = '0.6.17'

function redact(value) {
  return String(value).replace(/\/\/[^/@\s]+@/g, '//***@')
}

function failure(code, message) {
  return { ok: false, code, message: redact(message) }
}

function emit(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

function versionAtLeast(version, minimum) {
  const left = String(version)
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0)
  const right = minimum.split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a > b
  }
  return true
}

function toPosix(value) {
  return value.split(path.sep).join('/')
}

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      cli: { type: 'string' },
      target: { type: 'string' },
      registry: { type: 'string' },
      template: { type: 'string' },
      mode: { type: 'string', default: 'plan' },
      strategy: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  })
  return values
}

function findPackageRoot(cliPath) {
  let current = path.dirname(path.resolve(cliPath))
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(current, 'package.json')
    if (fs.existsSync(candidate)) {
      try {
        const data = JSON.parse(fs.readFileSync(candidate, 'utf8'))
        if (data.name === '@mindfoldhq/trellis') return current
      } catch {
        // Keep walking; the helper reports an incompatible CLI below.
      }
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return path.resolve(path.dirname(cliPath), '..', '..')
}

function resolveUtilsDir(cliPath, packageRoot) {
  const candidates = [
    path.join(packageRoot, 'dist', 'utils'),
    path.join(path.dirname(path.resolve(cliPath)), '..', 'utils'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'template-fetcher.js'))) {
      return candidate
    }
  }
  return candidates[0]
}

async function loadCliModules(cliPath) {
  const packageRoot = findPackageRoot(cliPath)
  const packageJsonPath = path.join(packageRoot, 'package.json')
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`CLI package.json not found near ${cliPath}`)
  }
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  if (!versionAtLeast(packageJson.version, MIN_CLI_VERSION)) {
    throw new Error(`Trellis CLI ${packageJson.version} is older than ${MIN_CLI_VERSION}`)
  }

  const utilsDir = resolveUtilsDir(cliPath, packageRoot)
  const load = (name) => import(pathToFileURL(path.join(utilsDir, name)).href)
  const [fetcher, registryConfig, templateHash] = await Promise.all([
    load('template-fetcher.js'),
    load('registry-config.js'),
    load('template-hash.js'),
  ])
  for (const name of ['parseRegistrySource', 'probeRegistryIndex', 'downloadTemplateById']) {
    if (typeof fetcher[name] !== 'function') {
      throw new Error(`CLI is missing template-fetcher.${name}`)
    }
  }
  for (const name of ['loadSpecRegistryConfig', 'writeSpecRegistryConfig']) {
    if (typeof registryConfig[name] !== 'function') {
      throw new Error(`CLI is missing registry-config.${name}`)
    }
  }
  for (const name of ['computeHash', 'loadHashes', 'saveHashes']) {
    if (typeof templateHash[name] !== 'function') {
      throw new Error(`CLI is missing template-hash.${name}`)
    }
  }
  return { fetcher, registryConfig, templateHash, packageVersion: packageJson.version }
}

function classifyRegistryError(message) {
  const text = String(message ?? '').toLowerCase()
  if (
    text.includes('auth') ||
    text.includes('credential') ||
    text.includes('permission denied') ||
    text.includes('could not read username') ||
    text.includes('access denied')
  ) {
    return 'auth_failed'
  }
  if (text.includes('not found') || text.includes('does not exist')) {
    return 'template_not_found'
  }
  return 'registry_unreachable'
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function readTemplateMarker(templateRoot) {
  const markerPath = path.join(templateRoot, MARKER_NAME)
  if (!fs.existsSync(markerPath)) return null
  try {
    return readJsonFile(markerPath)
  } catch {
    return null
  }
}

function readTargetMarker(target) {
  const markerPath = path.join(target, SPEC_DIR, MARKER_NAME)
  if (!fs.existsSync(markerPath)) return { data: null, invalid: false }
  try {
    return { data: readJsonFile(markerPath), invalid: false }
  } catch {
    return { data: null, invalid: true }
  }
}

function collectTemplateFiles(root) {
  const files = new Map()
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile()) {
        const relative = toPosix(path.relative(root, fullPath))
        if (relative.startsWith('../') || path.isAbsolute(relative)) {
          throw new Error(`invalid template path: ${relative}`)
        }
        files.set(relative, fs.readFileSync(fullPath, 'utf8'))
      }
    }
  }
  walk(root)
  return files
}

function targetPath(target, relative) {
  const resolved = path.resolve(target, relative)
  const root = path.resolve(target) + path.sep
  if (!resolved.startsWith(root)) {
    throw new Error(`path escapes target: ${relative}`)
  }
  return resolved
}

function ensureWritableDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true })
}

function writeFileText(target, relative, content) {
  const filePath = targetPath(target, relative)
  ensureWritableDirectory(path.dirname(filePath))
  fs.writeFileSync(filePath, content, 'utf8')
}

function removeFile(target, relative) {
  const filePath = targetPath(target, relative)
  if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true })
}

function copySpecBackup(target) {
  const specDir = path.join(target, SPEC_DIR)
  if (!fs.existsSync(specDir)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupSpec = path.join(target, BACKUP_ROOT, stamp, 'spec')
  ensureWritableDirectory(path.dirname(backupSpec))
  fs.cpSync(specDir, backupSpec, { recursive: true, force: true })
  return toPosix(path.relative(target, backupSpec))
}

function specRelative(targetRelative) {
  return targetRelative.slice(`${SPEC_DIR}/`.length)
}

function buildPlanData({
  target,
  templateId,
  action,
  templateFiles,
  templateMarker,
  registrySource,
  hashes,
  computeHash,
}) {
  const marker = readTargetMarker(target)
  const specPrefix = `${SPEC_DIR}/`
  const specHashes = Object.fromEntries(
    Object.entries(hashes).filter(([key]) => key.startsWith(specPrefix)),
  )
  const templateSet = new Set(templateFiles.keys())
  const files = { add: [], update: [], keep: [], conflict: [], delete: [], keepDeleted: [] }
  const details = new Map()

  for (const [relative, content] of templateFiles) {
    const targetRelative = `${specPrefix}${relative}`
    const absolute = targetPath(target, targetRelative)
    const exists = fs.existsSync(absolute)
    const templateHash = computeHash(content)
    const currentHash = exists ? computeHash(fs.readFileSync(absolute, 'utf8')) : null
    const oldHash = specHashes[targetRelative]
    let kind
    if (!exists) {
      kind = oldHash ? 'keepDeleted' : 'add'
    } else if (currentHash === templateHash) {
      kind = 'keep'
    } else if (oldHash && oldHash === currentHash) {
      kind = 'update'
    } else {
      kind = 'conflict'
    }
    files[kind].push(relative)
    details.set(relative, {
      kind,
      targetRelative,
      templateHash,
      oldHash,
      missingTemplateFile: !exists,
    })
  }

  for (const [targetRelative, oldHash] of Object.entries(specHashes)) {
    const relative = specRelative(targetRelative)
    if (templateSet.has(relative)) continue
    const absolute = targetPath(target, targetRelative)
    if (!fs.existsSync(absolute)) {
      details.set(relative, { kind: 'orphanMissing', targetRelative, oldHash })
      continue
    }
    const currentHash = computeHash(fs.readFileSync(absolute, 'utf8'))
    if (currentHash === oldHash) {
      files.delete.push(relative)
      details.set(relative, { kind: 'delete', targetRelative, oldHash })
    } else {
      files.keepDeleted.push(relative)
      details.set(relative, { kind: 'orphanModified', targetRelative, oldHash })
    }
  }

  return {
    action,
    template: templateId,
    currentTemplate: marker.data?.template ?? null,
    version: templateMarker.version ?? null,
    generatedAt: templateMarker.generatedAt ?? null,
    registrySource: redact(registrySource),
    source: registrySource,
    markerInvalid: marker.invalid,
    entrypoints: ['frontend/index.md', 'backend/index.md'].filter((entry) =>
      templateFiles.has(entry),
    ),
    files,
    details,
    hashes,
  }
}

async function plan({ target, registrySource, registry, templateId, modules }) {
  const indexUrl = `${registry.rawBaseUrl}/index.json`
  const probe = await modules.fetcher.probeRegistryIndex(indexUrl, registry)
  if (probe.error) {
    return {
      error: failure(classifyRegistryError(probe.error.message), probe.error.message),
    }
  }
  if (probe.isNotFound) {
    return { error: failure('template_not_found', 'registry index.json not found') }
  }
  const template = probe.templates.find((item) => item.id === templateId)
  if (!template) {
    return { error: failure('template_not_found', `template ${templateId} not found`) }
  }
  if (template.type !== 'spec') {
    return { error: failure('template_invalid', `template ${templateId} is not a spec`) }
  }

  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `company-spec-${process.pid}-`))
  const templateRoot = path.join(tempRoot, 'template')
  try {
    const downloaded = await modules.fetcher.downloadTemplateById(
      tempRoot,
      templateId,
      'overwrite',
      template,
      registry,
      templateRoot,
      probe.backend,
    )
    if (!downloaded.success) {
      return {
        error: failure(classifyRegistryError(downloaded.message), downloaded.message),
      }
    }
    const templateMarker = readTemplateMarker(templateRoot)
    if (!templateMarker || templateMarker.template !== templateId) {
      return {
        error: failure('template_invalid', `template ${templateId} has no valid marker`),
      }
    }
    const templateFiles = collectTemplateFiles(templateRoot)
    if (!templateFiles.has('frontend/index.md') && !templateFiles.has('backend/index.md')) {
      return {
        error: failure('template_invalid', `template ${templateId} has no entrypoint`),
      }
    }

    const marker = readTargetMarker(target)
    let action
    if (!marker.data) action = marker.invalid ? 'replace' : 'apply'
    else if (marker.data.template === templateId) action = 'update'
    else action = 'replace'

    const hashes = modules.templateHash.loadHashes(target)
    const data = buildPlanData({
      target,
      templateId,
      action,
      templateFiles,
      templateMarker,
      registrySource,
      hashes,
      computeHash: modules.templateHash.computeHash,
    })
    return { data, templateFiles, templateMarker }
  } finally {
    await fsp.rm(tempRoot, { recursive: true, force: true })
  }
}

function validateStrategy(action, strategy) {
  if (action === 'update') {
    return strategy === 'keep-local' || strategy === 'overwrite'
  }
  return strategy === 'replace'
}

function applyPlan({ target, planData, templateFiles, modules, strategy }) {
  const specDir = path.join(target, SPEC_DIR)
  let backupPath = null
  const requiresBackup =
    planData.action === 'apply' ||
    planData.action === 'replace' ||
    (planData.action === 'update' && strategy === 'overwrite')
  if (requiresBackup) {
    try {
      backupPath = copySpecBackup(target)
    } catch (error) {
      return failure('backup_failed', error.message)
    }
  }

  const written = []
  const deleted = []
  const kept = [...planData.files.conflict, ...planData.files.keepDeleted]
  try {
    if (planData.action === 'apply' || planData.action === 'replace') {
      if (fs.existsSync(specDir)) fs.rmSync(specDir, { recursive: true, force: true })
      for (const [relative, content] of templateFiles) {
        writeFileText(target, `${SPEC_DIR}/${relative}`, content)
        written.push(relative)
      }
    } else if (strategy === 'overwrite') {
      for (const [relative, content] of templateFiles) {
        const detail = planData.details.get(relative)
        if (detail?.kind === 'orphanModified') continue
        writeFileText(target, `${SPEC_DIR}/${relative}`, content)
        written.push(relative)
      }
      for (const relative of planData.files.delete) {
        removeFile(target, `${SPEC_DIR}/${relative}`)
        deleted.push(relative)
      }
    } else {
      for (const relative of [...planData.files.add, ...planData.files.update]) {
        writeFileText(target, `${SPEC_DIR}/${relative}`, templateFiles.get(relative))
        written.push(relative)
      }
      for (const relative of planData.files.delete) {
        removeFile(target, `${SPEC_DIR}/${relative}`)
        deleted.push(relative)
      }
    }

    const specPrefix = `${SPEC_DIR}/`
    let nextHashes = { ...planData.hashes }
    if (planData.action === 'apply' || planData.action === 'replace') {
      nextHashes = Object.fromEntries(
        Object.entries(nextHashes).filter(([key]) => !key.startsWith(specPrefix)),
      )
    }
    for (const relative of deleted) delete nextHashes[`${specPrefix}${relative}`]
    for (const detail of planData.details.values()) {
      if (detail.kind === 'orphanMissing') delete nextHashes[detail.targetRelative]
    }
    for (const relative of written) {
      nextHashes[`${specPrefix}${relative}`] = modules.templateHash.computeHash(
        templateFiles.get(relative),
      )
    }
    modules.templateHash.saveHashes(target, nextHashes)
  } catch (error) {
    return failure('write_failed', error.message)
  }

  const warnings = []
  try {
    const configPath = path.join(target, '.trellis', 'config.yaml')
    if (!fs.existsSync(configPath)) {
      fs.mkdirSync(path.dirname(configPath), { recursive: true })
      fs.writeFileSync(configPath, 'registry:\n', 'utf8')
    }
    modules.registryConfig.writeSpecRegistryConfig(target, {
      source: planData.source,
      template: planData.template,
    })
    const configText = fs.readFileSync(configPath, 'utf8')
    if (!configText.endsWith('\n')) fs.writeFileSync(configPath, `${configText}\n`, 'utf8')
  } catch (error) {
    warnings.push(`registry config not updated: ${error.message}`)
  }
  try {
    writeFileText(
      target,
      STATE_PATH,
      `${JSON.stringify(
        {
          schema: 1,
          action: planData.action,
          template: planData.template,
          version: planData.version,
          appliedAt: new Date().toISOString(),
          backupPath,
        },
        null,
        2,
      )}\n`,
    )
  } catch (error) {
    warnings.push(`state not updated: ${error.message}`)
  }

  return {
    ok: true,
    applied: true,
    action: planData.action,
    template: planData.template,
    version: planData.version,
    backupPath,
    written,
    kept,
    deleted,
    warning: warnings.length > 0 ? warnings.join('; ') : null,
  }
}

async function main() {
  let values
  try {
    values = parseCliArgs(process.argv.slice(2))
  } catch (error) {
    emit(failure('invalid_args', error.message))
    return 1
  }
  if (
    !values.cli ||
    !values.target ||
    !values.registry ||
    !values.template ||
    !['plan', 'apply'].includes(values.mode)
  ) {
    emit(failure('invalid_args', 'missing required arguments'))
    return 1
  }
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(values.template)) {
    emit(failure('invalid_args', 'invalid template id'))
    return 1
  }
  const target = path.resolve(values.target)
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    emit(failure('target_invalid', 'target is not a directory'))
    return 1
  }

  let modules
  try {
    modules = await loadCliModules(path.resolve(values.cli))
  } catch (error) {
    emit(failure('helper_incompatible', error.message))
    return 1
  }

  let registry
  try {
    registry = modules.fetcher.parseRegistrySource(values.registry)
  } catch (error) {
    emit(failure('registry_unreachable', error.message))
    return 1
  }

  let planned
  try {
    planned = await plan({
      target,
      registrySource: values.registry,
      registry,
      templateId: values.template,
      modules,
    })
  } catch (error) {
    emit(failure('registry_unreachable', error.message))
    return 1
  }
  if (planned.error) {
    emit(planned.error)
    return 1
  }

  if (values.mode === 'plan') {
    const { data } = planned
    emit({
      ok: true,
      plan: {
        action: data.action,
        template: data.template,
        currentTemplate: data.currentTemplate,
        version: data.version,
        generatedAt: data.generatedAt,
        registrySource: data.registrySource,
        markerInvalid: data.markerInvalid,
        requiresBackup:
          data.action === 'apply' ||
          data.action === 'replace' ||
          (data.action === 'update' && values.strategy === 'overwrite'),
        entrypoints: data.entrypoints,
        files: data.files,
      },
    })
    return 0
  }

  const strategy = values.strategy ?? (planned.data.action === 'update' ? 'keep-local' : 'replace')
  if (!validateStrategy(planned.data.action, strategy)) {
    emit(
      failure(
        'invalid_args',
        `strategy ${strategy} is not valid for action ${planned.data.action}`,
      ),
    )
    return 1
  }
  if (planned.data.markerInvalid && planned.data.action === 'update' && strategy === 'keep-local') {
    emit(failure('marker_invalid', 'company spec marker is invalid'))
    return 1
  }

  const result = applyPlan({
    target,
    planData: planned.data,
    templateFiles: planned.templateFiles,
    modules,
    strategy,
  })
  emit(result)
  return result.ok ? 0 : 1
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    emit(failure('write_failed', error.message))
    process.exitCode = 1
  })
