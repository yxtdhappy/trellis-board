import { createPlugin } from '../../../../../apps/server/plugins/sdk.js'

export default createPlugin({
  name: 'crash-on-event',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['events'],

  async onStart(ctx) {
    ctx.events.on('crash', () => {
      setTimeout(() => process.exit(3), 5)
    })
  },
})
