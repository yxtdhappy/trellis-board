import { createPlugin } from '../../../../server/plugins/sdk.js'

export default createPlugin({
  name: 'repo-reader-without-permission',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['capabilities:call', 'http:route'],

  async onStart(ctx) {
    ctx.http.route('GET', '/list', async () => {
      try {
        return { status: 200, body: await ctx.capabilities.call('trellis.repositories', 'list') }
      } catch (error) {
        return {
          status: error.code === 1001 ? 403 : 500,
          body: { code: error.code, message: error.message },
        }
      }
    })
  },
})
