import { createPlugin } from '../../../../server/plugins/sdk.js'

export default createPlugin({
  name: 'slow',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['http:route'],

  async onStart(ctx, config) {
    const delay = Number(config.initializeDelayMs ?? 500)
    await new Promise((resolve) => setTimeout(resolve, delay))
    ctx.http.route('GET', '/slow', () => ({ status: 200, body: { ok: true } }))
  },
})
