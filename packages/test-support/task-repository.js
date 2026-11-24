import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeWorkspace } from './plugin-runtime.js'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))

export function createTaskRepository() {
  const workspace = makeWorkspace({ withRepository: true })
  fs.mkdirSync(path.join(workspace.repositoryPath, '.trellis', 'workspace', 'bob'), {
    recursive: true,
  })
  // 插件测试直接跑仓库里真实的 task.py，避免用桩掩盖参数不兼容。
  fs.cpSync(
    path.join(REPO_ROOT, '.trellis', 'scripts'),
    path.join(workspace.repositoryPath, '.trellis', 'scripts'),
    { recursive: true },
  )
  return workspace
}
