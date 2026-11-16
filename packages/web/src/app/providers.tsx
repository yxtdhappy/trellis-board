import type { ReactNode } from 'react'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AppearanceProvider } from './theme.tsx'

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <AppearanceProvider>
      <TooltipProvider>
        {children}
        <Toaster position="top-right" richColors closeButton />
      </TooltipProvider>
    </AppearanceProvider>
  )
}
