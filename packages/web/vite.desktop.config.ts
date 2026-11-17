import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const webDir = path.dirname(fileURLToPath(import.meta.url))
const desktopDir = path.resolve(webDir, 'desktop')

// dev 下 vite 用内联 style/script 注入 HMR，页面里的 CSP meta 会把它们全部拦掉（index.html 样式丢失）。
function stripDevCsp(): Plugin {
  return {
    name: 'strip-dev-csp',
    apply: 'serve',
    transformIndexHtml: (html) =>
      html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, ''),
  }
}

export default defineConfig({
  root: desktopDir,
  base: './',
  publicDir: path.resolve(webDir, 'public'),
  plugins: [react(), tailwindcss(), stripDevCsp()],
  resolve: {
    alias: {
      '@': path.resolve(webDir, 'src'),
      // dev 模式下 root 是 desktop 目录，index.html 里的 ../src 会规整成 /src，需指回 web/src
      '/src': path.resolve(webDir, 'src'),
    },
  },
  build: {
    outDir: path.resolve(webDir, '../desktop/ui'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.resolve(desktopDir, 'index.html'),
      },
    },
  },
})
