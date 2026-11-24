import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { downloadArchiveFile } from '@/api/board'
import { toast } from 'sonner'
import { fileSizeLabel } from './task-detail-artifacts.ts'

type ArchiveFile = Parameters<typeof downloadArchiveFile>[0]

export function TaskDetailArchiveFiles({
  files,
  loading,
  busy,
  onBusy,
}: {
  files: ArchiveFile[]
  loading: boolean
  busy: string
  onBusy: (value: string) => void
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-semibold text-muted-foreground">归档附件</h3>
        <span className="text-2xs text-muted-foreground">{files.length} 个本地快照文件</span>
      </div>
      <p className="rounded-lg border border-border px-2.5 py-2 text-2xs leading-5 text-muted-foreground">
        归档后，本地活动副本可能保留、进入受保护清理，或因已修改、被 Git 跟踪而需要按 Git 流程处理。
      </p>
      {loading && !files.length ? (
        <Skeleton className="h-6 w-40" />
      ) : files.length ? (
        <ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border">
          {files.map((file) => (
            <li key={file.id} className="flex min-w-0 items-center gap-2 px-2.5 py-2">
              <span className="flex min-w-0 flex-1 flex-col">
                <b className="truncate text-xs font-semibold" title={file.path}>
                  {file.name}
                </b>
                <small className="truncate text-2xs text-muted-foreground">
                  {file.mimeType} · {fileSizeLabel(file.sizeBytes)}
                </small>
              </span>
              <Button
                variant="outline"
                size="sm"
                className="gap-1"
                disabled={busy === `archive:${file.id}`}
                onClick={async () => {
                  onBusy(`archive:${file.id}`)
                  try {
                    await downloadArchiveFile(file)
                  } catch (error) {
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : '归档本地文件不可用，请等待下一次同步',
                    )
                  } finally {
                    onBusy('')
                  }
                }}
              >
                <Download className="size-3.5" />
                {busy === `archive:${file.id}` ? '读取中' : '下载'}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">当前还没有可下载的本地快照附件。</p>
      )}
    </section>
  )
}
