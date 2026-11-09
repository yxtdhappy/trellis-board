import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const ENTRY = path.join(HERE, 'sea-entry.js')
const DPAPI_SCRIPT = path.join(REPO_ROOT, 'agent', 'windows', 'dpapi.ps1')

export function createSeaConfig({ bundleFile, blobFile, dpapiScript }) {
  return {
    main: bundleFile,
    output: blobFile,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
    assets: {
      'dpapi.ps1': dpapiScript,
    },
  }
}

async function loadEsbuild() {
  try {
    return await import('esbuild')
  } catch (error) {
    throw new Error(
      '缺少 esbuild。请先执行 `npm --prefix desktop install` 安装固定版本的构建期依赖。',
      { cause: error },
    )
  }
}

export async function bundleSidecar(options = {}) {
  const bundleFile = path.resolve(options.bundleFile)
  const blobFile = path.resolve(options.blobFile)
  const seaConfigFile = path.resolve(options.seaConfigFile)
  const dpapiScript = path.resolve(options.dpapiScript || DPAPI_SCRIPT)
  const entry = path.resolve(options.entry || ENTRY)
  await fs.access(entry)
  await fs.access(dpapiScript)
  await fs.mkdir(path.dirname(bundleFile), { recursive: true })
  const esbuild = await loadEsbuild()
  await esbuild.build({
    entryPoints: [entry],
    outfile: bundleFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'silent',
  })
  const seaConfig = createSeaConfig({ bundleFile, blobFile, dpapiScript })
  await fs.writeFile(seaConfigFile, `${JSON.stringify(seaConfig, null, 2)}\n`, 'utf8')
  return { bundleFile, blobFile, seaConfigFile, dpapiScript }
}

function parseArgs(argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      throw new Error(`未知参数：${token}`)
    }
    const [key, inline] = token.slice(2).split('=', 2)
    const value = inline ?? argv[++index]
    if (!value) {
      throw new Error(`参数 --${key} 缺少值`)
    }
    options[key] = value
  }
  return options
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(
      'node desktop/sidecar/bundle.mjs --bundle <file.cjs> --blob <sea.blob> --sea-config <sea-config.json>\n',
    )
    return 0
  }
  const result = await bundleSidecar({
    bundleFile: options.bundle,
    blobFile: options.blob,
    seaConfigFile: options['sea-config'],
    dpapiScript: options.dpapi,
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    })
}
