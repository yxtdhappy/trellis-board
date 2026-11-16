import { createPlugin } from '../../../../../packages/server/plugins/sdk.js'

export default createPlugin({
  name: 'jenkins-caller',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['capabilities:call', 'http:route'],

  async onStart(ctx) {
    ctx.http.route('GET', '/jobs', async () => {
      try {
        const result = await ctx.capabilities.call('jenkins.ops', 'jobs.list', {})
        return { status: 200, body: { result } }
      } catch (error) {
        return { status: 503, body: { code: error.code ?? null, message: error.message } }
      }
    })

    ctx.http.route('GET', '/trigger', async (request) => {
      try {
        const result = await ctx.capabilities.call('jenkins.ops', 'build.trigger', {
          job: request.query.job,
          parameters: { TARGET: request.query.target ?? 'staging' },
          wait: true,
        })
        return { status: 200, body: { result } }
      } catch (error) {
        return { status: 503, body: { code: error.code ?? null, message: error.message } }
      }
    })

    ctx.http.route('GET', '/undeclared', async () => {
      try {
        const result = await ctx.capabilities.call('jenkins.ops', 'queue.cancel', { id: 1 })
        return { status: 200, body: { result } }
      } catch (error) {
        return { status: 403, body: { code: error.code ?? null, message: error.message } }
      }
    })
  },
})
