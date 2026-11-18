import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const rootDir = path.dirname(fileURLToPath(import.meta.url))
const serverPort = process.env.PORT || '4317'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 多个 dev server 共用 node_modules/.vite 会互相失效依赖优化（504 Outdated Optimize Dep）
  cacheDir: process.env.VITE_CACHE_DIR || 'node_modules/.vite',
  resolve: {
    alias: {
      '@': path.resolve(rootDir, 'src'),
    },
  },
  build: {
    outDir: path.resolve(rootDir, '../server/public'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(rootDir, 'index.html'),
        admin: path.resolve(rootDir, 'admin.html'),
        login: path.resolve(rootDir, 'login.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${serverPort}`,
        // 保持原始 Host/Origin 一致：服务端 CSRF 校验要求 Origin 与 Host 同源
        changeOrigin: false,
      },
      // 插件面板 iframe 依赖宿主提供的样式/脚本，dev 下不代理会被 index.html 兜底成 HTML。
      '/plugin-ui': {
        target: `http://127.0.0.1:${serverPort}`,
        changeOrigin: false,
      },
    },
  },
})
