import { useState } from 'react'
import { toast } from 'sonner'
import { formatError } from '@/api/admin'
import type { SshTrustChallenge, SshTrustResult } from '@/api/admin'
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

export function SshTrustDialog({
  challenge,
  onConfirm,
  onClose,
}: {
  challenge: SshTrustChallenge | null
  onConfirm: (challengeId: string) => Promise<SshTrustResult>
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)

  async function confirm() {
    if (!challenge || busy) return
    setBusy(true)
    try {
      await onConfirm(challenge.challengeId)
    } catch (error) {
      toast.error(formatError(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={challenge !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {challenge?.replaced ? '确认 SSH 主机密钥变化' : '确认 SSH 主机指纹'}
          </DialogTitle>
          <DialogDescription>
            {challenge
              ? challenge.replaced
                ? `${challenge.host}:${challenge.port} 的主机密钥发生变化。请与仓库管理员核对新的 SHA256 指纹。`
                : `${challenge.host}:${challenge.port} 尚未建立可信关系。请与仓库管理员核对以下 SHA256 指纹。`
              : ''}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-2">
          <div className="flex flex-col gap-1.5 rounded-lg bg-muted/50 p-3">
            {challenge?.keys.map((key) => (
              <div key={`${key.algorithm}:${key.fingerprint}`} className="flex flex-col gap-0.5">
                <span className="text-[10px] font-medium text-muted-foreground">
                  {key.algorithm}
                </span>
                <code className="break-all text-[11px] text-foreground">{key.fingerprint}</code>
              </div>
            ))}
          </div>
          {challenge?.replaced ? (
            <p className="text-[11px] text-destructive">
              主机密钥与已保存值不同。确认前必须核对变化原因，不能仅凭连接成功继续。
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="button" disabled={busy} onClick={() => void confirm()}>
            {busy ? '保存中…' : challenge?.replaced ? '确认新指纹' : '信任该主机'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
