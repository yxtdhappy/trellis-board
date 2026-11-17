import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { PluginLogEntry } from '@/api/plugins'

type PluginLogsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  loading: boolean
  error: string
  entries: PluginLogEntry[]
}

function formatEntry(entry: PluginLogEntry) {
  const time = entry.at ? new Date(entry.at).toLocaleTimeString() : ''
  const level = String(entry.level || 'info')
    .toUpperCase()
    .padEnd(5)
  const fields =
    entry.fields && Object.keys(entry.fields).length ? ` ${JSON.stringify(entry.fields)}` : ''
  return `${time} ${level} ${entry.message || ''}${fields}`.trim()
}

export function PluginLogsDialog({
  open,
  onOpenChange,
  title,
  loading,
  error,
  entries,
}: PluginLogsDialogProps) {
  const body = loading
    ? '加载中…'
    : error
      ? `读取日志失败：${error}`
      : entries.length
        ? entries.map(formatEntry).join('\n')
        : '暂无日志'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-190">
        <DialogHeader>
          <p className="text-2xs font-semibold tracking-[0.14em] text-muted-foreground">
            PLUGIN LOGS
          </p>
          <DialogTitle>插件日志</DialogTitle>
          <DialogDescription>{title}</DialogDescription>
        </DialogHeader>
        <DialogBody className="mx-4 rounded-lg bg-muted px-3 py-2.5">
          <pre className="font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
            {body}
          </pre>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
