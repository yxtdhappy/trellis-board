import { createPlugin } from '../../../../../apps/server/plugins/sdk.js'

// 清单写 1.0.0，握手报 9.9.9，宿主必须回 1008 并断开。
export default createPlugin({
  name: 'bad-handshake',
  version: '9.9.9',
  apiVersion: 1,
  permissions: [],
})
