import * as React from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export type ConfirmOptions = {
  title: string
  description?: React.ReactNode
  confirmText?: string
  cancelText?: string
  tone?: 'default' | 'danger'
}

type ConfirmRequest = { options: ConfirmOptions; resolve: (confirmed: boolean) => void }
type Confirm = (options: ConfirmOptions) => Promise<boolean>

// ponytail: 缺 Provider 时视为取消；破坏性操作宁可不执行，也不静默通过
const ConfirmContext = React.createContext<Confirm>(() => Promise.resolve(false))

export function useConfirm() {
  return React.useContext(ConfirmContext)
}

export function ConfirmDialogProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = React.useState<ConfirmRequest | null>(null)
  const pending = React.useRef<ConfirmRequest[]>([])

  const confirm = React.useCallback<Confirm>(
    (options) =>
      new Promise<boolean>((resolve) => {
        const next = { options, resolve }
        pending.current.push(next)
        setRequest((current) => current ?? next)
      }),
    [],
  )

  const settle = React.useCallback((confirmed: boolean) => {
    const head = pending.current.shift()
    head?.resolve(confirmed)
    setRequest(pending.current[0] ?? null)
  }, [])

  const options = request?.options

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog
        open={options !== undefined}
        onOpenChange={(open) => {
          if (!open) settle(false)
        }}
      >
        {options && (
          <DialogContent showCloseButton={false}>
            <DialogHeader>
              <DialogTitle>{options.title}</DialogTitle>
            </DialogHeader>
            {options.description && (
              <p className="whitespace-pre-line text-xs/relaxed text-muted-foreground">
                {options.description}
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => settle(false)}>
                {options.cancelText ?? '取消'}
              </Button>
              <Button
                variant={options.tone === 'danger' ? 'destructive' : 'default'}
                onClick={() => settle(true)}
              >
                {options.confirmText ?? '确认'}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  )
}
