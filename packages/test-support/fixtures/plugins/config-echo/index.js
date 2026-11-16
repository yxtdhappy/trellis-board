import { createPlugin } from '../../../../../packages/server/plugins/sdk.js'

export default createPlugin({
  name: 'config-echo',
  version: '1.0.0',
  apiVersion: 1,
  permissions: ['http:route'],

  async onStart(ctx) {
    // boot 是 onStart 时的快照，live 是 ctx.config 的实时值，用来区分热更新与重启。
    const boot = ctx.config
    ctx.http.route('GET', '/config', () => ({
      status: 200,
      body: { boot, live: ctx.config, pid: process.pid },
    }))
  },
})
