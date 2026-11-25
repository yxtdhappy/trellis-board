import { useEffect, useMemo, useState } from 'react'
import { BookOpenCheck, RefreshCw } from 'lucide-react'
import { Alert, AlertDescription } from '@/components/ui/alert'
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { StatusPill } from '@/components/ui/status-pill'
import { cn } from '@/lib/utils'
import {
  companySpecErrorMessage,
  normalizeCompanySpecApplyResult,
  normalizeCompanySpecPlan,
  normalizeCompanySpecStatus,
  type CompanySpecApplyResult,
  type CompanySpecPlan,
  type CompanySpecStatus,
} from '@/lib/company-spec.js'
import type { TauriInvoke } from './project-onboarding-types.ts'

type CompanySpecDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  repoPath: string
  projectName: string
  invoke: TauriInvoke
}

const GROUPS = [
  { id: 'frontend', label: '前端' },
  { id: 'backend', label: '后端' },
  { id: 'fullstack', label: '全栈' },
  { id: 'other', label: '其他' },
] as const

const STATE_LABEL: Record<
  string,
  { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }
> = {
  not_applied: { label: '未套用', tone: 'neutral' },
  applied: { label: '已套用', tone: 'success' },
  template_mismatch: { label: '模板不同', tone: 'warning' },
  update_source_missing: { label: '缺少更新源', tone: 'warning' },
  incomplete: { label: '不完整', tone: 'danger' },
}

function stateLabel(state: string) {
  return STATE_LABEL[state] || { label: state || '未知', tone: 'neutral' as const }
}

