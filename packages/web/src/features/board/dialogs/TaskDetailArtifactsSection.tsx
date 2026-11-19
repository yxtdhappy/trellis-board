import { Button } from '@/components/ui/button'
import type { ArtifactEntry } from './task-detail-artifacts.ts'

type ArtifactListItem = {
  key: string
  label: string
  hint: string
  artifact?: ArtifactEntry
}

export function TaskDetailArtifactsSection({
  artifacts,
  loading,
  onOpen,
}: {
  artifacts: ArtifactListItem[]
  loading: boolean
  onOpen: (value: { label: string; entry?: ArtifactEntry }) => void
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold text-muted-foreground">任务产物</h3>
      {loading && !artifacts.length ? (
        <p className="text-xs text-muted-foreground">任务产物正在读取…</p>
      ) : artifacts.length ? (
        <div className="flex flex-col gap-1">
          {artifacts.map(({ key, label, hint, artifact: entry }) => (
            <Button
              key={key}
              variant="ghost"
              className="h-auto items-start justify-start gap-2 rounded-lg bg-muted px-2.5 py-2 text-left hover:bg-muted/70"
              onClick={() => onOpen({ label, entry })}
            >
              <span className="flex size-6 items-center justify-center rounded bg-card text-2xs font-bold text-muted-foreground">
                MD
              </span>
              <span className="flex min-w-0 flex-col">
                <b className="text-xs font-semibold">{label}</b>
                <small className="truncate text-2xs text-muted-foreground">
                  {hint} · {entry?.path?.split('/').pop()}
                </small>
              </span>
              <span className="ml-auto text-2xs text-primary">查看</span>
            </Button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">这个任务没有可读取的 Markdown 产物。</p>
      )}
    </section>
  )
}
