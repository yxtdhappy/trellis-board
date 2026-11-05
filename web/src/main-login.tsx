import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/index.css'
import { AppProviders } from '@/app/providers'
import { LoginPage } from '@/pages/login/LoginPage'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProviders>
      <LoginPage />
    </AppProviders>
  </StrictMode>,
)
