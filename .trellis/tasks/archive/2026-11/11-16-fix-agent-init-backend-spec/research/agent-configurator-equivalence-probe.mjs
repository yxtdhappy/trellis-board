import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const cliPath = process.argv[2]
if (!cliPath) {
  throw new Error('用法: node agent-configurator-equivalence-probe.mjs <trellis.js>')
}

const packageRoot = path.resolve(path.dirname(cliPath), '..')
const load = (relativePath) =>
  import(pathToFileURL(path.join(packageRoot, ...relativePath.split('/'))).href)
const [{ configurePlatform }, writer, hash] = await Promise.all([
  load('dist/configurators/index.js'),
  load('dist/utils/file-writer.js'),
  load('dist/utils/template-hash.js'),
])

const platformIds = ['cursor', 'claude-code', 'codex']
const platformRoots = ['.cursor', '.claude', '.codex']
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-agent-equivalence-'))
const fullDir = path.join(tempRoot, 'full')
const agentOnlyDir = path.join(tempRoot, 'agent-only')

function writePackageJson(directory) {
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({ name: 'probe', dependencies: { vue: '2.7.16' } }, null, 2),
  )
}

function walk(root) {
  const files = []
  if (!fs.existsSync(root)) return files
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...walk(fullPath))
    } else {
      files.push(fullPath)
    }
  }
  return files
}

function collect(directory) {
  const result = new Map()
  for (const root of platformRoots) {
    const absoluteRoot = path.join(directory, root)
    for (const absolutePath of walk(absoluteRoot)) {
      const relativePath = path
        .relative(directory, absolutePath)
        .replaceAll('\\', '/')
      result.set(relativePath, crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex'))
    }
  }
  return result
}

function manifestPlatformKeys(directory) {
  const manifestPath = path.join(directory, '.trellis', '.template-hashes.json')
  const payload = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  return Object.keys(payload.hashes)
    .filter((key) => platformRoots.some((root) => key === root || key.startsWith(`${root}/`)))
    .sort()
}

let full
let agentOnly
try {
  writePackageJson(fullDir)
  const fullArgs = [
    cliPath,
    'init',
    '-y',
    '--skip-existing',
    '-u',
    'probe-user',
    '--cursor',
    '--claude',
    '--codex',
  ]
  full = spawnSync(process.execPath, fullArgs, {
    cwd: fullDir,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, TRELLIS_QUIET: '1' },
  })
  if (full.status !== 0) {
    throw new Error(`full init failed: ${full.status}\n${full.stdout}\n${full.stderr}`)
  }

  writePackageJson(agentOnlyDir)
  fs.mkdirSync(path.join(agentOnlyDir, '.trellis'), { recursive: true })
  writer.setWriteMode('skip')
  const written = writer.startRecordingWrites(agentOnlyDir)
  try {
    for (const platformId of platformIds) {
      await configurePlatform(platformId, agentOnlyDir, { withStatusline: false })
    }
  } finally {
    writer.stopRecordingWrites()
  }
  hash.initializeHashes(agentOnlyDir, { trackedPaths: written, merge: true })

  const fullFiles = collect(fullDir)
  const agentOnlyFiles = collect(agentOnlyDir)
  const allPaths = [...new Set([...fullFiles.keys(), ...agentOnlyFiles.keys()])].sort()
  const mismatches = allPaths.filter((relativePath) => fullFiles.get(relativePath) !== agentOnlyFiles.get(relativePath))
  const fullManifest = manifestPlatformKeys(fullDir)
  const agentOnlyManifest = manifestPlatformKeys(agentOnlyDir)

  console.log(
    JSON.stringify(
      {
        tempRoot,
        platformFilesMatch: mismatches.length === 0,
        mismatchCount: mismatches.length,
        mismatches: mismatches.slice(0, 20),
        manifestKeysMatch: JSON.stringify(fullManifest) === JSON.stringify(agentOnlyManifest),
        fullManifestCount: fullManifest.length,
        agentOnlyManifestCount: agentOnlyManifest.length,
        missingManifestKeys: fullManifest.filter((key) => !agentOnlyManifest.includes(key)).slice(0, 20),
        extraManifestKeys: agentOnlyManifest.filter((key) => !fullManifest.includes(key)).slice(0, 20),
      },
      null,
      2,
    ),
  )
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true })
}
