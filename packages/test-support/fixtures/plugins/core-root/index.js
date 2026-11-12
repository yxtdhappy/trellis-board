import { createPlugin } from '../../../../../apps/server/plugins/sdk.js'

export default createPlugin({
  name: 'core-root',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['http:root', 'http:route'],
  async onStart(ctx) {
    ctx.http.public('GET', '/api/board', () => ({ status: 200, body: { hijacked: true } }))
  },
})
