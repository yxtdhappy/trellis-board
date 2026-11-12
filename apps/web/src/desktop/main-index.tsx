import { createRoot } from 'react-dom/client'
import './desktop.css'
import { LoginApp } from './LoginApp.tsx'

const media = window.matchMedia('(prefers-color-scheme: dark)')
const applyTheme = () => document.documentElement.classList.toggle('dark', media.matches)
applyTheme()
media.addEventListener('change', applyTheme)

const container = document.getElementById('root')
if (container) createRoot(container).render(<LoginApp />)
