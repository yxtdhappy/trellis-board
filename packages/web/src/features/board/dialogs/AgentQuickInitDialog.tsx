import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { TRELLIS_AGENT_TOOLS } from '@trellis-board/shared/trellis-agent-tools.js'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { ProjectInspection } from '@/lib/project-inspection.js'
import { normalizeProjectInspection } from '@/lib/project-inspection.js'
import { onboardingErrorMessage } from '@/lib/onboarding-probe.js'
import { AgentToolSelector } from './AgentToolSelector.tsx'

type TauriInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

type AgentQuickInitDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  taskSpaceId: string
  defaultDeveloperId: string
  invoke: TauriInvoke
}

export function AgentQuickInitDialog({
  open,
  onOpenChange,
  taskSpaceId,
  defaultDeveloperId,
  invoke,
}: AgentQuickInitDialogProps) {
  const [inspection, setInspection] = useState<ProjectInspection | null>(null)
  const [developerId, setDeveloperId] = useState('')
  const [selectedTools, setSelectedTools] = useState<string[]>([])
  const [agentSearch, setAgentSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const developerIdEdited = useRef(false)
  const dialogHeaderRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const { signal } = controller
    developerIdEdited.current = false
    setInspection(null)
    setSelectedTools([])
    setAgentSearch('')
    setError('')
    setBusy(false)
    setLoading(true)
    if (!taskSpaceId) {
      setLoading(false)
      setError('当前项目分支没有可用的本地任务空间。')
      return
    }
    void invoke('inspect_associated_project_agents', { taskSpaceId })
      .then((value) => {
        if (signal.aborted) return
        const next = normalizeProjectInspection(value)
        if (!next) throw new Error('没有读取到有效的本地项目信息')
        setInspection(next)
      })
      .catch((reason: unknown) => {
        if (!signal.aborted) {
          setError(onboardingErrorMessage(reason, '无法读取当前仓库的编码 Agent 状态'))
        }
      })
      .finally(() => {
        if (!signal.aborted) setLoading(false)
      })
    return () => {
      controller.abort()
    }
  }, [open, taskSpaceId, invoke])

  useEffect(() => {
    if (!open || developerIdEdited.current) return
    setDeveloperId(defaultDeveloperId.trim())
  }, [open, taskSpaceId, defaultDeveloperId])

  const missingTools = useMemo(
    () =>
      inspection
        ? TRELLIS_AGENT_TOOLS.filter((tool) => !inspection.existingAgentTools.includes(tool.id))
        : [],
    [inspection],
  )
  const missingToolIds = useMemo(() => new Set(missingTools.map((tool) => tool.id)), [missingTools])
  const allInitialized = Boolean(inspection && missingTools.length === 0)
  const submitDisabled =
    loading ||
    busy ||
    !inspection ||
    !developerId.trim() ||
    selectedTools.length === 0 ||
    selectedTools.some((id) => !missingToolIds.has(id))

  function toggleTool(id: string) {
    if (busy || !missingToolIds.has(id)) return
    setSelectedTools((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
    setError('')
  }

  async function initialize() {
    if (!inspection || busy) return
    if (!developerId.trim()) {
      setError('请填写 Trellis developer ID。')
      return
    }
    if (!selectedTools.length) {
      setError('请至少选择一个尚未初始化的编码 Agent。')
      return
    }
    if (selectedTools.some((id) => !missingToolIds.has(id))) {
      setError('所选 Agent 已经初始化或不在支持列表中，请重新选择。')
      return
    }
    setBusy(true)
    setError('')
    try {
      const value = await invoke('initialize_associated_project_agents', {
        taskSpaceId,
        developerId: developerId.trim(),
        agentTools: selectedTools,
      })
      const next = normalizeProjectInspection(value)
      if (!next) throw new Error('初始化后没有返回有效项目信息')
      setInspection(next)
      toast.success(`已初始化 ${selectedTools.length} 个本机编码 Agent。`)
      onOpenChange(false)
    } catch (reason) {
      setError(onboardingErrorMessage(reason, '初始化本机编码 Agent 失败'))
    } finally {
      setBusy(false)
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && busy) return
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-145" initialFocus={dialogHeaderRef}>
        <form
          className="flex min-h-0 flex-1 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void initialize()
          }}
        >
          <DialogHeader ref={dialogHeaderRef} tabIndex={-1} className="outline-none">
            <DialogTitle>初始化编码 Agent</DialogTitle>
            <DialogDescription>
              只影响当前电脑，不影响团队任务空间和其他设备。客户端会直接使用当前分支已批准的本地关联。
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-4">
            {loading ? (
              <p className="rounded-lg border border-dashed border-border p-4 text-muted-foreground">
                正在读取当前仓库已初始化的编码 Agent…
              </p>
            ) : inspection ? (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="quick-agent-developer">Trellis developer ID</Label>
                  <Input
                    id="quick-agent-developer"
                    value={developerId}
                    maxLength={120}
                    placeholder="例如 zhangsan"
                    disabled={busy || allInitialized}
                    onChange={(event) => {
                      developerIdEdited.current = true
                      setDeveloperId(event.target.value)
                      setError('')
                    }}
                  />
                </div>
                <AgentToolSelector
                  existingTools={inspection.existingAgentTools}
                  selectedTools={selectedTools}
                  search={agentSearch}
                  disabled={busy}
                  onSearchChange={setAgentSearch}
                  onToggleTool={toggleTool}
                />
                {allInitialized ? (
                  <p className="rounded-lg border border-success/35 bg-success-soft p-3 text-success">
                    当前仓库的编码 Agent 均已初始化，无需重复操作。
                  </p>
                ) : null}
              </>
            ) : null}
            {error ? (
              <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-destructive">
                {error}
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={submitDisabled}>
              {busy
                ? '正在初始化…'
                : allInitialized
                  ? '已全部初始化'
                  : selectedTools.length
                    ? `初始化 ${selectedTools.length} 个 Agent`
                    : '初始化所选 Agent'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
