import { createPlugin } from '../../../../../packages/server/plugins/sdk.js'

export default createPlugin({
  name: 'panel-beta',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['panels'],
})
