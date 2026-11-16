import { createPlugin } from '../../../../../apps/server/plugins/sdk.js'

export default createPlugin({
  name: 'panel-alpha',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['panels'],
})
