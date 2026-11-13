import { createRoot } from 'react-dom/client'
import './desktop.css'
import { ControlApp } from './ControlApp.tsx'

const container = document.getElementById('root')
if (container) createRoot(container).render(<ControlApp />)
