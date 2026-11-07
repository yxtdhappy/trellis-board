import { useEffect, useState } from 'react'
import { FolderPlus, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'

type ProjectManagerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: { id: string; name: string; path?: string }[]
  onList: () => Promise<{ id?: string; name?: string; path?: string }[]>
  onPick: () => Promise<string[]>
  onAdd: (paths: string[]) => Promise<void>
  onRemove: (id: string) => Promise<void>
  onScan: () => Promise<void>
}

export function ProjectManagerDialog({
  open,
  onOpenChange,
  projects,
  onList,
  onPick,
  onAdd,
  onRemove,
  onScan,
}: ProjectManagerProps) {
  const [rows, setRows] = useState<{ id?: string; name?: string; path?: string }[]>(projects)
  const [busy, setBusy] = useState(false)
  const [manualPath, setManualPath] = useState('')

  useEffect(() => {
    if (open) setRows(projects)
  }, [open, projects])

  async function reload() {
    setBusy(true)
    try {
      setRows(await onList())
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取项目失败')
    } finally {
      setBusy(false)
    }
  }

  async function rescan() {
    setBusy(true)
    try {
      await onScan()
      setRows(await onList())
      toast.success('已触发仓库重新扫描')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '重新扫描失败')
    } finally {
      setBusy(false)
    }
  }

  async function addFolders() {
    setBusy(true)
    try {
      const paths = await onPick()
      if (!paths.length) return
      await onAdd(paths)
      await reload()
      toast.success(`已纳入 ${paths.length} 个项目`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '添加项目失败')
    } finally {
      setBusy(false)
    }
  }

  async function addManualPath() {
    const target = manualPath.trim()
    if (!target) return
    setBusy(true)
    try {
      await onAdd([target])
      setManualPath('')
      await reload()
      toast.success('已纳入 1 个项目')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '添加项目失败')
    } finally {
      setBusy(false)
    }
  }

  async function remove(row: { path?: string; id?: string }) {
    if (!row.id) return
    setBusy(true)
    try {
      await onRemove(row.id)
      await reload()
      toast.success('已移除项目')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '移除项目失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>管理看板项目</DialogTitle>
          <DialogDescription>选择文件夹纳入看板，项目名称自动使用文件夹名称。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <p className="text-[11px] font-semibold text-muted-foreground">已纳入看板</p>
          {rows.length === 0 ? (
            <p className="rounded-lg bg-muted px-3 py-6 text-center text-xs text-muted-foreground">还没有项目</p>
          ) : (
            rows.map((row) => (
              <div
                key={row.path || row.id || row.name}
                className="flex items-center gap-3 rounded-lg bg-muted px-3 py-2"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-xs font-semibold">{row.name || row.id}</span>
                  <span className="truncate text-[10px] text-muted-foreground">{row.path}</span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto size-7 text-muted-foreground"
                  onClick={() => remove(row)}
                  disabled={busy}
                  aria-label={`移除 ${row.name || row.path}`}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))
          )}
          <Button variant="outline" className="h-10 gap-2 text-xs" onClick={addFolders} disabled={busy}>
            <FolderPlus className="size-3.5" />
            选择文件夹
          </Button>
          <div className="flex items-center gap-2">
            <Input
              className="h-9 text-xs"
              value={manualPath}
              onChange={(event) => setManualPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void addManualPath()
              }}
              placeholder="或直接粘贴绝对路径，例如 /home/me/repo"
              aria-label="手动输入项目路径"
              disabled={busy}
            />
            <Button
              variant="outline"
              className="h-9 shrink-0 text-xs"
              onClick={() => void addManualPath()}
              disabled={busy || !manualPath.trim()}
            >
              添加路径
            </Button>
          </div>
          <p className="text-[10.5px] leading-5 text-muted-foreground">
            只读取仓库元数据与 Trellis 配置，不会修改项目文件。文件夹选择器依赖 Windows 桌面，
            其他环境可直接填写绝对路径。
          </p>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" className="gap-1.5" onClick={() => void rescan()} disabled={busy}>
            <RefreshCw className={busy ? 'size-3.5 animate-spin' : 'size-3.5'} />
            重新扫描仓库
          </Button>
          <Button onClick={() => onOpenChange(false)}>关闭</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
