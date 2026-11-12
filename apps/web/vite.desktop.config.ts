import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const webDir = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(webDir, 'desktop')

export default defineConfig({
  root: desktopDir,
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(webDir, 'src'),
      '@shared': path.resolve(webDir, '../../packages/shared'),
    },
  },
  build: {
    outDir: path.resolve(webDir, '../desktop/ui'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.resolve(desktopDir, 'index.html'),
        control: path.resolve(desktopDir, 'control.html'),
      },
    },
  },
})
