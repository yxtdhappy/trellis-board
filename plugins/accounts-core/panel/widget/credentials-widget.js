/**
 * 统一账号小组件：给 jenkins-ops / witops-core 等面板复用。
 *
 * 用法（宿主面板内）：
 *   TrellisCredentialsWidget.mount({
 *     root: document.getElementById('credentials'),
 *     request: (method, path) => rpc(method, path),   // 该面板自己的 postMessage 桥
 *     systemId: 'jenkins',
 *   })
 *
 * 数据由宿主插件的代理路由返回（插件内部再调 accounts.credentials capability），
 * 因此 widget 不直接访问 accounts-core 的接口，也不接触密码。
 */
;(function (global) {
  const CSS_HREF = '/api/plugins/accounts-core/panel/widget/credentials-widget.css'
  const SOURCE_LABEL = { accounts: '统一账号', local: '本地配置', mixed: '混合', none: '未配置' }

  function ensureStyle() {
    if (document.querySelector(`link[href="${CSS_HREF}"]`)) return
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = CSS_HREF
    document.head.append(link)
  }

  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue
      if (key === 'class') node.className = value
      else node.setAttribute(key, value)
    }
    for (const child of children) {
      node.append(child instanceof Node ? child : document.createTextNode(String(child)))
    }
    return node
  }

  function badge(source) {
    const label = SOURCE_LABEL[source] || SOURCE_LABEL.none
    return el('span', { class: `tw-badge tw-badge-${source || 'none'}` }, label)
  }

  function render(root, view) {
    // accounts-core 未启用时整个来源卡片都不展示，避免把本地回退当成账号配置。
    if (view.available === false) {
      root.replaceChildren()
      return
    }
    const lines = []
    lines.push(
      el('div', { class: 'tw-head' }, [
        el('span', { class: 'tw-title' }, '凭据来源'),
        badge(view.source),
      ]),
    )
    if (view.username) {
      lines.push(
        el('div', { class: 'tw-row' }, [
          el('span', { class: 'tw-key' }, '账号'),
          el('span', { class: 'tw-value' }, view.username),
        ]),
      )
    }
    if (view.systemName || view.systemId) {
      lines.push(
        el('div', { class: 'tw-row' }, [
          el('span', { class: 'tw-key' }, '系统'),
          el('span', { class: 'tw-value' }, view.systemName || view.systemId),
        ]),
      )
    }
    if (view.source === 'accounts' && view.hasPassword === false) {
      lines.push(
        el('p', { class: 'tw-hint tw-warn' }, '统一账号未设置密码，请到「统一账号」面板补齐。'),
      )
    }
    if (view.source === 'local') {
      lines.push(
        el(
          'p',
          { class: 'tw-hint' },
          '正在使用本地配置；在「统一账号」面板绑定该系统的账号后会自动切换。',
        ),
      )
    }
    if (view.source === 'none') {
      const bound = view.error && !/系统不存在/.test(view.error)
      lines.push(
        el(
          'p',
          { class: bound ? 'tw-hint tw-warn' : 'tw-hint' },
          bound
            ? view.error
            : `尚未绑定统一账号；在「统一账号」面板新建系统 ${view.systemId} 后自动启用。`,
        ),
      )
    } else if (view.error && view.source !== 'local') {
      lines.push(el('p', { class: 'tw-hint tw-warn' }, view.error))
    }
    root.replaceChildren(el('div', { class: 'tw-card' }, lines))
  }

  function mount({ root, request, systemId, systemName, pollMs = 15_000 } = {}) {
    if (!root || typeof request !== 'function') return { refresh: async () => {} }
    ensureStyle()
    root.replaceChildren(el('div', { class: 'tw-card tw-loading' }, '读取凭据来源…'))

    async function refresh() {
      try {
        const view = (await request('GET', '/credentials')) || {}
        render(root, {
          available: view.available !== false,
          source: view.source || 'none',
          username: view.username || '',
          systemId: view.systemId || systemId || '',
          systemName: view.systemName || systemName || '',
          hasPassword: view.hasPassword !== false,
          error: view.error || '',
        })
      } catch (error) {
        root.replaceChildren(
          el('div', { class: 'tw-card' }, [
            el('div', { class: 'tw-head' }, [
              el('span', { class: 'tw-title' }, '凭据来源'),
              badge('none'),
            ]),
            el('p', { class: 'tw-hint tw-warn' }, `统一账号不可用：${error.message}`),
          ]),
        )
      }
    }

    void refresh()

    // 面板拿不到 push：统一账号改完后按固定间隔重读，页面隐藏时暂停。
    let timer = null
    function startPolling() {
      if (timer || !(pollMs > 0)) return
      timer = setInterval(() => {
        if (document.visibilityState === 'visible') void refresh()
      }, pollMs)
      timer.unref?.()
    }
    function onVisible() {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    startPolling()

    return {
      refresh,
      stop() {
        if (timer) clearInterval(timer)
        timer = null
        document.removeEventListener('visibilitychange', onVisible)
      },
    }
  }

  global.TrellisCredentialsWidget = { mount }
})(window)
