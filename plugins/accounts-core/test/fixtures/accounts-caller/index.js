import { createPlugin } from '../../../../../packages/server/plugins/sdk.js'

export default createPlugin({
  name: 'accounts-caller',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['capabilities:call', 'http:route'],

  async onStart(ctx) {
    async function call(method, params) {
      try {
        return {
          status: 200,
          body: { result: await ctx.capabilities.call('accounts.credentials', method, params) },
        }
      } catch (error) {
        return { status: 503, body: { code: error.code ?? null, message: error.message } }
      }
    }

    ctx.http.route('GET', '/resolve', (request) =>
      call('credential.resolve', { system: request.query.system }),
    )
    ctx.http.route('GET', '/accounts', () => call('accounts.list', {}))
    ctx.http.route('GET', '/systems', () => call('systems.list', {}))
  },
})
