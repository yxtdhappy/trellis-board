import { createPlugin } from '../../../../../packages/server/plugins/sdk.js'

export default createPlugin({
  name: 'root-dup',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['http:root', 'http:route'],
  async onStart(ctx) {
    ctx.http.public('POST', '/fixtures/echo', () => ({ status: 200, body: { plugin: 'root-dup' } }))
  },
})
