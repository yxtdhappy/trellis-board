import { createPlugin } from '../../../../../packages/server/plugins/sdk.js'

export default createPlugin({
  name: 'secrets-writer',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['http:route', 'secrets:read', 'secrets:write'],

  async onStart(ctx) {
    ctx.http.route('POST', '/secret', async (request) => {
      const body = request.json()
      const stored = await ctx.secrets.set(body.key, body.value)
      return { status: 200, body: { stored } }
    })

    ctx.http.route('GET', '/secret', async (request) => ({
      status: 200,
      body: { value: await ctx.secrets.get(request.query.key) },
    }))

    ctx.http.route('POST', '/secret/delete', async (request) => {
      const body = request.json()
      return { status: 200, body: { deleted: await ctx.secrets.delete(body.key) } }
    })

    ctx.http.route('GET', '/env', (request) => ({
      status: 200,
      body: { value: ctx.secrets[request.query.key] ?? null },
    }))
  },
})
