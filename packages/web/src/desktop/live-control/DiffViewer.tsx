import { Component, Suspense, lazy, useState } from 'react'
import type { ReactNode } from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { DiffFile } from './control-event.ts'
import { formatSource } from './labels.ts'

const MonacoDiff = lazy(() => import('../MonacoDiff.tsx'))

function DiffFileFallback({ file }: { file: DiffFile }) {
  const source = formatSource(file.changedBy)
  return (
    <div>
      <div className="grid gap-2 md:grid-cols-2">
        {[
          { label: '本地版本', content: file.localContent },
          { label: '服务端版本', content: file.serverContent },
        ].map((side) => (
          <section key={side.label} className="min-w-0">
            <strong className="text-xs text-muted-foreground">{side.label}</strong>
            <pre className="mt-1 max-h-55 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs leading-5 whitespace-pre-wrap break-words">
              {side.content ?? '该文件在对应版本中不存在'}
            </pre>
          </section>
        ))}
      </div>
      {source ? <p className="mt-1 text-muted-foreground">{source}</p> : null}
    </div>
  )
}

class DiffLoadBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

export function DiffViewer({ files }: { files: DiffFile[] }) {
  const [activeIndex, setActiveIndex] = useState(0)
  if (!files.length) {
    return <p className="text-muted-foreground">没有可比对的差异内容。</p>
  }
  const index = Math.min(activeIndex, files.length - 1)
  const file = files[index]
  const source = formatSource(file.changedBy)
  const missing = [
    file.localContent == null ? '该文件在本地版本中不存在' : null,
    file.serverContent == null ? '该文件在服务端版本中不存在' : null,
  ].filter(Boolean)

  return (
    <div className="flex flex-col gap-3">
      <ToggleGroup
        orientation="vertical"
        value={[String(index)]}
        onValueChange={(value) => {
          const next = Number(value[0])
          if (Number.isInteger(next)) setActiveIndex(next)
        }}
        spacing={1}
        aria-label="差异文件"
        className="max-h-36 w-full flex-col items-stretch overflow-y-auto"
      >
        {files.map((item, position) => {
          const itemPath = item.path ?? '未知文件'
          const itemSource = formatSource(item.changedBy)
          return (
            <ToggleGroupItem
              key={`${item.path ?? 'file'}:${position}`}
              value={String(position)}
              className="h-auto w-full min-w-0 flex-col items-start gap-0 overflow-hidden rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/50 aria-pressed:bg-muted aria-pressed:text-foreground"
            >
              <span className="block w-full truncate font-medium" title={itemPath}>
                {itemPath}
              </span>
              {itemSource ? (
                <span className="block w-full truncate text-xs" title={itemSource}>
                  {itemSource}
                </span>
              ) : null}
            </ToggleGroupItem>
          )
        })}
      </ToggleGroup>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <p className="min-w-0 break-all font-medium text-foreground">{file.path ?? '未知文件'}</p>
        <p className="text-muted-foreground">
          左：本地版本 · 右：服务端版本{source ? ` · ${source}` : ''}
        </p>
        {missing.length ? <p className="text-warning">{missing.join('；')}</p> : null}
      </div>
      <div className="h-[clamp(16rem,55vh,34rem)]">
        <DiffLoadBoundary
          fallback={
            <div className="flex h-full flex-col gap-2 overflow-auto">
              <p className="text-warning">高级差异视图不可用，已回退文本对照</p>
              <DiffFileFallback file={file} />
            </div>
          }
        >
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center rounded-md bg-muted/50 text-muted-foreground">
                正在加载高级差异视图…
              </div>
            }
          >
            <MonacoDiff original={file.localContent ?? ''} modified={file.serverContent ?? ''} />
          </Suspense>
        </DiffLoadBoundary>
      </div>
    </div>
  )
}
