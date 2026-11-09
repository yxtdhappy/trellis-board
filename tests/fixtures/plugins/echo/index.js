import { createPlugin } from '../../../../server/plugins/sdk.js'

export default createPlugin({
  name: 'echo',
  version: '1.0.0',
  apiVersion: 1,
  permissions: [
    'tasks:read',
    'store',
    'events',
    'events:emit',
    'http:route',
    'http:root',
    'schedule',
  ],

  async onStart(ctx) {
    ctx.http.route('GET', '/echo', (request) => ({
      status: 200,
      body: { ok: true, path: request.path, plugin: ctx.plugin.id },
    }))
    ctx.http.route('POST', '/store', async (request) => {
      const { key, value } = request.json()
      await ctx.store.set(key, value)
      return { status: 200, body: { value: await ctx.store.get(key) } }
    })
    ctx.http.route('POST', '/emit', async (request) => {
      const { name, payload } = request.json()
      const emitted = await ctx.events.emit(name, payload)
      return { status: 200, body: emitted }
    })
    ctx.http.route('GET', '/tasks', async () => ({
      status: 200,
      body: { tasks: await ctx.tasks.list({}) },
    }))
    ctx.http.public('POST', '/fixtures/echo', async (request) => ({
      status: 200,
      body: { received: request.json(), plugin: ctx.plugin.id },
    }))
    ctx.events.on('*', async (event) => {
      await ctx.store.set(`last:${event.name}`, event.payload)
    })
  },
})
