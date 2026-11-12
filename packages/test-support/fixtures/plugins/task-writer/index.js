import { createPlugin } from '../../../../../apps/server/plugins/sdk.js'

export default createPlugin({
  name: 'task-writer',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['tasks:read', 'tasks:write', 'events', 'store', 'http:route'],

  async onStart(ctx) {
    ctx.events.on('*', async (event) => {
      await ctx.store.set(`last:${event.name}`, event.payload)
    })
    ctx.http.route('POST', '/create', async (request) => ({
      status: 200,
      body: await ctx.tasks.create(request.json()),
    }))
    ctx.http.route('POST', '/assign', async (request) => ({
      status: 200,
      body: await ctx.tasks.assign(request.json()),
    }))
    ctx.http.route('POST', '/stage', async (request) => ({
      status: 200,
      body: await ctx.tasks.setStage(request.json()),
    }))
  },
})
