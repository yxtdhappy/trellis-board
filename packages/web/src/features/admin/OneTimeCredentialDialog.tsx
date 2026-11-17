import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { copyText } from '@/browser/clipboard.js'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Credential } from '@/hooks/useAdminConsole'

export function OneTimeCredentialDialog({
  credential,
  onClose,
}: {
  credential: Credential | null
  onClose: () => void
}) {
  const [copyLabel, setCopyLabel] = useState('复制')

  async function copy() {
    if (!credential) return
    if (await copyText(credential.value)) {
      setCopyLabel('已复制')
    } else {
      setCopyLabel('请手动复制')
    }
  }

  function close() {
    setCopyLabel('复制')
    onClose()
  }

  return (
    <Dialog
      open={credential !== null}
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="sm:max-w-140">
        <DialogHeader className="gap-1">
          <p className="text-2xs font-semibold tracking-[0.2em] text-muted-foreground">
            SHOWN ONCE
          </p>
          <DialogTitle>{credential?.title || '一次性凭证'}</DialogTitle>
          <DialogDescription>{credential?.description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-2">
          <code className="block overflow-x-auto rounded-lg bg-muted px-3 py-3 text-sm font-semibold break-all text-foreground">
            {credential?.value}
          </code>
          <p className="text-2xs text-muted-foreground">
            页面不会写入 localStorage、sessionStorage 或 URL。
          </p>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" type="button" onClick={copy}>
            {copyLabel}
          </Button>
          <Button size="sm" type="button" onClick={close}>
            我已保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
