import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const cliPath = process.argv[2]
const args = process.argv.slice(3)
const platformIds = args.filter((argument) => !argument.startsWith('--'))

if (!cliPath || platformIds.length === 0) {
  throw new Error('用法: node agent-configurator-probe.mjs <trellis.js> <platform-id...>')
}

const packageRoot = path.resolve(path.dirname(cliPath), '..')
const load = (relativePath) =>
  import(pathToFileURL(path.join(packageRoot, ...relativePath.split('/'))).href)

const [{ configurePlatform }, writer, hash] = await Promise.all([
  load('dist/configurators/index.js'),
  load('dist/utils/file-writer.js'),
  load('dist/utils/template-hash.js'),
])

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-agent-probe-'))
process.env.TRELLIS_QUIET = '1'
writer.setWriteMode('skip')
fs.mkdirSync(path.join(tempDir, '.trellis'), { recursive: true })
const written = writer.startRecordingWrites(tempDir)

try {
  for (const platformId of platformIds) {
    await configurePlatform(platformId, tempDir, { withStatusline: false })
  }
} finally {
  writer.stopRecordingWrites()
}

const hashCount = hash.initializeHashes(tempDir, { trackedPaths: written, merge: true })
const files = []

function walk(current) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const fullPath = path.join(current, entry.name)
    if (entry.isDirectory()) {
      walk(fullPath)
    } else {
      files.push(path.relative(tempDir, fullPath).replaceAll('\\', '/'))
    }
  }
}

walk(tempDir)
console.log(
  JSON.stringify(
    {
      tempDir,
      platformIds,
      hashCount,
      hasSpecDirectory: files.some((file) => file.startsWith('.trellis/spec/')),
      fileCount: files.length,
      files: args.includes('--files') ? files : undefined,
    },
    null,
    2,
  ),
)

fs.rmSync(tempDir, { recursive: true, force: true })
