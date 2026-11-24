import fs from 'node:fs'
import path from 'node:path'
import { securityHeaders } from '../../http-common.js'
import { ERROR_CODES } from '../errors.js'
import { sendJson } from './common.js'

const PREFIX = '/client-updates/'
const ZIP_NAME_PATTERN = /^[A-Za-z0-9._-]+\.zip$/i

function resolveUpdateFileSpec(name) {
  if (name === 'latest.json') {
    return {
      contentType: 'application/json; charset=utf-8',
      cacheControl: 'no-store, no-cache, must-revalidate',
      disposition: null,
    }
  }
  if (ZIP_NAME_PATTERN.test(name)) {
    return {
      contentType: 'application/zip',
      cacheControl: 'public, max-age=86400',
      disposition: `attachment; filename="${name}"`,
    }
  }
  return null
}

function isValidSingleSegment(name) {
  if (!name || name.length > 255) return false
  if (name === '.' || name === '..') return false
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false
  return !/[\u0000-\u001f\u007f]/.test(name)
}

export function createClientUpdatesHandler({ clientUpdatesDir }) {
  const rootDir = path.resolve(clientUpdatesDir)

  return function serveClientUpdates(request, response, url) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(
        response,
        405,
        { error: '客户端更新资源只支持 GET 或 HEAD', code: ERROR_CODES.INVALID_INPUT },
        { allow: 'GET, HEAD' },
      )
      return
    }

    if (url.pathname === '/client-updates' || url.pathname === '/client-updates/') {
      sendJson(response, 404, { error: '更新文件不存在', code: ERROR_CODES.NOT_FOUND })
      return
    }

    let fileName
    try {
      fileName = decodeURIComponent(url.pathname.slice(PREFIX.length))
    } catch {
      sendJson(response, 400, { error: '更新文件路径编码无效', code: ERROR_CODES.INVALID_INPUT })
      return
    }

    if (!isValidSingleSegment(fileName)) {
      sendJson(response, 400, { error: '更新文件名无效', code: ERROR_CODES.INVALID_INPUT })
      return
    }

    const spec = resolveUpdateFileSpec(fileName)
    if (!spec) {
      sendJson(response, 404, { error: '更新文件不存在', code: ERROR_CODES.NOT_FOUND })
      return
    }

    const candidatePath = path.resolve(rootDir, fileName)
    if (!candidatePath.startsWith(`${rootDir}${path.sep}`)) {
      sendJson(response, 403, { error: '更新文件路径越界', code: ERROR_CODES.FORBIDDEN })
      return
    }

    let realRoot
    let realPath
    let stat
    try {
      realRoot = fs.realpathSync(rootDir)
      realPath = fs.realpathSync(candidatePath)
      stat = fs.statSync(realPath)
    } catch {
      sendJson(response, 404, { error: '更新文件不存在', code: ERROR_CODES.NOT_FOUND })
      return
    }

    if (realPath === realRoot || !realPath.startsWith(`${realRoot}${path.sep}`)) {
      sendJson(response, 403, { error: '更新文件路径越界', code: ERROR_CODES.FORBIDDEN })
      return
    }

    if (!stat.isFile()) {
      sendJson(response, 404, { error: '更新文件不存在', code: ERROR_CODES.NOT_FOUND })
      return
    }

    response.writeHead(200, {
      ...securityHeaders(),
      'content-type': spec.contentType,
      'content-length': stat.size,
      'cache-control': spec.cacheControl,
      ...(spec.disposition ? { 'content-disposition': spec.disposition } : {}),
    })

    if (request.method === 'HEAD') {
      response.end()
      return
    }

    fs.createReadStream(realPath)
      .on('error', () => response.destroy())
      .pipe(response)
  }
}
