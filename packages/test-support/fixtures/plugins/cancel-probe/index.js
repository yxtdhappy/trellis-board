import fs from 'node:fs'
import { createPlugin } from '../../../../../apps/server/plugins/sdk.js'

export default createPlugin({
  name: 'cancel-probe',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['http:route'],

  async onStart(ctx) {
    ctx.http.route('GET', '/slow', async (request) => {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000)
        request.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true },
        )
      })
      fs.writeFileSync(process.env.CANCEL_TRACE, request.signal?.aborted ? 'cancelled' : 'timeout')
      return { ok: true }
    })
  },
})
