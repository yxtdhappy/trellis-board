import { createPlugin } from '../../../../../packages/server/plugins/sdk.js'

export default createPlugin({
  name: 'oversized-frame',
  version: '1.0.0',
  apiVersion: 1,
  permissions: [],

  async onStart() {
    // 故意绕过 SDK 的 encodeFrame，直接向 stdout 写一个超过 1 MiB 的协议帧。
    setTimeout(() => {
      const frame = {
        jsonrpc: '2.0',
        method: 'log/write',
        params: { level: 'info', message: 'x'.repeat(1024 * 1024 + 1024) },
      }
      process.stdout.write(`${JSON.stringify(frame)}\n`)
    }, 50)
  },
})