export function CompanySpecDialog({
  open,
  onOpenChange,
  repoPath,
  projectName,
  invoke,
}: CompanySpecDialogProps) {
  const [status, setStatus] = useState<CompanySpecStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selection, setSelection] = useState('auto')
  const [plan, setPlan] = useState<CompanySpecPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [strategy, setStrategy] = useState('keep-local')
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<CompanySpecApplyResult | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    if (!open || !repoPath) return
    let cancelled = false
    setLoading(true)
    setError('')
    setPlan(null)
    setResult(null)
    void invoke('inspect_company_spec', { repoPath })
      .then((value) => {
        if (cancelled) return
        const next = normalizeCompanySpecStatus(value)
        setStatus(next)
        if (!next) {
          setError('当前客户端未启用公司规范能力。')
          return
        }
        setSelection(next.template || 'auto')
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(companySpecErrorMessage(cause, '读取公司规范状态失败'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, repoPath, invoke, reloadToken])

  const effectiveStrategy = plan?.action === 'update' ? strategy : 'replace'
  const canPlan = Boolean(status && selection)
  const canApply = Boolean(plan && !planning && !applying)

  const planCounts = useMemo(() => {
    if (!plan) return []
    return [
      ['新增', plan.files.add],
      ['更新', plan.files.update],
      ['保留', plan.files.keep],
      ['冲突', plan.files.conflict],
      ['删除', plan.files.delete],
      ['保留已删除', plan.files.keepDeleted],
    ].filter(([, count]) => Number(count) > 0) as Array<[string, number]>
  }, [plan])

  async function checkPlan() {
    setPlanning(true)
    setError('')
    setResult(null)
    try {
      const value = await invoke('plan_company_spec', {
        repoPath,
        selection: selection === 'none' ? null : selection,
      })
      const next = normalizeCompanySpecPlan(value)
      if (!next) throw new Error('没有返回有效的变更预览')
      setPlan(next)
      setStrategy(next.action === 'update' ? 'keep-local' : 'replace')
    } catch (cause) {
      setPlan(null)
      setError(companySpecErrorMessage(cause, '检查公司规范更新失败'))
    } finally {
      setPlanning(false)
    }
  }

  async function applyPlan() {
    if (!plan) return
    setApplying(true)
    setError('')
    try {
      const value = await invoke('apply_company_spec', {
        repoPath,
        selection: selection === 'none' ? null : selection,
        strategy: effectiveStrategy,
      })
      const next = normalizeCompanySpecApplyResult(value)
      if (!next) throw new Error('没有返回有效的套用结果')
      setResult(next)
      setPlan(null)
      setReloadToken((token) => token + 1)
    } catch (cause) {
      setError(companySpecErrorMessage(cause, '套用公司规范失败'))
    } finally {
      setApplying(false)
    }
  }

  const statusView = status ? stateLabel(status.state) : null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-135">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpenCheck className="size-4" aria-hidden="true" />
            公司开发规范
          </DialogTitle>
          <DialogDescription>
            {projectName} · 只写入 <code>.trellis/spec</code>，不重跑 Trellis 初始化。
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">正在读取状态…</p>
          ) : !status ? (
            <Alert variant="destructive">
              <AlertDescription>{error || '当前项目无法使用公司规范能力。'}</AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">当前状态</span>
                  {statusView ? (
                    <StatusPill tone={statusView.tone}>{statusView.label}</StatusPill>
                  ) : null}
                </div>
                <dl className="grid grid-cols-[76px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
                  <dt className="text-muted-foreground">模板</dt>
                  <dd className="break-all">{status.template || '未套用'}</dd>
                  <dt className="text-muted-foreground">版本</dt>
                  <dd>{status.version || '-'}</dd>
                  <dt className="text-muted-foreground">更新源</dt>
                  <dd className="break-all">{status.registrySource || '未记录'}</dd>
                </dl>
                {status.warning ? <p className="text-xs text-warning">{status.warning}</p> : null}
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-xs font-medium" htmlFor="company-spec-template">
                  选择模板
                </label>
                <Select
                  value={selection}
                  onValueChange={(value) => {
                    setSelection(String(value ?? 'auto'))
                    setPlan(null)
                    setResult(null)
                  }}
                  disabled={planning || applying}
                >
                  <SelectTrigger id="company-spec-template" className="w-full rounded-md">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">自动识别（推荐）</SelectItem>
                    {GROUPS.map((group) => {
                      const options = status.templates.filter(
                        (template) => template.group === group.id,
                      )
                      if (!options.length) return null
                      return (
                        <SelectGroup key={group.id}>
                          <SelectLabel>{group.label}</SelectLabel>
                          {options.map((template) => (
                            <SelectItem key={template.id} value={template.id}>
                              {template.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      )
                    })}
                  </SelectContent>
                </Select>
                {selection === 'auto' && status.detected ? (
                  <p className="text-xs text-muted-foreground">
                    {status.detected.template
                      ? `检测到 ${status.detected.projectType || '当前技术栈'}，将套用 ${status.detected.template}。`
                      : status.detected.warning || '无法自动识别技术栈。'}
                  </p>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canPlan || planning || applying}
                  onClick={() => void checkPlan()}
                >
                  <RefreshCw className={cn('size-3.5', planning && 'animate-spin')} />
                  {planning ? '正在检查…' : '检查变更'}
                </Button>
              </div>

              {plan ? (
                <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <StatusPill tone="warning">{plan.action}</StatusPill>
                    <span className="text-muted-foreground">
                      {plan.currentTemplate || '无'} → {plan.template}
                      {plan.version ? ` · ${plan.version}` : ''}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    {planCounts.length ? (
                      planCounts.map(([label, count]) => (
                        <span key={label} className="text-muted-foreground">
                          {label} <span className="font-medium text-foreground">{count}</span>
                        </span>
                      ))
                    ) : (
                      <span className="text-muted-foreground">没有文件变化。</span>
                    )}
                  </div>
                  {plan.action === 'update' ? (
                    <div className="flex flex-col gap-1.5">
                      <label className="text-xs font-medium" htmlFor="company-spec-strategy">
                        更新策略
                      </label>
                      <Select
                        value={strategy}
                        onValueChange={(value) => setStrategy(String(value ?? 'keep-local'))}
                        disabled={applying}
                      >
                        <SelectTrigger id="company-spec-strategy" className="w-full rounded-md">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="keep-local">保留本地修改（推荐）</SelectItem>
                          <SelectItem value="overwrite">覆盖冲突文件</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      将先备份现有 spec，再整体替换为所选模板。
                    </p>
                  )}
                  <Button type="button" disabled={!canApply} onClick={() => void applyPlan()}>
                    {applying ? '正在套用…' : plan.action === 'update' ? '应用更新' : '套用模板'}
                  </Button>
                </div>
              ) : null}

              {result ? (
                <Alert>
                  <AlertDescription>
                    {result.applied
                      ? `已套用 ${result.template}，写入 ${result.written} 个文件。`
                      : '模板未套用。'}
                    {result.backupPath ? ` 备份：${result.backupPath}` : ''}
                    {result.warning ? ` ${result.warning}` : ''}
                  </AlertDescription>
                </Alert>
              ) : null}
              {error ? <p className="text-xs text-destructive">{error}</p> : null}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
