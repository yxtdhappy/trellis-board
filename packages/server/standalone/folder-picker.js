import { spawn } from 'node:child_process'
import { appDir } from '../config.js'
import { PATHS } from './state.js'

export function pickFoldersFromDesktop(state) {
  if (state.folderPickerActive) {
    return Promise.reject(new Error('文件夹选择框已经打开，请先完成当前选择'))
  }
  state.folderPickerActive = true

  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        PATHS.folderPickerFile,
      ],
      {
        cwd: appDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (handler, value) => {
      if (settled) return
      settled = true
      state.folderPickerActive = false
      handler(value)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.once('error', (error) => finish(reject, error))
    child.once('close', (code) => {
      if (code !== 0) {
        finish(reject, new Error(stderr.trim() || `文件夹选择器退出码 ${code}`))
        return
      }
      try {
        const marker = 'TRELLIS_JSON:'
        const jsonLine = stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.startsWith(marker))
          .pop()
        if (!jsonLine) throw new Error('文件夹选择器没有返回路径结果')
        const parsed = JSON.parse(jsonLine.slice(marker.length))
        if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
          throw new Error('文件夹选择器返回了无效结果')
        }
        finish(resolve, parsed)
      } catch (error) {
        finish(reject, error)
      }
    })
  })
}
