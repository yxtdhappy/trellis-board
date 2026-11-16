/**
 * 面板 ↔ 宿主桥接（v1）。所有插件面板共用一个实现，替代各面板里复制粘贴的 rpc。
 *
 * 加载：<script src="/plugin-ui/v1/bridge.js"></script>
 *
 * 用法：
 *   const bridge = TrellisBridge.create()
 *   const { accounts } = await bridge.get('/accounts')
 *   await bridge.post('/accounts', { name: '张三' })
 *   bridge.onEvent((event) => { ... })        // 宿主转发的插件事件
 *   const { theme, panel, context } = await bridge.ready
 *
 * 宿主只允许访问 /api/plugins/<当前插件>/，路径必须以 / 开头。
 * 失败时抛出的 Error 带 status 与 data，message 取自后端 { error }。
 */
;(function (global) {
  // 宿主 CSS 变量 → 面板设计令牌。新增令牌时两边一起改。
  const TOKEN_MAP = {
    background: '--tb-bg',
    foreground: '--tb-fg',
    card: '--tb-card',
    'card-foreground': '--tb-card-fg',
    border: '--tb-border',
    primary: '--tb-accent',
    'primary-foreground': '--tb-accent-fg',
    muted: '--tb-muted',
    'muted-foreground': '--tb-muted-fg',
    destructive: '--tb-danger',
    'destructive-foreground': '--tb-danger-fg',
    success: '--tb-ok',
    warning: '--tb-warn',
    radius: '--tb-radius',
  }

  function applyTheme(theme) {
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.dataset.theme = theme
    }
  }

  function applyTokens(tokens) {
    if (!tokens || typeof tokens !== 'object') return
    const root = document.documentElement
    for (const [name, value] of Object.entries(tokens)) {
      if (!value) continue
      const target = TOKEN_MAP[name] || (name.startsWith('--') ? name : null)
      if (target) root.style.setProperty(target, String(value))
    }
  }

  function create({ timeout = 20000 } = {}) {
    const pending = new Map()
    const eventHandlers = new Set()
    const initHandlers = new Set()
    let seq = 0
    let initInfo = null
    let resolveReady
    const ready = new Promise((resolve) => {
      resolveReady = resolve
    })

    function settle(message) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.ok) {
        entry.resolve(message.data)
      } else {
        const data = message.data
        let detail = `请求失败 (HTTP ${message.status ?? 0})`
        if (data && typeof data === 'object' && typeof data.error === 'string') {
          detail = data.error
        } else if (typeof data === 'string' && data) {
          detail = data
        }
        const error = new Error(detail)
        error.status = message.status ?? 0
        error.data = data
        entry.reject(error)
      }
    }

    function handleInit(message) {
      initInfo = {
        theme: message.theme === 'dark' ? 'dark' : 'light',
        panel: message.panel || null,
        context: message.context || null,
        tokens: message.tokens || null,
      }
      applyTheme(initInfo.theme)
      applyTokens(initInfo.tokens)
      resolveReady(initInfo)
      for (const handler of initHandlers) {
        try {
          handler(initInfo)
        } catch (error) {
          console.error('[trellis] init handler 失败', error)
        }
      }
    }

    global.addEventListener('message', (event) => {
      const message = event.data
      if (!message || typeof message !== 'object') return
      if (message.type === 'trellis:init') {
        handleInit(message)
      } else if (message.type === 'trellis:response') {
        settle(message)
      } else if (message.type === 'trellis:event') {
        for (const handler of eventHandlers) {
          try {
            handler(message.event)
          } catch (error) {
            console.error('[trellis] 事件处理失败', error)
          }
        }
      }
    })

    function request(method, path, body) {
      return new Promise((resolve, reject) => {
        if (typeof path !== 'string' || !path.startsWith('/')) {
          reject(new Error(`path 必须以 / 开头: ${path}`))
          return
        }
        const id = `tb-${Date.now().toString(36)}-${++seq}`
        const timer = setTimeout(() => {
          pending.delete(id)
          const error = new Error(`插件请求超时: ${method} ${path}`)
          error.status = 0
          reject(error)
        }, timeout)
        pending.set(id, { resolve, reject, timer })
        global.parent.postMessage(
          {
            type: 'trellis:request',
            id,
            method: String(method || 'GET').toUpperCase(),
            path,
            body,
          },
          '*',
        )
      })
    }

    const bridge = {
      request,
      get: (path) => request('GET', path),
      post: (path, body) => request('POST', path, body),
      put: (path, body) => request('PUT', path, body),
      delete: (path, body) => request('DELETE', path, body),
      ready,
      get init() {
        return initInfo
      },
      onInit(handler) {
        initHandlers.add(handler)
        if (initInfo) handler(initInfo)
        return () => initHandlers.delete(handler)
      },
      onEvent(handler) {
        eventHandlers.add(handler)
        return () => eventHandlers.delete(handler)
      },
    }

    global.parent.postMessage({ type: 'trellis:ready' }, '*')
    return bridge
  }

  global.TrellisBridge = { create, TOKEN_MAP }
})(window)
