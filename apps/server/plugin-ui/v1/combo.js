/**
 * 可搜索下拉框，宿主提供给所有插件面板的 UI 组件（不在任何插件里）。
 *
 * 原生 datalist 只在聚焦时露出箭头、不能键盘高亮、没法标出「已绑定」这类状态，
 * 所以这里用 input + 浮层自绘。jenkins-ops 的动态参数（如 List Git Branches 的 Branch）
 * 和统一账号的系统 id 都用它，避免每个面板各写一份。
 *
 * 加载：<script src="/plugin-ui/v1/combo.js"></script>（宿主路由，与插件开关无关）
 *
 * 用法（面板里，命令式）：
 *   const combo = TrellisCombo.create({
 *     id: 'system-id', name: 'system-id', placeholder: 'jenkins / witops',
 *     options: ['jenkins', { value: 'witops', label: 'witops · WitOps 平台' }],
 *     onChange: (value) => {},
 *   })
 *   container.append(combo.root)   // combo.hint 是可选的一行提示
 *   combo.setOptions(list) / combo.setValue(v) / combo.value / combo.setReadOnly(b)
 *
 * 用法（声明式）：
 *   <tb-combo id="system-id" name="system-id" placeholder="jenkins / witops"
 *             options="jenkins,witops"></tb-combo>
 *   元素属性：value / placeholder / readonly / options（JSON 数组或逗号分隔）
 *   元素事件：change（detail.value）
 */
