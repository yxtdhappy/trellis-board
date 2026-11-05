import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@/index.css'
import { AppProviders } from '@/app/providers'
import { BoardPage } from '@/pages/board/BoardPage'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProviders>
      <BoardPage />
    </AppProviders>
  </StrictMode>,
)
