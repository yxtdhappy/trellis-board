import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../../apps/server/database.js'
import { createPluginStore } from '../../apps/server/plugins/store.js'
import { createTaskService } from '../../apps/server/plugins/task-service.js'
import { createPluginRuntime } from '../../apps/server/plugins/runtime.js'

export const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export function makeWorkspace({ withRepository = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trellis-plugin-'))
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const repositoryPath = path.join(root, 'repo')
  const repositories = []
  if (withRepository) {
    fs.mkdirSync(path.join(repositoryPath, '.trellis', 'tasks'), { recursive: true })
    fs.mkdirSync(path.join(repositoryPath, '.trellis', 'workspace', 'alice'), { recursive: true })
    fs.mkdirSync(path.join(repositoryPath, '.trellis', 'scripts'), { recursive: true })
    fs.writeFileSync(
      path.join(repositoryPath, '.trellis', 'scripts', 'task.py'),
      "import sys\nprint('fake task.py')\n",
    )
    repositories.push({ id: 'repo', name: 'Repo', path: repositoryPath })
  }
  return {
    root,
    dataDir,
    repositoryPath,
    repositories,
    databaseFile: path.join(dataDir, 'board.sqlite'),
    configFile: path.join(dataDir, 'plugins.json'),
    legacyFiles: {
      repositoriesFile: path.join(dataDir, 'repos.json'),
      metadataFile: path.join(dataDir, 'task-metadata.json'),
      scanCacheFile: path.join(dataDir, 'scan-cache.json'),
      stateFile: path.join(dataDir, 'board-state.json'),
    },
  }
}

export function openPluginDatabase(workspace) {
  return openDatabase({
    databaseFile: workspace.databaseFile,
    legacyFiles: workspace.legacyFiles,
    fallbackRepositories: [],
    logger: { warn() {} },
    legacyJsonImport: false,
  })
}

export function writePluginConfig(workspace, plugins) {
  fs.writeFileSync(workspace.configFile, JSON.stringify({ plugins }, null, 2))
}

export function fixtureModule(name) {
  return `./packages/test-support/fixtures/plugins/${name}/index.js`
}

export async function createHarness({
  plugins = [],
  hostVersion = '0.1.0',
  env = {},
  restartDelaysMs,
  autoDisableLimit,
  healthIntervalMs = 0,
  timeoutOverrides,
  withRepository = false,
  repositories = null,
  secrets = null,
  start = true,
} = {}) {
  const workspace = makeWorkspace({ withRepository: repositories ? false : withRepository })
  if (repositories) workspace.repositories = repositories
  writePluginConfig(workspace, plugins)
  if (secrets) {
    const secretsFile = path.join(workspace.dataDir, 'plugins.secrets.json')
    fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2), { mode: 0o600 })
    if (process.platform !== 'win32') fs.chmodSync(secretsFile, 0o600)
  }
  const db = openPluginDatabase(workspace)
  const store = createPluginStore({ db })
  const tasks = createTaskService({
    repositories: workspace.repositories,
    db,
    boardProvider: () => null,
  })
  const runtime = createPluginRuntime({
    db,
    appDir,
    dataDir: workspace.dataDir,
    hostVersion,
    repositories: workspace.repositories,
    boardProvider: () => null,
    store,
    tasks,
    configFile: workspace.configFile,
    env,
    logger: { error() {}, warn() {}, log() {} },
    restartDelaysMs,
    autoDisableLimit,
    healthIntervalMs,
    timeoutOverrides,
  })
  await runtime.load()
  if (start) await runtime.start()
  return {
    workspace,
    db,
    store,
    tasks,
    runtime,
    supervisor: runtime.supervisor,
    async cleanup() {
      await runtime.stop().catch(() => {})
      try {
        db.close()
      } catch {
        // 可能已关闭。
      }
      fs.rmSync(workspace.root, { recursive: true, force: true })
    },
  }
}

export function startHttpServer(runtime) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname.startsWith('/api/plugins')) {
      const handled = await runtime.handleHttp({
        request,
        response,
        url,
        sendJson: (target, status, payload) => {
          target.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          target.end(JSON.stringify(payload))
        },
      })
      if (handled) return
    }
    const handled = await runtime.handleHttp({
      request,
      response,
      url,
      sendJson: (target, status, payload) => {
        target.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
        target.end(JSON.stringify(payload))
      },
    })
    if (!handled) {
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: 'not found' }))
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        server,
        port,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

export async function waitFor(predicate, { timeoutMs = 3000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return false
}