;(function (global) {
  const CSS_HREF = '/plugin-ui/v1/combo.css'
  let openCombo = null

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
      else if (key === 'text') node.textContent = value
      else if (key === 'dataset') Object.assign(node.dataset, value)
      else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2), value)
      } else node.setAttribute(key, value)
    }
    for (const child of children) {
      if (child === undefined || child === null || child === false) continue
      node.append(child instanceof Node ? child : document.createTextNode(String(child)))
    }
    return node
  }

  // 允许 ['jenkins'] 与 [{ value, label, disabled }] 混用。
  function normalize(list) {
    return (Array.isArray(list) ? list : [])
      .map((item) => {
        if (typeof item === 'string') return { value: item, label: item, disabled: false }
        if (!item || typeof item !== 'object') return null
        const value = item.value === undefined || item.value === null ? '' : String(item.value)
        if (!value) return null
        return {
          value,
          label: item.label === undefined || item.label === null ? value : String(item.label),
          disabled: Boolean(item.disabled),
        }
      })
      .filter(Boolean)
  }

  function create({ id, name, value, placeholder, options, onChange } = {}) {
    ensureStyle()

    const input = el('input', {
      id,
      name,
      type: 'text',
      class: 'combo-input',
      value: value === undefined || value === null ? '' : String(value),
      placeholder,
      autocomplete: 'off',
      spellcheck: 'false',
      role: 'combobox',
      'aria-expanded': 'false',
      'aria-autocomplete': 'list',
    })
    const toggle = el('button', {
      type: 'button',
      class: 'combo-toggle',
      'aria-label': '展开可选值',
      tabindex: '-1',
    })
    // 图标由 combo.css 的 ::before 画（比字体三角形清晰，且不依赖字体）
    const menu = el('div', { class: 'combo-menu', role: 'listbox' })
    menu.hidden = true
    const hint = el('span', { class: 'combo-hint muted' })
    const root = el('div', { class: 'combo' }, [input, toggle, menu])

    let values = normalize(options)
    let visible = []
    let active = -1

    const items = () => [...menu.children].filter((node) => node.classList.contains('combo-item'))
    const isOpen = () => !menu.hidden
    // <dialog> 自带 overflow: auto，绝对定位的浮层会被裁剪，所以用 fixed + 输入框坐标定位。
    const place = () => {
      const rect = root.getBoundingClientRect()
      menu.style.top = `${Math.round(rect.bottom + 4)}px`
      menu.style.left = `${Math.round(rect.left)}px`
      menu.style.width = `${Math.round(rect.width)}px`
    }
    const close = () => {
      menu.hidden = true
      root.classList.remove('is-open')
      input.setAttribute('aria-expanded', 'false')
      active = -1
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      if (openCombo === self) openCombo = null
    }
    const setActive = (index) => {
      const nodes = items()
      if (!nodes.length) return
      active = (index + nodes.length) % nodes.length
      nodes.forEach((node, i) => node.classList.toggle('is-active', i === active))
      nodes[active].scrollIntoView({ block: 'nearest' })
    }
    const pick = (candidate) => {
      input.value = candidate.value
      close()
      input.dispatchEvent(new Event('change', { bubbles: true }))
      if (typeof onChange === 'function') onChange(candidate.value, candidate)
    }
    const render = (keywordOverride) => {
      // 打开下拉时展示全部候选，不能拿输入框当前值当过滤词
      const raw = keywordOverride === undefined ? input.value : keywordOverride
      const keyword = String(raw).trim().toLowerCase()
      visible = keyword
        ? values.filter(
            (item) =>
              !item.disabled &&
              (item.value.toLowerCase().includes(keyword) ||
                item.label.toLowerCase().includes(keyword)),
          )
        : values.filter((item) => !item.disabled)
      menu.replaceChildren(
        ...(visible.length
          ? visible.map((item) => {
              const current = item.value === input.value
              return el(
                'div',
                {
                  class: current ? 'combo-item is-current' : 'combo-item',
                  role: 'option',
                  title: item.label,
                  'aria-selected': current ? 'true' : 'false',
                  onmousedown: (event) => {
                    event.preventDefault()
                    pick(item)
                  },
                },
                [
                  el('span', { text: item.label }),
                  current ? el('span', { class: 'combo-check', text: '✓' }) : undefined,
                ],
              )
            })
          : [
              el('div', {
                class: 'combo-empty muted',
                text: values.length ? '没有匹配的值' : '没有可选值',
              }),
            ]),
      )
      active = -1
    }
    const open = () => {
      if (input.readOnly) return
      if (openCombo && openCombo !== self) openCombo.close()
      render('')
      place()
      menu.hidden = false
      root.classList.add('is-open')
      input.setAttribute('aria-expanded', 'true')
      openCombo = self
      window.addEventListener('scroll', close, true)
      window.addEventListener('resize', close)
      const current = visible.findIndex((item) => item.value === input.value)
      setActive(current >= 0 ? current : 0)
    }

    const self = { root, input, hint, close }

    toggle.addEventListener('click', (event) => {
      event.preventDefault()
      if (isOpen()) close()
      else open()
    })
    // 点击输入框才展开：程序化 focus（比如弹窗刚打开）不应该自动弹出浮层。
    input.addEventListener('click', () => {
      if (!isOpen()) open()
    })
    input.addEventListener('input', () => {
      if (!values.length) return
      render()
      place()
      menu.hidden = false
      root.classList.add('is-open')
      input.setAttribute('aria-expanded', 'true')
      openCombo = self
      setActive(0)
    })
    input.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        if (!isOpen()) open()
        else setActive(active + 1)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        if (!isOpen()) open()
        else setActive(active - 1)
        return
      }
      if (event.key === 'Enter' && isOpen() && active >= 0 && visible[active] !== undefined) {
        event.preventDefault()
        pick(visible[active])
        return
      }
      if (event.key === 'Escape' && isOpen()) {
        event.preventDefault()
        close()
      }
    })

    const syncHint = () => {
      hint.textContent = values.length ? `共 ${values.length} 个可选值，输入可过滤` : '没有可选值'
    }
    syncHint()

    self.setOptions = (list) => {
      values = normalize(list)
      syncHint()
      if (isOpen()) render()
    }
    // 兼容旧名字，jenkins-ops 之前用的是 setValues
    self.setValues = self.setOptions
    Object.defineProperty(self, 'options', { get: () => values.slice() })
    self.setHint = (text) => {
      hint.textContent = text
    }
    self.setError = (message) => {
      hint.textContent = message
    }
    self.setReadOnly = (readOnly) => {
      input.readOnly = Boolean(readOnly)
      toggle.disabled = Boolean(readOnly)
      if (readOnly) close()
    }
    self.setValue = (next) => {
      input.value = next === undefined || next === null ? '' : String(next)
    }
    self.focus = () => input.focus()
    Object.defineProperty(self, 'value', {
      get: () => input.value,
      set: (next) => self.setValue(next),
    })

    if (Array.isArray(options)) self.setOptions(options)
    return self
  }

  document.addEventListener(
    'mousedown',
    (event) => {
      if (openCombo && !openCombo.root.contains(event.target)) openCombo.close()
    },
    true,
  )

  function parseOptions(value) {
    if (!value) return []
    const text = String(value).trim()
    if (!text) return []
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    }
    return text
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  }

  class TrellisComboElement extends global.HTMLElement {
    static get observedAttributes() {
      return ['value', 'placeholder', 'readonly']
    }

    connectedCallback() {
      if (this.combo) return
      const combo = create({
        id: this.getAttribute('id') || undefined,
        name: this.getAttribute('name') || undefined,
        value: this.getAttribute('value') || '',
        placeholder: this.getAttribute('placeholder') || '',
        options: parseOptions(this.getAttribute('options')),
        onChange: (value) => {
          this.dispatchEvent(new CustomEvent('change', { detail: { value }, bubbles: true }))
        },
      })
      this.combo = combo
      this.replaceChildren(combo.root, combo.hint)
      if (this.hasAttribute('readonly')) combo.setReadOnly(true)
      if (this.pendingOptions) {
        combo.setOptions(this.pendingOptions)
        this.pendingOptions = null
      }
    }

    attributeChangedCallback(name, _oldValue, value) {
      if (!this.combo) return
      if (name === 'placeholder') {
        const input = this.combo.root.querySelector('.combo-input')
        if (input) input.setAttribute('placeholder', value || '')
      } else if (name === 'readonly') {
        this.combo.setReadOnly(value !== null)
      } else if (name === 'value' && this.combo.value !== (value || '')) {
        this.combo.setValue(value || '')
      }
    }

    get options() {
      return this.combo ? this.combo.options : (this.pendingOptions ?? [])
    }

    set options(list) {
      if (this.combo) this.combo.setOptions(list)
      else this.pendingOptions = list
    }

    get value() {
      return this.combo ? this.combo.value : this.getAttribute('value') || ''
    }

    set value(next) {
      if (this.combo) this.combo.setValue(next)
      else this.setAttribute('value', next === undefined || next === null ? '' : String(next))
    }

    setOptions(list) {
      if (this.combo) this.combo.setOptions(list)
      else this.pendingOptions = list
    }

    setValue(next) {
      this.value = next
    }

    setHint(text) {
      this.combo?.setHint(text)
    }

    setReadOnly(readOnly) {
      this.toggleAttribute('readonly', Boolean(readOnly))
      this.combo?.setReadOnly(Boolean(readOnly))
    }

    focus() {
      this.combo?.focus()
    }
  }

  if (!global.customElements.get('tb-combo')) {
    global.customElements.define('tb-combo', TrellisComboElement)
  }

  global.TrellisCombo = { create, parseOptions }
})(window)
