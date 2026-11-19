import fs from 'node:fs'
import path from 'node:path'
import { appDir } from '../config.js'
import { readJsonBody as readJsonBodyCommon, sendJson as sendJsonCommon } from '../http-common.js'

export { sendJsonCommon as sendJson }

export function readPackageVersion(manifestPath) {
  try {
    return String(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).version || '0.0.0')
  } catch {
    return '0.0.0'
  }
}

export const SERVER_VERSION = readPackageVersion(path.join(appDir, 'package.json'))

export function readJsonBody(request) {
  return readJsonBodyCommon(request, {
    errors: {
      tooLarge: () => new Error('请求体过大'),
      invalidJson: () => new Error('请求体不是合法 JSON'),
    },
  })
}
