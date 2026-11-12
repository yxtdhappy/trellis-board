import { createPlugin } from '../../../../../apps/server/plugins/sdk.js'

export default createPlugin({
  name: 'repo-consumer',
  version: '1.0.0',
  apiVersion: 1,
  permissions: [
    'capabilities:call',
    'repositories:read',
    'repositories:write',
    'projects:read',
    'http:route',
  ],

  async onStart(ctx) {
    ctx.http.route('GET', '/list', async () => {
      try {
        return { status: 200, body: await ctx.capabilities.call('trellis.repositories', 'list') }
      } catch (error) {
        return { status: 403, body: { code: error.code, message: error.message } }
      }
    })
    ctx.http.route('GET', '/project', async () => {
      try {
        return {
          status: 200,
          body: await ctx.capabilities.call('trellis.projects', 'current', {
            repositoryId: 'demo-repository',
          }),
        }
      } catch (error) {
        return { status: 403, body: { code: error.code, message: error.message } }
      }
    })
    ctx.http.route('POST', '/add', async (request) => {
      try {
        const body = request.json()
        return {
          status: 200,
          body: await ctx.capabilities.call('trellis.repositories', 'add', body, {
            timeoutMs: 120_000,
          }),
        }
      } catch (error) {
        return { status: 403, body: { code: error.code, message: error.message } }
      }
    })
  },
})
