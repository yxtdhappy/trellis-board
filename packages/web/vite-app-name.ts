import type { Plugin } from 'vite'
import { DEFAULT_APP_NAME, normalizeAppName } from '../server/config.js'
import { loadProjectEnv } from '../server/env-file.js'
import { rewriteHtmlForAppName } from '../server/team/http/common.js'

export function resolveViteAppName(env = process.env): string {
  if (env.TRELLIS_BOARD_APP_NAME == null || String(env.TRELLIS_BOARD_APP_NAME).trim() === '') {
    const fileEnv: Record<string, string> = {}
    loadProjectEnv({ env: fileEnv })
    if (fileEnv.TRELLIS_BOARD_APP_NAME) {
      return normalizeAppName(fileEnv.TRELLIS_BOARD_APP_NAME)
    }
  }
  return normalizeAppName(env.TRELLIS_BOARD_APP_NAME) || DEFAULT_APP_NAME
}

export function injectAppNameHtml(): Plugin {
  const appName = resolveViteAppName()
  return {
    name: 'inject-app-name-html',
    transformIndexHtml: (html) => rewriteHtmlForAppName(html, appName),
  }
}
