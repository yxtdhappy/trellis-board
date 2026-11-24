export function envToFlag(envName) {
  return envName.toLowerCase().replaceAll('_', '-')
}

export const ENV_SCHEMA = [
  // 服务端 (dev / start)
  {
    env: 'PORT',
    flag: 'port',
    type: 'port',
    scopes: ['dev', 'start'],
    description: 'HTTP 服务监听端口（1-65535，默认 4317）',
  },
  {
    env: 'TRELLIS_BOARD_DATA_DIR',
    flag: 'data-dir',
    type: 'path',
    scopes: ['dev', 'start'],
    description: '运行数据目录（相对路径按执行时工作目录解析）',
  },
  {
    env: 'TRELLIS_BOARD_PLUGINS_DIR',
    flag: 'plugins-dir',
    type: 'path',
    scopes: ['dev', 'start'],
    description: '插件配置与私有插件目录（相对路径按执行时工作目录解析）',
  },
  {
    env: 'TRELLIS_WATCH_DEBOUNCE_MS',
    flag: 'watch-debounce',
    type: 'int',
    min: 100,
    max: 60_000,
    scopes: ['dev', 'start'],
    description: '任务文件监听防抖毫秒（100-60000）',
  },
  {
    env: 'TRELLIS_BOARD_ALLOW_LOCAL_GIT_REMOTES',
    flag: 'allow-local-git-remotes',
    type: 'boolean',
    trueValue: 'true',
    falseValue: 'false',
    scopes: ['dev', 'start'],
    description: '是否允许本地文件系统 Git remote',
  },

  // 前端 Vite (dev / build)
  {
    env: 'VITE_TRELLIS_ROLE',
    flag: 'role',
    type: 'enum',
    values: ['server', 'client'],
    scopes: ['dev', 'build'],
    description: '前端运行角色（server 或 client）',
  },
  {
    env: 'VITE_DEV_PORT',
    flag: 'web-port',
    type: 'port',
    scopes: ['dev'],
    description: 'Vite 开发服务器端口（desktop 模式下作为 Board UI 端口）',
  },
  {
    env: 'VITE_API_TARGET',
    flag: 'api-target',
    type: 'string',
    scopes: ['dev'],
    description: 'Vite /api 代理目标地址（默认 http://127.0.0.1:<PORT>）',
  },
  {
    env: 'VITE_CACHE_DIR',
    flag: 'cache-dir',
    type: 'string',
    scopes: ['dev'],
    description: 'Vite 依赖预构建缓存目录',
  },
  {
    env: 'VITE_LOCAL_PLUGIN_PORT',
    flag: 'local-plugin-port',
    type: 'port',
    scopes: ['dev'],
    description: '本机插件宿主端口（默认 4517）',
  },
  {
    env: 'VITE_LOCAL_PLUGIN_TARGET',
    flag: 'local-plugin-target',
    type: 'string',
    scopes: ['dev'],
    description: '本机插件宿主代理目标地址',
  },
  {
    env: 'VITE_LOCAL_PLUGIN_BASE',
    flag: 'local-plugin-base',
    type: 'string',
    scopes: ['dev'],
    description: '前端访问本机插件宿主的路径前缀（默认 /local-plugin）',
  },
  {
    env: 'VITE_LOCAL_PLUGIN_TOKEN',
    flag: 'local-plugin-token',
    type: 'string',
    secret: true,
    scopes: ['dev'],
    description: '本机插件宿主调试 Bearer Token',
  },
  {
    env: 'VITE_LOCAL_PLUGIN_SECRET',
    flag: 'local-plugin-secret',
    type: 'string',
    secret: true,
    scopes: ['dev'],
    description: '本机插件宿主静态资源密钥前缀',
  },

  // 桌面端 (dev / build)
  {
    env: 'TRELLIS_DESKTOP_HOME',
    flag: 'desktop-home',
    type: 'path',
    scopes: ['dev'],
    description: '桌面客户端本地状态与缓存目录',
  },
  {
    env: 'TRELLIS_DESKTOP_SERVER_URL',
    flag: 'server-url',
    type: 'string',
    scopes: ['dev'],
    description: '桌面客户端默认连接的 Board 地址',
  },
  {
    env: 'TRELLIS_DESKTOP_HTTP_TRACE',
    flag: 'http-trace',
    type: 'boolean',
    trueValue: '1',
    presenceOnly: true,
    scopes: ['dev'],
    description: '启用桌面客户端 HTTP 追踪日志（--no-http-trace 清除该变量）',
  },
  {
    env: 'TRELLIS_UPDATE_SERVER',
    flag: 'update-server',
    type: 'string',
    scopes: ['build'],
    description: '构建桌面端时注入的更新服务器地址',
  },

  // 测试 (test)
  {
    env: 'TRELLIS_REAL_ACP',
    flag: 'real-acp',
    type: 'boolean',
    trueValue: '1',
    presenceOnly: true,
    scopes: ['test'],
    description: '启用真实 ACP 插件集成测试',
  },
  {
    env: 'TRELLIS_REAL_ACP_AGENT',
    flag: 'real-acp-agent',
    type: 'string',
    scopes: ['test'],
    description: '指定真实 ACP 测试使用的 agent（默认 opencode）',
  },
]

export function getSchemaForScope(scope) {
  return ENV_SCHEMA.filter((entry) => entry.scopes.includes(scope))
}
