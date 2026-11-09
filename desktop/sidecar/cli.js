import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSidecarMain, SIDECAR_EXIT_CODE } from './main.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DPAPI_SCRIPT = path.join(HERE, '..', '..', 'agent', 'windows', 'dpapi.ps1')

runSidecarMain(process.argv.slice(2), {
  fallbackDpapiScript: DPAPI_SCRIPT,
})
  .then((exitCode) => {
    process.exitCode = exitCode
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = SIDECAR_EXIT_CODE.IO
  })
