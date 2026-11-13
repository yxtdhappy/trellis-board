import { createRoot } from 'react-dom/client'
import './desktop.css'
import { AppearanceProvider } from '@/app/theme'
import { ControlApp } from './ControlApp.tsx'

const container = document.getElementById('root')
if (container)
  createRoot(container).render(
    <AppearanceProvider>
      <ControlApp />
    </AppearanceProvider>,
  )
