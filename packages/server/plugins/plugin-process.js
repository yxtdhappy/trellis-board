import {
  ERROR_CODES,
  MAX_FRAME_BYTES,
  RpcError,
  encodeFrame,
  createFrameDecoder,
  successResponse,
  errorResponse,
  notificationFrame,
  requestFrame,
  isRequest,
  isNotification,
  isResponse,
} from './protocol.js'
import { terminateTree } from '../team/process.js'

export class PluginProcess {
  constructor(runtime, entry, { command, args, cwd, env }) {
    this.runtime = runtime
    this.entry = entry
    this.command = command
    this.args = args
    this.cwd = cwd
    this.env = env
    this.child = null
    this.decoder = null
    this.pending = new Map()
    this.sequence = 0
    this.stopping = false
    this.exited = false
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve
    })
  }

  start() {
    this.child = this.runtime.spawnImpl(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.decoder = createFrameDecoder({
      maxBytes: MAX_FRAME_BYTES,
      onMessage: (message) => this.handleMessage(message),
      onError: (error) => {
        this.runtime.recordError(this.entry, error.message)
        this.runtime.audit(this.entry, 'protocol-error', { message: error.message })
        if (error.code === ERROR_CODES.RATE_LIMITED) {
          // 超过 1 MiB 说明帧边界已不可信，继续解析只会读到半截数据，直接断开进程。
          this.runtime.audit(this.entry, 'frame-too-large', { message: error.message })
          this.kill()
        }
      },
    })
    this.child.stdout.on('data', (chunk) => this.decoder.push(chunk))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) this.runtime.writeLog(this.entry, 'stderr', line, {})
      }
    })
    this.child.once('error', (error) => {
      this.runtime.recordError(this.entry, error.message)
      this.rejectAll(error)
    })
    this.child.once('exit', (code, signal) => {
      this.exited = true
      this.rejectAll(new Error(`插件进程已退出（code=${code}, signal=${signal ?? '-'}）`))
      this.resolveExit({ code, signal })
      this.runtime.handleExit(this.entry, { code, signal })
    })
    return this
  }

  handleMessage(message) {
    if (isResponse(message)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        const error = new RpcError(
          message.error.data?.code ?? ERROR_CODES.INTERNAL_ERROR,
          message.error.message || '插件返回错误',
          { rpcCode: message.error.code, data: message.error.data?.detail },
        )
        pending.reject(error)
      } else {
        pending.resolve(message.result)
      }
      return
    }
    if (isRequest(message)) {
      this.runtime.handlePluginRequest(this.entry, message).then(
        (result) => this.write(successResponse(message.id, result)),
        (error) => {
          const payload = errorResponse(message.id, error)
          this.write(payload)
        },
      )
      return
    }
    if (isNotification(message)) {
      this.runtime.handlePluginNotification(this.entry, message)
    }
  }

  write(message) {
    if (!this.child || this.exited || this.child.stdin.destroyed) return false
    try {
      this.child.stdin.write(encodeFrame(message))
      return true
    } catch (error) {
      this.runtime.recordError(this.entry, error.message)
      return false
    }
  }

  request(method, params, timeoutMs) {
    if (!this.child || this.exited) {
      return Promise.reject(new RpcError(ERROR_CODES.DISABLED, '插件进程未运行'))
    }
    const id = `h${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        // 超时只取消当前请求，不终止进程；插件可以忽略取消通知，宿主不再等待结果。
        this.notify('request/cancel', { id })
        reject(new RpcError(ERROR_CODES.TIMEOUT, `插件请求超时: ${method}`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      this.write(requestFrame(id, method, params))
    })
  }

  notify(method, params) {
    return this.write(notificationFrame(method, params))
  }

  cancelRequest(id) {
    return this.notify('request/cancel', { id })
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  async stop(graceMs) {
    this.stopping = true
    try {
      await this.request('shutdown', {}, this.runtime.timeoutFor('shutdown'))
    } catch {
      // 插件可能已经退出或不响应，继续走终止流程。
    }
    const exited = await Promise.race([
      this.exitPromise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), graceMs)),
    ])
    if (!exited && this.child) await terminateTree(this.child)
    await Promise.race([this.exitPromise, new Promise((resolve) => setTimeout(resolve, graceMs))])
  }

  kill() {
    if (this.child && !this.exited) void terminateTree(this.child)
  }
}
