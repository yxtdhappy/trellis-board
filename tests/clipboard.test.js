import assert from 'node:assert/strict'
import test from 'node:test'
import { copyText } from '../web/src/browser/clipboard.js'

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

function installBrowser({ writeText, execCommand = () => true } = {}) {
  const textareas = []
  const documentRef = {
    activeElement: null,
    body: {
      children: [],
      appendChild(element) {
        this.children.push(element)
      },
    },
    commandCalls: [],
    createElement(tagName) {
      assert.equal(tagName, 'textarea')
      const textarea = {
        value: '',
        style: {},
        removed: false,
        setAttribute(name, value) {
          this[name] = value
        },
        focus() {
          documentRef.activeElement = this
        },
        select() {
          this.selected = true
        },
        remove() {
          this.removed = true
          documentRef.body.children = documentRef.body.children.filter((item) => item !== this)
        },
      }
      textareas.push(textarea)
      return textarea
    },
    execCommand(command) {
      this.commandCalls.push(command)
      return execCommand()
    },
  }
  const previousFocus = {
    focusCalls: 0,
    focus() {
      this.focusCalls += 1
      documentRef.activeElement = this
    },
  }
  documentRef.activeElement = previousFocus

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: writeText ? { clipboard: { writeText } } : {},
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: documentRef,
  })

  return {
    document: documentRef,
    previousFocus,
    textareas,
    restore() {
      restoreGlobal('navigator', originalNavigator)
      restoreGlobal('document', originalDocument)
    },
  }
}

function restoreGlobal(name, descriptor) {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor)
  } else {
    delete globalThis[name]
  }
}

test('复制工具优先使用 Clipboard API', async (t) => {
  const copied = []
  const browser = installBrowser({
    writeText: async (value) => copied.push(value),
    execCommand: () => {
      throw new Error('不应使用兼容回退')
    },
  })
  t.after(() => browser.restore())

  assert.equal(await copyText('task-dir'), true)
  assert.deepEqual(copied, ['task-dir'])
  assert.deepEqual(browser.document.commandCalls, [])
})

test('Clipboard API 缺失时使用临时 textarea 回退', async (t) => {
  const browser = installBrowser()
  t.after(() => browser.restore())

  assert.equal(await copyText('task-dir'), true)
  assert.equal(browser.textareas[0].value, 'task-dir')
  assert.equal(browser.textareas[0].selected, true)
  assert.equal(browser.textareas[0].removed, true)
  assert.equal(browser.document.body.children.length, 0)
  assert.deepEqual(browser.document.commandCalls, ['copy'])
})

test('Clipboard API reject 后回退并恢复焦点', async (t) => {
  const browser = installBrowser({
    writeText: async () => {
      throw new Error('非安全上下文')
    },
  })
  t.after(() => browser.restore())

  assert.equal(await copyText('task-dir'), true)
  assert.equal(browser.previousFocus.focusCalls, 1)
  assert.equal(browser.document.activeElement, browser.previousFocus)
  assert.equal(browser.textareas[0].removed, true)
})

test('两种复制方式都失败时返回 false 且完成清理', async (t) => {
  const browser = installBrowser({
    execCommand: () => {
      throw new Error('复制被拒绝')
    },
  })
  t.after(() => browser.restore())

  assert.equal(await copyText('task-dir'), false)
  assert.equal(browser.textareas[0].removed, true)
  assert.equal(browser.document.body.children.length, 0)
  assert.equal(browser.previousFocus.focusCalls, 1)
})

test('execCommand 返回 false 时返回 false 且完成清理', async (t) => {
  const browser = installBrowser({
    execCommand: () => false,
  })
  t.after(() => browser.restore())

  assert.equal(await copyText('task-dir'), false)
  assert.equal(browser.textareas[0].removed, true)
  assert.equal(browser.document.body.children.length, 0)
  assert.equal(browser.previousFocus.focusCalls, 1)
})
