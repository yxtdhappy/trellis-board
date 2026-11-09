import { useState } from 'react'
import type { FormEvent } from 'react'
import { TRELLIS_AGENT_TOOLS } from '@shared/trellis-agent-tools.js'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { AdminUser } from '@/api/admin'
import type { PendingApproval } from '@/hooks/useAdminProjects'
import { Field, controlClass } from './shared'
import { SelectField } from '@/features/board/SelectField'

const DEVELOPER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const AGENT_TOOL_LABELS = new Map(TRELLIS_AGENT_TOOLS.map((tool) => [tool.id, tool.label]))

export type ApprovalFormValues = {
  leadUserId: string
  leadTrellisDevId: string
}

export function ApprovalSummary({
  sha256,
  files,
}: {
  sha256: string
  files: string[] | number | null
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-muted-foreground">脚本工具链摘要</span>
      <code className="block overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-[11px] break-all text-foreground">
        {sha256}
      </code>
      {typeof files === 'number' ? (
        <p className="text-[11px] text-muted-foreground">已扫描 {files} 个脚本文件</p>
      ) : files && files.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-[11px] text-muted-foreground">已扫描脚本文件</p>
          <ul className="flex flex-col gap-0.5">
            {files.map((file) => (
              <li key={file} className="text-[11px] text-muted-foreground">
                <code>{file}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">
          当前列表未返回文件清单；批准前请核对摘要来源。
        </p>
      )}
    </div>
  )
}

export function ApprovalForm({
  users,
  defaultLeadUserId,
  defaultLeadTrellisDevId,
  agentTools = [],
  onSubmit,
  onCancel,
}: {
  users: AdminUser[]
  defaultLeadUserId?: string | null
  defaultLeadTrellisDevId?: string | null
  agentTools?: string[]
  onSubmit: (values: ApprovalFormValues) => Promise<unknown>
  onCancel?: () => void
}) {
  const activeUsers = users.filter((user) => user.status === 'active')
  const lockedLead = Boolean(defaultLeadUserId && defaultLeadTrellisDevId)
  const [leadUserId, setLeadUserId] = useState(defaultLeadUserId || activeUsers[0]?.id || '')
  const [developerId, setDeveloperId] = useState(defaultLeadTrellisDevId || '')
  const [busy, setBusy] = useState(false)
  const leadUser = activeUsers.find((user) => user.id === leadUserId)
  const developerIdValid = DEVELOPER_ID_PATTERN.test(developerId.trim())

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!leadUserId || !developerIdValid) return
    setBusy(true)
    await onSubmit({ leadUserId, leadTrellisDevId: developerId.trim() })
    setBusy(false)
  }

  return (
    <form className="flex flex-col gap-2.5" onSubmit={handleSubmit}>
      {lockedLead ? (
        <div className="grid gap-2 rounded-lg border border-border bg-muted/30 p-2.5 sm:grid-cols-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-medium text-muted-foreground">首个负责人</span>
            <span className="text-xs text-foreground">
              {leadUser
                ? `${leadUser.displayName || leadUser.username}（${leadUser.username}）`
                : leadUserId}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[11px] font-medium text-muted-foreground">
              Trellis developer ID
            </span>
            <code className="text-xs text-foreground">{developerId}</code>
          </div>
          <div className="flex flex-col gap-0.5 sm:col-span-2">
            <span className="text-[11px] font-medium text-muted-foreground">Agent 工具</span>
            <span className="text-xs text-foreground">
              {agentTools.length
                ? agentTools.map((tool) => AGENT_TOOL_LABELS.get(tool) || tool).join('、')
                : '未记录'}
            </span>
          </div>
        </div>
      ) : (
        <>
          <Field label="首个负责人">
            <SelectField
              className={controlClass}
              value={leadUserId}
              placeholder="没有 active 用户"
              options={activeUsers.map((user) => ({
                value: user.id,
                label: `${user.displayName || user.username}（${user.username}）`,
              }))}
              onChange={setLeadUserId}
              disabled={busy || activeUsers.length === 0}
            />
          </Field>
          <Field
            label="负责人 Trellis developer ID"
            hint={developerId && !developerIdValid ? '格式无效' : undefined}
          >
            <Input
              maxLength={64}
              required
              pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}"
              value={developerId}
              onChange={(event) => setDeveloperId(event.target.value)}
              disabled={busy || activeUsers.length === 0}
            />
          </Field>
        </>
      )}
      <div className="flex items-center justify-end gap-2 pt-1">
        {onCancel ? (
          <Button variant="outline" size="sm" type="button" onClick={onCancel} disabled={busy}>
            取消
          </Button>
        ) : null}
        <Button size="sm" type="submit" disabled={busy || !leadUserId || !developerIdValid}>
          确认摘要并启用
        </Button>
      </div>
    </form>
  )
}

export function ApproveProjectDialog({
  approval,
  users,
  onApprove,
  onClose,
}: {
  approval: PendingApproval | null
  users: AdminUser[]
  onApprove: (values: ApprovalFormValues) => Promise<boolean>
  onClose: () => void
}) {
  return (
    <Dialog
      open={approval !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader className="gap-1">
          <p className="text-[10px] font-semibold tracking-[0.2em] text-muted-foreground">
            TOOLCHAIN / APPROVAL
          </p>
          <DialogTitle>批准项目接入</DialogTitle>
          <DialogDescription>
            {approval
              ? `${approval.project.name || approval.project.id} · ${approval.project.syncBranch || '共享分支未返回'}`
              : '核对工具链摘要和接入信息。'}
          </DialogDescription>
        </DialogHeader>
        {approval ? (
          <DialogBody className="flex flex-col gap-2.5">
            <ApprovalSummary sha256={approval.sha256} files={approval.files} />
            <ApprovalForm
              key={approval.project.id}
              users={users}
              defaultLeadUserId={approval.project.bootstrapLeadUserId}
              defaultLeadTrellisDevId={approval.project.bootstrapLeadTrellisDevId}
              agentTools={approval.project.agentTools}
              onCancel={onClose}
              onSubmit={async (values) => {
                const ok = await onApprove(values)
                if (ok) onClose()
                return ok
              }}
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              批准后服务端会运行已批准工具链的 hooks 预检；摘要变化会要求重新批准。
            </p>
          </DialogBody>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
