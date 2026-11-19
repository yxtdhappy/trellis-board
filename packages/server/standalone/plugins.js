import fs from 'node:fs'
import path from 'node:path'
import { appDir, dataDir, pluginsDir } from '../config.js'
import { getRepositories } from '../repositories.js'
import { createPluginRuntime } from '../plugins/runtime.js'
import { sendJson } from './http-io.js'
import { readScanCache } from './refresh.js'
import { createRepositoryService } from './repositories.js'

export async function startPluginRuntime(state) {
  if (!state.database) return
  let hostVersion = '0.0.0'
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'))
    hostVersion = String(manifest.version || hostVersion)
  } catch {
    // package.json 不可读时以 0.0.0 启动；版本校验会因此拒绝 engines 有下界的插件。
  }
  state.pluginRuntime = createPluginRuntime({
    db: state.database,
    appDir,
    dataDir,
    pluginsDir,
    hostVersion,
    repositories: getRepositories(),
    repositoryService: createRepositoryService(state),
    boardProvider: () => state.boardCache || readScanCache(state),
    logger: state.logger,
  })
  try {
    await state.pluginRuntime.load()
    const started = await state.pluginRuntime.start()
    if (!started.disabled) {
      state.logger.log(`Trellis 插件: ${started.plugins.length} 个已加载`)
    }
  } catch (error) {
    state.logger.error('加载插件失败，核心功能继续运行', error)
  }
}

function serverContext(request, response, url) {
  return { request, response, url, sendJson }
}

export async function handlePluginRequest(state, request, response, url) {
  if (!state.pluginRuntime) return false
  try {
    return await state.pluginRuntime.handleHttp(serverContext(request, response, url))
  } catch (error) {
    state.logger.error('插件路由处理失败', error)
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : '插件请求失败',
    })
    return true
  }
}
