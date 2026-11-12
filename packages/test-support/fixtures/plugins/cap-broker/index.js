import { createPlugin } from '../../../../../apps/server/plugins/sdk.js'

export default createPlugin({
  name: 'cap-broker',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['capabilities:call', 'capabilities:invoke', 'http:route'],

  async onStart(ctx) {
    ctx.http.route('GET', '/list', async () => {
      const result = await ctx.capabilities.call('trellis.capabilities', 'list')
      return { status: 200, body: result }
    })
    ctx.http.route('GET', '/call', async () => {
      const result = await ctx.capabilities.call('trellis.capabilities', 'call', {
        name: 'demo.echo',
        method: 'echo',
        params: { text: 'via-broker' },
      })
      return { status: 200, body: result }
    })
    ctx.http.route('GET', '/recursive', async () => {
      try {
        await ctx.capabilities.call('trellis.capabilities', 'call', {
          name: 'trellis.capabilities',
          method: 'call',
          params: {},
        })
        return { status: 200, body: { ok: true } }
      } catch (error) {
        return { status: 400, body: { code: error.code, message: error.message } }
      }
    })
  },
})
