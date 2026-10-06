import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const production = process.argv.includes('--production')
const server = production ? null : await createServer({
  configFile: false,
  root: fileURLToPath(new URL('../src/renderer', import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ['worker', 'module', 'browser', 'development|production'] },
  optimizeDeps: {
    include: ['unified', 'remark-parse', 'remark-gfm', 'remark-math', 'remark-rehype',
      'rehype-katex', 'rehype-highlight', 'rehype-stringify', 'react-markdown']
  },
  server: { host: '127.0.0.1', port: 0 }
})
await server?.listen()
const env = {
  ...process.env,
  ...(production ? { BENCH_FILE: fileURLToPath(new URL('../out/renderer/index.html', import.meta.url)) } : { BENCH_URL: server.resolvedUrls.local[0] }),
  BENCH_LARGE: process.argv.includes('--large') ? '1' : '',
  BENCH_LAYOUT_ONLY: process.argv.includes('--layout-only') ? '1' : '',
  BENCH_LAYOUT_RECORD: process.argv.includes('--record-layout') ? '1' : '',
  BENCH_SCREENSHOT: process.argv.includes('--screenshot') ? fileURLToPath(new URL('../out/workspace-preview.png', import.meta.url)) : ''
}
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [fileURLToPath(new URL('./stream-benchmark.cjs', import.meta.url))], {
  env, stdio: 'inherit', windowsHide: true
})
const code = await new Promise(resolve => child.on('exit', resolve))
await server?.close()
process.exitCode = code ?? 1
