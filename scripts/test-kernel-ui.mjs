import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const production = process.argv.includes('--production')
await build({ entryPoints: ['src/main/opencode-server.ts'], outfile: 'out/kernel-runtime.mjs', bundle: true, platform: 'node', format: 'esm' })
const server = production ? null : await createServer({ configFile: false, root: 'src/renderer', cacheDir: '../../node_modules/.vite-kernel-ui', plugins: [react(), tailwindcss()], resolve: { conditions: ['worker', 'module', 'browser', 'development|production'] }, optimizeDeps: { include: ['unified', 'remark-parse', 'remark-gfm', 'remark-math', 'remark-rehype', 'rehype-katex', 'rehype-highlight', 'rehype-stringify', 'react-markdown'] }, server: { host: '127.0.0.1', port: 0 } })
await server?.listen()
const env = { ...process.env, KERNEL_TEST_URL: server?.resolvedUrls.local[0] ?? '', KERNEL_TEST_REAL: process.argv.includes('--real') ? '1' : '' }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(new URL('./kernel-ui.cjs', import.meta.url))], { env, stdio: 'inherit', windowsHide: true })
const code = await new Promise(resolve => child.on('exit', resolve))
await server?.close()
process.exitCode = code ?? 1
