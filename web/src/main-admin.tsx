import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/index.css'
import { AppProviders } from '@/app/providers'
import { AdminPage } from '@/pages/admin/AdminPage'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProviders>
      <AdminPage />
    </AppProviders>
  </StrictMode>,
)
