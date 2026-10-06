import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    optimizeDeps: {
      include: ['unified', 'remark-parse', 'remark-gfm', 'remark-math', 'remark-rehype',
        'rehype-katex', 'rehype-highlight', 'rehype-stringify', 'react-markdown']
    },
    resolve: {
      // Markdown entity decoding must use its DOM-free worker export.
      conditions: ['worker', 'module', 'browser', 'development|production'],
      alias: {
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
