import fs from 'node:fs'

const LOG_RING_LIMIT = 500
const LOG_FILE_LIMIT = 10 * 1024 * 1024
const LOG_FILE_KEEP = 3

export function createLogRing(limit = LOG_RING_LIMIT) {
  const entries = []
  return {
    push(entry) {
      entries.push(entry)
      if (entries.length > limit) entries.splice(0, entries.length - limit)
    },
    list(tail = 200) {
      return entries.slice(-Math.max(1, Math.min(limit, Number(tail) || 200)))
    },
  }
}

export function rotateLogFile(file) {
  if (!fs.existsSync(file)) return
  if (fs.statSync(file).size < LOG_FILE_LIMIT) return
  for (let index = LOG_FILE_KEEP - 1; index >= 1; index -= 1) {
    const from = index === 1 ? file : `${file}.${index}`
    const to = `${file}.${index + 1}`
    if (fs.existsSync(from)) {
      try {
        fs.renameSync(from, to)
      } catch {
        // 轮转失败不能影响插件运行。
      }
    }
  }
  try {
    fs.renameSync(file, `${file}.1`)
  } catch {
    // 当前文件改名失败时保留原文件，下一次轮转再试。
  }
}

/**
 * 一个插件子进程的封装：spawn、帧解码、请求 id、超时与终止。
 */
