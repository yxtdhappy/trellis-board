import { useEffect, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { errorMessage, invoke, listen } from '@/desktop/tauri'

type LatestInfo = {
  version: string
  notes: string | null
  publishedAt: string | null
  size: number
}

type UpdateStatus = {
  enabled: boolean
  currentVersion: string
  server: string | null
  latest: LatestInfo | null
  updateAvailable: boolean
  checkedAt: string | null
  error: string | null
}

type UpdateProgress = {
  stage: string
  downloaded: number | null
  total: number | null
}

type UpdateDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  serverVersion: string
}

const STAGE_LABELS: Record<string, string> = {
  downloading: '正在下载更新包',
  verifying: '正在校验更新包',
  extracting: '正在解压更新包',
  installing: '正在安装新版本',
  restarting: '更新完成，正在重启客户端…',
}

function readProgress(value: unknown): UpdateProgress | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.stage !== 'string') return null
  return {
    stage: record.stage,
    downloaded: typeof record.downloaded === 'number' ? record.downloaded : null,
    total: typeof record.total === 'number' ? record.total : null,
  }
}

function formatTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

function formatSize(value: number): string {
  if (value <= 0) return '—'
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

async function call<T>(command: string): Promise<T> {
  if (!invoke) throw new Error('当前不在桌面客户端中')
  return invoke<T>(command)
}

export function UpdateDialog({ open, onOpenChange, serverVersion }: UpdateDialogProps) {
  if (!open) return null
  return <UpdateDialogSession onOpenChange={onOpenChange} serverVersion={serverVersion} />
}

function UpdateDialogSession({ onOpenChange, serverVersion }: Omit<UpdateDialogProps, 'open'>) {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [applying, setApplying] = useState(false)
  const [progress, setProgress] = useState<UpdateProgress | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    let stop: (() => void) | undefined

    async function load() {
      try {
        const initial = await call<UpdateStatus>('update_status')
        if (!active) return
        setStatus(initial)
        if (!initial.enabled) {
          setChecking(false)
          return
        }
        const checked = await call<UpdateStatus>('update_check')
        if (!active) return
        setStatus(checked)
        setError(checked.error || '')
      } catch (cause) {
        if (active) setError(errorMessage(cause, '检查更新失败'))
      } finally {
        if (active) setChecking(false)
      }
    }

    void load()
    const listenFn = listen
    if (listenFn) {
      void listenFn('update-progress', (event) => {
        const next = readProgress(event.payload)
        if (next && active) setProgress(next)
      }).then((unlisten) => {
        if (active) stop = unlisten
        else unlisten()
      })
    }
    return () => {
      active = false
      stop?.()
    }
  }, [])

  async function checkNow() {
    setChecking(true)
    setError('')
    try {
      const checked = await call<UpdateStatus>('update_check')
      setStatus(checked)
      setError(checked.error || '')
    } catch (cause) {
      setError(errorMessage(cause, '检查更新失败'))
    } finally {
      setChecking(false)
    }
  }

  async function applyUpdate() {
    setApplying(true)
    setError('')
    setProgress({ stage: 'downloading', downloaded: 0, total: status?.latest?.size ?? null })
    try {
      await call('update_apply')
      setProgress({ stage: 'restarting', downloaded: null, total: null })
    } catch (cause) {
      setError(errorMessage(cause, '更新失败'))
      setApplying(false)
      setProgress(null)
    }
  }

  const latest = status?.latest ?? null
  const percent =
    progress?.downloaded != null && progress.total
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null
  const stageLabel = progress ? (STAGE_LABELS[progress.stage] ?? '正在更新') : ''

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!applying) onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-120" showCloseButton={!applying}>
        <DialogHeader>
          <DialogTitle>客户端更新</DialogTitle>
          <DialogDescription>检查并安装桌面客户端的新版本。</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            <dt className="text-muted-foreground">客户端版本</dt>
            <dd>{status?.currentVersion ? `v${status.currentVersion}` : '—'}</dd>
            <dt className="text-muted-foreground">服务端版本</dt>
            <dd>{serverVersion ? `v${serverVersion}` : '—'}</dd>
            <dt className="text-muted-foreground">更新服务器</dt>
            <dd className="truncate" title={status?.server ?? undefined}>
              {status?.server ?? '未配置'}
            </dd>
          </dl>

          {status && !status.enabled ? (
            <Alert>
              <AlertTitle>未配置更新服务器</AlertTitle>
              <AlertDescription>
                当前客户端在构建时未注入更新服务器地址，自动更新已关闭。
              </AlertDescription>
            </Alert>
          ) : null}

          {error ? (
            <Alert variant="destructive">
              <AlertTitle>更新检查失败</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {checking && !applying ? (
            <div className="flex flex-col gap-2">
              <span className="text-xs text-muted-foreground">正在检查更新…</span>
              <Progress value={null} />
            </div>
          ) : null}

          {applying ? (
            <div className="flex flex-col gap-2">
              <span className="text-xs text-muted-foreground">{stageLabel}</span>
              <Progress value={percent} />
              {percent != null ? (
                <span className="text-2xs text-muted-foreground">
                  {percent}% · {formatSize(progress?.downloaded ?? 0)} /{' '}
                  {formatSize(progress?.total ?? 0)}
                </span>
              ) : null}
            </div>
          ) : null}

          {!applying && status?.enabled && status.updateAvailable && latest ? (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">发现新版本 v{latest.version}</span>
              <span className="text-xs text-muted-foreground">
                发布时间 {formatTime(latest.publishedAt)} · {formatSize(latest.size)}
              </span>
              {latest.notes ? (
                <div className="max-h-48 overflow-y-auto rounded-md border border-border bg-muted/30 p-2 text-xs whitespace-pre-wrap break-words">
                  {latest.notes}
                </div>
              ) : null}
            </div>
          ) : null}

          {!applying && !checking && status?.enabled && !status.updateAvailable && !error ? (
            <Alert>
              <AlertTitle>当前已是最新版本</AlertTitle>
              <AlertDescription>上次检查：{formatTime(status.checkedAt)}</AlertDescription>
            </Alert>
          ) : null}
        </DialogBody>
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={applying}
          >
            关闭
          </Button>
          {status?.enabled && !applying ? (
            <Button type="button" variant="outline" onClick={checkNow} disabled={checking}>
              重新检查
            </Button>
          ) : null}
          {status?.enabled && status.updateAvailable && !applying ? (
            <Button type="button" onClick={applyUpdate} disabled={checking}>
              下载并更新
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
