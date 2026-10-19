import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import net from 'node:net'

export type ServerStatus = 'starting' | 'ready' | 'error' | 'stopped'

// 启动失败的具体原因分类，渲染层据此展示不同的提示文案。
export type ServerErrorKind = 'not-found' | 'exited' | 'timeout'

export interface ServerInfo {
  status: ServerStatus
  url?: string
  port?: number
  error?: string
  errorKind?: ServerErrorKind
  hint?: string
  version?: string
  binary?: string
}

let proc: ChildProcess | null = null
let current: ServerInfo = { status: 'stopped' }
// 保留内核 stderr 的最后几行，启动失败时随错误一起呈现给用户，
// 否则像 SQLite schema 不兼容这类真实报错只存在于主进程控制台。
const STDERR_TAIL_LINES = 8
let stderrTail: string[] = []

function pushStderr(text: string): void {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed) stderrTail.push(trimmed)
  }
  if (stderrTail.length > STDERR_TAIL_LINES) stderrTail = stderrTail.slice(-STDERR_TAIL_LINES)
}

function stderrHint(): string | undefined {
  return stderrTail.length ? stderrTail.join('\n') : undefined
}

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

export function commandOnPath(command: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  try {
    return spawnSync(probe, [command], { windowsHide: true }).status === 0
  } catch {
    return false
  }
}

/**
 * 优先使用与数据库 schema 兼容的 opencode 内核：
 * 1. OPENCODE_BIN 环境变量
 * 2. 桌面版托管的内核 (%APPDATA%\Clonely\bin\opencode.exe)
 * 3. PATH 上的 opencode（先用 where/which 确认存在，找不到返回 null，
 *    避免把不存在的命令丢给 shell 后只能报出误导性的“启动超时”）
 * 注意：PATH 上的 CLI 版本可能过旧，与新版数据库不兼容。
 */
export function resolveOpencodeBin(): string | null {
  const explicit = process.env.OPENCODE_BIN
  if (explicit && existsSync(explicit)) return explicit

  if (process.env.APPDATA) {
    const managed = join(process.env.APPDATA, 'Clonely', 'bin', 'opencode.exe')
    if (existsSync(managed)) return managed
  }
  return commandOnPath('opencode') ? 'opencode' : null
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

type HealthResult = { version: string } | { exitCode: number | null } | { timeout: true }

async function waitForHealth(url: string, timeoutMs = 30000): Promise<HealthResult> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (proc && proc.exitCode !== null) return { exitCode: proc.exitCode }
    try {
      const res = await fetch(`${url}/global/health`)
      if (res.ok) {
        const body = (await res.json()) as { version?: string }
        return { version: body.version ?? 'unknown' }
      }
    } catch {
      // still starting
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  return { timeout: true }
}

export async function startServer(onUpdate: (info: ServerInfo) => void): Promise<ServerInfo> {
  stopServer()
  stderrTail = []
  const explicit = process.env.OPENCODE_BIN
  const explicitInvalid = Boolean(explicit) && !existsSync(explicit as string)
  const binary = resolveOpencodeBin()
  if (!binary) {
    // 本机根本没有可用内核：直接给出安装指引，而不是等 shell 报错后误报“启动超时”。
    current = {
      status: 'error',
      errorKind: 'not-found',
      error: '未找到 opencode 内核',
      hint: explicitInvalid
        ? `OPENCODE_BIN 指向的文件不存在（${explicit}）。请修正该环境变量，或安装 opencode 使其在 PATH 中可用（https://opencode.ai）。`
        : '请先安装 opencode 内核（https://opencode.ai），确保 opencode 命令在 PATH 中可用；也可设置 OPENCODE_BIN 环境变量指向内核可执行文件。'
    }
    onUpdate(current)
    return current
  }
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
  proc.stderr?.on('data', (d) => {
    const text = d.toString().trim()
    console.log('[opencode:err]', text)
    pushStderr(text)
  })
  proc.on('error', (err) => {
    console.log('[opencode] spawn error', err)
    pushStderr(String(err))
  })
  proc.on('exit', (code) => {
    console.log('[opencode] exited with code', code)
    if (current.status === 'ready') {
      current = { status: 'stopped', url, port, binary }
      onUpdate(current)
    }
  })

  const health = await waitForHealth(url)
  if ('version' in health) {
    current = { status: 'ready', url, port, version: health.version, binary }
  } else if ('exitCode' in health) {
    current = {
      status: 'error',
      url,
      port,
      binary,
      errorKind: 'exited',
      error: `opencode server 意外退出（退出码 ${health.exitCode ?? '未知'}）`,
      hint: stderrHint() ?? '内核启动后立即退出；若报数据库字段错误，可能是 CLI 版本过旧，与托管内核数据库不兼容。'
    }
  } else {
    current = {
      status: 'error',
      url,
      port,
      binary,
      errorKind: 'timeout',
      error: 'opencode server 启动超时（30 秒未就绪）',
      hint: stderrHint()
    }
  }
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
