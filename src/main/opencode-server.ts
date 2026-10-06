import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import net from 'node:net'

export type ServerStatus = 'starting' | 'ready' | 'error' | 'stopped'

export interface ServerInfo {
  status: ServerStatus
  url?: string
  port?: number
  error?: string
  version?: string
  binary?: string
}

let proc: ChildProcess | null = null
let current: ServerInfo = { status: 'stopped' }

export function getServerInfo(): ServerInfo {
  return current
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

/**
 * 优先使用与数据库 schema 兼容的 opencode 内核：
 * 1. OPENCODE_BIN 环境变量
 * 2. 桌面版托管的内核 (%APPDATA%\Clonely\bin\opencode.exe)
 * 3. PATH 上的 opencode
 * 注意：PATH 上的 CLI 版本可能过旧，与新版数据库不兼容。
 */
export function resolveOpencodeBin(): string {
  const explicit = process.env.OPENCODE_BIN
  if (explicit && existsSync(explicit)) return explicit

  if (process.env.APPDATA) {
    const managed = join(process.env.APPDATA, 'Clonely', 'bin', 'opencode.exe')
    if (existsSync(managed)) return managed
  }
  return 'opencode'
}

function sanitizedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of [
    'OPENCODE_CLIENT',
    'OPENCODE_SERVER_PASSWORD',
    'OPENCODE_SERVER_USERNAME',
    'OPENCODE_DISABLE_EMBEDDED_WEB_UI',
    'OPENCODE_EXPERIMENTAL_FILEWATCHER',
    'OPENCODE_EXPERIMENTAL_ICON_DISCOVERY'
  ]) {
    delete env[key]
  }
  return env
}

async function waitForHealth(url: string, timeoutMs = 30000): Promise<string | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (proc && proc.exitCode !== null) return null
    try {
      const res = await fetch(`${url}/global/health`)
      if (res.ok) {
        const body = (await res.json()) as { version?: string }
        return body.version ?? 'unknown'
      }
    } catch {
      // still starting
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return null
}

export async function startServer(onUpdate: (info: ServerInfo) => void): Promise<ServerInfo> {
  stopServer()
  const binary = resolveOpencodeBin()
  current = { status: 'starting', binary }
  onUpdate(current)

  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const env = sanitizedEnv()

  console.log(`[opencode] starting: ${binary} serve --port ${port}`)
  const args = ['serve', '--port', String(port), '--hostname', '127.0.0.1']
  if (binary.toLowerCase().endsWith('.exe')) {
    proc = spawn(binary, args, { windowsHide: true, env })
  } else {
    // PATH 上的 opencode 在 Windows 下是 shell shim，需要 shell 解析
    proc = spawn(`${binary} serve --port ${port} --hostname 127.0.0.1`, {
      shell: true,
      windowsHide: true,
      env
    })
  }

  proc.stdout?.on('data', (d) => console.log('[opencode]', d.toString().trim()))
  proc.stderr?.on('data', (d) => console.log('[opencode:err]', d.toString().trim()))
  proc.on('exit', (code) => {
    console.log('[opencode] exited with code', code)
    if (current.status === 'ready') {
      current = { status: 'stopped', url, port, binary }
      onUpdate(current)
    }
  })

  const version = await waitForHealth(url)
  current = version
    ? { status: 'ready', url, port, version, binary }
    : { status: 'error', url, port, binary, error: 'opencode server 启动超时，请确认已安装 opencode' }
  onUpdate(current)
  return current
}

export function stopServer(): void {
  if (proc && proc.exitCode === null) {
    try {
      proc.kill()
    } catch {
      // ignore
    }
  }
  proc = null
}
