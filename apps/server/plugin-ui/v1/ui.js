/**
 * 面板 UI 组件（v1）。宿主提供，任何插件面板都可以直接用，不需要各自复制一份。
 *
 * 加载：
 *   <link rel="stylesheet" href="/plugin-ui/v1/tokens.css">
 *   <link rel="stylesheet" href="/plugin-ui/v1/base.css">
 *   <link rel="stylesheet" href="/plugin-ui/v1/ui.css">
 *   <script src="/plugin-ui/v1/ui.js"></script>
 *
 * 命令式（数据驱动的部分返回 light DOM，方便取节点、挂事件）：
 *   TrellisUI.button({ label: '保存', variant: 'primary', onClick })
 *   TrellisUI.table({ columns, rows })                     → { root, render, setLoading }
 *   TrellisUI.field({ label: '用户名', control: input })   → { root, setHint, setError }
 *   TrellisUI.toolbar([button]) / TrellisUI.chip('已绑定', 'ok')
 *   TrellisUI.empty('还没有账号') / TrellisUI.toast('已保存', 'ok')
 *   await TrellisUI.confirm({ title, message, danger: true }) → boolean
 *
 * 声明式（带交互状态的部分）：
 *   <tb-dialog title="编辑账号" ok-text="保存">
 *     ...表单...
 *   </tb-dialog>
 *   dialog.addEventListener('ok', () => { save(); dialog.close() })
 *
 * 表单控件直接用 ui.css 的类：<input class="tb-input"> / <textarea class="tb-input">
 */
