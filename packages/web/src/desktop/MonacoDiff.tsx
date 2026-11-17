import EditorWorker from 'monaco-editor/editor/editor.worker?worker'
import * as monaco from 'monaco-editor/editor/editor.api'
import type { editor as monacoEditor, Environment } from 'monaco-editor/editor/editor.api'
import { useEffect, useRef } from 'react'

// Monaco 只在运行时读取 globalThis.MonacoEnvironment，包没有可选写入类型。
;(globalThis as typeof globalThis & { MonacoEnvironment?: Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
}

type MonacoDiffProps = {
  original: string
  modified: string
}

type TextModel = monacoEditor.ITextModel

export default function MonacoDiff({ original, modified }: MonacoDiffProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const originalModelRef = useRef<TextModel | null>(null)
  const modifiedModelRef = useRef<TextModel | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const originalModel = monaco.editor.createModel('', 'plaintext')
    const modifiedModel = monaco.editor.createModel('', 'plaintext')
    const editor = monaco.editor.createDiffEditor(container, {
      readOnly: true,
      originalEditable: false,
      renderSideBySide: true,
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      originalAriaLabel: '本地版本',
      modifiedAriaLabel: '服务端版本',
      theme: document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs',
    })
    editor.setModel({ original: originalModel, modified: modifiedModel })
    originalModelRef.current = originalModel
    modifiedModelRef.current = modifiedModel

    const observer = new MutationObserver(() =>
      monaco.editor.setTheme(
        document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs',
      ),
    )
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    return () => {
      observer.disconnect()
      editor.dispose()
      originalModel.dispose()
      modifiedModel.dispose()
      originalModelRef.current = null
      modifiedModelRef.current = null
    }
  }, [])

  useEffect(() => {
    originalModelRef.current?.setValue(original)
    modifiedModelRef.current?.setValue(modified)
  }, [original, modified])

  return (
    <div
      ref={containerRef}
      className="h-full w-full overflow-hidden rounded-md border border-border"
    />
  )
}
