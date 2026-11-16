'use client'

import * as React from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { cn } from 'cn'

import { Button } from '@/components/ui/button'
import { XIcon } from 'lucide-react'

// 多弹层叠加时只关闭最上层：按 DOM 顺序（后挂载的在上面）比较实例 id
const DialogIdContext = React.createContext<string | null>(null)
type OpenChangeHandler = NonNullable<DialogPrimitive.Root.Props['onOpenChange']>
type OpenChangeDetails = Parameters<OpenChangeHandler>[1]

// Base UI 只读取 details.reason / details.event，这里按同一形状透传原生事件
function escapeDetails(event: KeyboardEvent): OpenChangeDetails {
  return { reason: 'escape-key', event } as unknown as OpenChangeDetails
}

function Dialog({ open, onOpenChange, ...props }: DialogPrimitive.Root.Props) {
  const id = React.useId()
  // 最新回调放 ref：内联 onOpenChange 每次渲染都会换引用，不能让监听器跟着重挂
  const changeRef = React.useRef(onOpenChange)
  changeRef.current = onOpenChange

  React.useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const dialogs = document.querySelectorAll('[data-dialog-id]')
      const topmost = dialogs[dialogs.length - 1]
      if (!topmost || topmost.getAttribute('data-dialog-id') !== id) return
      event.preventDefault()
      event.stopPropagation()
      changeRef.current?.(false, escapeDetails(event))
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [open, id])

  return (
    <DialogIdContext.Provider value={id}>
      <DialogPrimitive.Root data-slot="dialog" open={open} onOpenChange={onOpenChange} {...props} />
    </DialogIdContext.Provider>
  )
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({ className, ...props }: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        'fixed inset-0 isolate z-50 bg-black/80 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
        className,
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
}) {
  const dialogId = React.useContext(DialogIdContext)
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        data-dialog-id={dialogId ?? undefined}
        className={cn(
          'fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-hidden rounded-xl border border-border bg-card p-4 text-xs/relaxed text-card-foreground shadow-lg duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={<Button variant="ghost" className="absolute top-2 right-2" size="icon-sm" />}
          >
            <XIcon />
            <span className="sr-only">关闭</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-body"
      className={cn(
        'min-h-0 flex-1 -mx-4 overflow-y-auto overscroll-contain px-4 [scrollbar-gutter:stable_both-edges]',
        className,
      )}
      {...props}
    />
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex shrink-0 flex-col gap-1', className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex shrink-0 flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>Close</DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('font-heading text-sm font-medium', className)}
      {...props}
    />
  )
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        'text-xs/relaxed text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
        className,
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