;(function (global) {
  function el(tag, props = {}, children = []) {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue
      if (key === 'class') node.className = value
      else if (key === 'text') node.textContent = value
      else if (key === 'dataset') Object.assign(node.dataset, value)
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value)
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2), value)
      } else node.setAttribute(key, value === true ? '' : value)
    }
    appendChildren(node, children)
    return node
  }

  function appendChildren(node, children) {
    if (children === undefined || children === null || children === false) return
    const isList =
      Array.isArray(children) || children instanceof NodeList || children instanceof HTMLCollection
    if (isList) {
      for (const child of Array.from(children)) appendChildren(node, child)
      return
    }
    node.append(children instanceof Node ? children : document.createTextNode(String(children)))
  }

  const VARIANTS = {
    primary: 'tb-btn',
    ghost: 'tb-btn tb-btn-ghost',
    danger: 'tb-btn tb-btn-danger',
  }

  function button({
    label,
    text,
    variant = 'primary',
    size,
    type = 'button',
    onClick,
    title,
    disabled,
    className,
  } = {}) {
    const classes = `${VARIANTS[variant] || VARIANTS.primary}${size === 'sm' ? ' tb-btn-sm' : ''}`
    const node = el('button', {
      class: className ? `${classes} ${className}` : classes,
      type,
      title,
      disabled: Boolean(disabled),
    })
    node.textContent = label ?? text ?? ''
    if (typeof onClick === 'function') node.addEventListener('click', onClick)
    return node
  }

  function toolbar(start = [], { end = [] } = {}) {
    const root = el('div', { class: 'tb-toolbar' }, start)
    if (end.length) root.append(el('div', { class: 'tb-toolbar-end' }, end))
    return root
  }

  function field({ label, control, hint, htmlFor, className } = {}) {
    const root = el('div', { class: className ? `tb-field ${className}` : 'tb-field' })
    if (label) {
      const id = htmlFor || (control instanceof HTMLElement ? control.id : '')
      root.append(el('label', id ? { for: id, text: label } : { text: label }))
    }
    if (control) root.append(control)
    const hintNode = el('span', { class: 'tb-field-hint', text: hint || '' })
    if (hint) root.append(hintNode)
    return {
      root,
      hint: hintNode,
      setHint(text) {
        hintNode.textContent = text || ''
        if (text && !hintNode.isConnected) root.append(hintNode)
        root.classList.remove('tb-field-error')
      },
      setError(text) {
        hintNode.textContent = text || ''
        if (text && !hintNode.isConnected) root.append(hintNode)
        root.classList.toggle('tb-field-error', Boolean(text))
      },
    }
  }

  function chip(text, kind) {
    const suffix = kind && kind !== 'default' ? ` tb-chip-${kind}` : ''
    return el('span', { class: `tb-chip${suffix}`, text })
  }

  function empty(text) {
    return el('div', { class: 'tb-empty', text: text || '暂无数据' })
  }

  function toastContainer() {
    let container = document.querySelector('.tb-toasts')
    if (!container) {
      container = el('div', { class: 'tb-toasts', role: 'status', 'aria-live': 'polite' })
      document.body.append(container)
    }
    return container
  }

  function toast(message, kind = 'info', { timeout = 3200 } = {}) {
    const suffix = kind === 'info' ? '' : ` tb-toast-${kind}`
    const node = el('div', { class: `tb-toast${suffix}`, text: message })
    toastContainer().append(node)
    const remove = () => node.remove()
    if (timeout > 0) setTimeout(remove, timeout)
    node.addEventListener('click', remove)
    return { close: remove }
  }

  function confirm({
    title = '请确认',
    message = '',
    okText = '确认',
    cancelText = '取消',
    danger = false,
  } = {}) {
    return new Promise((resolve) => {
      let settled = false
      const ok = button({ label: okText, variant: danger ? 'danger' : 'primary' })
      const cancel = button({ label: cancelText, variant: 'ghost' })
      const dialog = el('dialog', { class: 'tb-dialog' }, [
        el('div', { class: 'tb-dialog-body' }, [
          el('h2', { class: 'tb-dialog-title', text: title }),
          message ? el('p', { class: 'tb-dialog-message', text: message }) : null,
        ]),
        el('div', { class: 'tb-dialog-footer' }, [cancel, ok]),
      ])
      const finish = (value) => {
        if (settled) return
        settled = true
        if (dialog.open) dialog.close()
        dialog.remove()
        resolve(value)
      }
      ok.addEventListener('click', () => finish(true))
      cancel.addEventListener('click', () => finish(false))
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault()
        finish(false)
      })
      document.body.append(dialog)
      dialog.showModal()
      ok.focus()
    })
  }

  function table({ columns = [], rows = [], empty: emptyText = '暂无数据', rowKey } = {}) {
    const head = el('thead', {}, [
      el(
        'tr',
        {},
        columns.map((column) =>
          el('th', {
            class: column.className,
            style: column.width ? { width: column.width } : undefined,
            text: column.title ?? column.key ?? '',
          }),
        ),
      ),
    ])
    const body = el('tbody')
    const tableNode = el('table', { class: 'tb-table' }, [head, body])
    const wrap = el('div', { class: 'tb-table-wrap' }, [tableNode])
    let current = []

    function render(nextRows) {
      current = Array.isArray(nextRows) ? nextRows : []
      body.replaceChildren()
      if (!current.length) {
        body.append(
          el('tr', { class: 'tb-table-empty' }, [
            el('td', { colspan: String(Math.max(columns.length, 1)), text: emptyText }),
          ]),
        )
        return
      }
      for (const [index, row] of current.entries()) {
        const key = typeof rowKey === 'function' ? rowKey(row) : (row?.id ?? index)
        const tr = el('tr', { dataset: { key: String(key ?? index) } })
        for (const column of columns) {
          const value = column.render ? column.render(row) : (row?.[column.key] ?? '')
          const td = el('td', { class: column.className })
          appendChildren(td, value === undefined || value === null ? '' : [value])
          tr.append(td)
        }
        body.append(tr)
      }
    }

    render(rows)
    return {
      root: wrap,
      table: tableNode,
      body,
      get rows() {
        return current
      },
      render,
      setLoading(loading) {
        tableNode.classList.toggle('is-loading', Boolean(loading))
      },
    }
  }

  class TrellisDialogElement extends global.HTMLElement {
    static get observedAttributes() {
      return ['title', 'ok-text', 'cancel-text', 'danger']
    }

    connectedCallback() {
      if (this.dialog) return
      const title = el('h2', { class: 'tb-dialog-title', text: this.getAttribute('title') || '' })
      this.content = el('div', { class: 'tb-dialog-content' })
      const ok = button({
        label: this.getAttribute('ok-text') || '保存',
        variant: this.hasAttribute('danger') ? 'danger' : 'primary',
      })
      const cancel = button({ label: this.getAttribute('cancel-text') || '取消', variant: 'ghost' })
      ok.addEventListener('click', () => {
        this.dispatchEvent(new CustomEvent('ok', { bubbles: true }))
      })
      cancel.addEventListener('click', () => this.close('cancel'))
      const dialog = el('dialog', { class: 'tb-dialog' }, [
        el('div', { class: 'tb-dialog-body' }, [title, this.content]),
        el('div', { class: 'tb-dialog-footer' }, [cancel, ok]),
      ])
      const moved = Array.from(this.childNodes)
      this.replaceChildren(dialog)
      this.content.append(...moved)
      this.dialog = dialog
      this.titleNode = title
      dialog.addEventListener('close', () => {
        this.removeAttribute('open')
        this.dispatchEvent(new CustomEvent('close', { detail: { value: dialog.returnValue } }))
      })
      if (this.hasAttribute('open')) this.showModal()
    }

    attributeChangedCallback(name, _oldValue, value) {
      if (!this.dialog) return
      if (name === 'title' && this.titleNode) this.titleNode.textContent = value || ''
      if (name === 'ok-text') {
        const ok = this.dialog.querySelector('.tb-dialog-footer .tb-btn:last-child')
        if (ok) ok.textContent = value || '保存'
      }
      if (name === 'cancel-text') {
        const cancel = this.dialog.querySelector('.tb-dialog-footer .tb-btn:first-child')
        if (cancel) cancel.textContent = value || '取消'
      }
    }

    showModal() {
      if (!this.dialog || this.dialog.open) return this
      this.dialog.showModal()
      const first = this.dialog.querySelector('input, textarea, select')
      first?.focus()
      return this
    }

    close(value) {
      if (this.dialog?.open) this.dialog.close(value === undefined ? '' : String(value))
      return this
    }

    get open() {
      return Boolean(this.dialog?.open)
    }
  }

  if (!global.customElements.get('tb-dialog')) {
    global.customElements.define('tb-dialog', TrellisDialogElement)
  }

  global.TrellisUI = {
    el,
    button,
    toolbar,
    field,
    chip,
    empty,
    toast,
    confirm,
    table,
  }
})(window)
