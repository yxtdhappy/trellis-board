import type { ReactNode } from 'react'
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AppearanceProvider } from './theme.tsx'

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <AppearanceProvider>
      <ConfirmDialogProvider>
        <TooltipProvider>
          {children}
          <Toaster position="top-right" richColors closeButton />
        </TooltipProvider>
      </ConfirmDialogProvider>
    </AppearanceProvider>
  )
}
