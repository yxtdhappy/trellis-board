import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

const serverDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(serverDir, '../..')

export function loadProjectEnv({
  directory = repoRoot,
  env = process.env,
  file = path.join(directory, '.env'),
} = {}) {
  const { error } = dotenv.config({ path: file, processEnv: env, quiet: true })
  if (error && error.code !== 'ENOENT') {
    throw new Error(`读取 .env 失败：${file}（${error.message}）`)
  }
  return { file, loaded: !error }
}
