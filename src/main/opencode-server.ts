import { spawn, spawnSync, execFile, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import type { ServerInfo, ServerErrorKind, KernelCandidate, KernelConnection } from '../shared/kernel'
export type { ServerInfo } from '../shared/kernel'

let proc: ChildProcess | null = null
let controller: AbortController | undefined
let generation = 0
let current: ServerInfo = { status: 'stopped', attempt: 0, sequence: 0 }
let connection: KernelConnection | null = null

export function getServerInfo(): ServerInfo { return current }
export function getServerConnection(): KernelConnection | null { return current.status === 'ready' ? connection : null }

export function redactLog(text: string, secret?: string): string {
  let clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  if (secret) clean = clean.split(secret).join('[已隐藏]')
  return clean.replace(/(authorization\s*[:=]\s*)(?:Basic|Bearer)\s+\S+/gi, '$1[已隐藏]')
    .replace(/((?:password|api[_-]?key|token|secret)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[已隐藏]')
}

function killTree(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null || !child.pid) return
  if (process.platform === 'win32') {
    // Only terminate the process tree that this application created, never another TUI's service.
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    killer.on('error', () => { try { child.kill() } catch { /* Already exited. */ } })
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill() } catch { /* Already exited. */ } }
  }
}

export function stopServer(): void {
  generation++
  controller?.abort()
  controller = undefined
  killTree(proc)
  proc = null
  connection = null
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

// Compatibility helpers used by existing discovery tests. Startup uses the asynchronous probe below.
export function commandOnPath(command: string): boolean {
  try { return spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { windowsHide: true, timeout: 5000 }).status === 0 } catch { return false }
}
/** Explicit selection precedes the managed kernel; an old CLI can be incompatible with its database schema. */
export function resolveOpencodeBin(): string | null {
  if (process.env.OPENCODE_BIN && existsSync(process.env.OPENCODE_BIN)) return process.env.OPENCODE_BIN
  const managed = process.env.APPDATA && join(process.env.APPDATA, 'Clonely', 'bin', 'opencode.exe')
  if (managed && existsSync(managed)) return managed
  return commandOnPath('opencode') ? 'opencode' : null
}

export async function discoverKernels(manual?: string, signal?: AbortSignal): Promise<KernelCandidate[]> {
  const found: KernelCandidate[] = []
  if (manual) found.push({ path: manual, source: 'manual' })
  if (process.env.OPENCODE_BIN && existsSync(process.env.OPENCODE_BIN)) found.push({ path: process.env.OPENCODE_BIN, source: 'environment' })
  const managed = process.env.APPDATA && join(process.env.APPDATA, 'Clonely', 'bin', 'opencode.exe')
  if (managed && existsSync(managed)) found.push({ path: managed, source: 'managed' })
  const paths = await new Promise<string>(resolve => {
    execFile(process.platform === 'win32' ? 'where' : 'which', process.platform === 'win32' ? ['opencode'] : ['-a', 'opencode'],
      { windowsHide: true, timeout: 5000, signal }, (error, stdout) => resolve(error ? '' : stdout))
  })
  for (const path of paths.split(/\r?\n/).map(p => p.trim()).filter(p => p && existsSync(p) && (process.platform !== 'win32' || /\.(exe|cmd|bat)$/i.test(p)))) found.push({ path, source: 'path' })
  const seen = new Set<string>()
  return found.filter(item => {
    const key = process.platform === 'win32' ? item.path.toLowerCase() : item.path
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function launch(binary: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  // Windows npm shims require cmd. Quote the executable and every argument; never interpolate user commands.
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary)) {
    if (/["\r\n%]/.test(binary)) throw new Error('内核脚本路径包含无法安全传递给 cmd 的字符，请选择 opencode.exe')
    const command = `"${binary}" ${args.map(arg => `"${arg}"`).join(' ')}`
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { env, windowsHide: true, windowsVerbatimArguments: true })
  }
  return spawn(binary, args, { env, windowsHide: true, detached: process.platform !== 'win32' })
}

export async function startServer(onUpdate: (info: ServerInfo) => void, manual?: string): Promise<ServerInfo> {
  stopServer()
  const attempt = generation
  const abort = new AbortController()
  controller = abort
  const valid = () => generation === attempt && !abort.signal.aborted
  let secret: string | undefined
  let child: ChildProcess | null = null
  const update = (patch: Partial<ServerInfo>) => {
    if (!valid()) return
    const stages = [...(current.stages ?? [])]
    if (patch.phase && patch.phase !== current.phase) stages.push({ phase: patch.phase, at: Date.now() })
    current = { ...current, ...patch, stages, sequence: (current.sequence ?? 0) + 1 }
    onUpdate(current)
  }
  const fail = (kind: ServerErrorKind, message: string, hint?: string) => {
    update({ status: 'error', phase: 'error', errorKind: kind, error: message, hint: hint ? redactLog(hint, secret) : '展开诊断查看详细信息，也可选择其他内核或恢复自动选择。' })
    killTree(child)
    if (proc === child) proc = null
    connection = valid() ? null : connection
  }
  current = { status: 'starting', phase: 'discovering', attempt, sequence: 0, startedAt: Date.now(), stages: [{ phase: 'discovering', at: Date.now() }], logs: [] }
  onUpdate(current)
  const log = (channel: string, data: Buffer) => {
    if (!valid()) return
    // Retain real startup errors (including SQLite schema failures), bounded by both lines and bytes.
    let logs = [...(current.logs ?? []), ...redactLog(data.toString(), secret).split(/\r?\n/).filter(Boolean).map(line => `[${channel}] ${line}`)].slice(-200)
    while (Buffer.byteLength(logs.join('\n')) > 65536) {
      if (logs.length === 1) { logs = [logs[0].slice(-16000)]; break }
      logs.shift()
    }
    update({ logs })
  }
  try {
    const candidates = await discoverKernels(manual, abort.signal)
    if (!valid()) return current
    update({ candidates })
    const selected = candidates[0]
    if (!selected || !existsSync(selected.path)) {
      fail('not-found', selected ? '已指定的内核文件不存在' : '未找到 OpenCode 内核', selected ? '请重新选择内核文件，或恢复自动选择。' : '请安装 OpenCode 命令行内核并加入 PATH，或点击“选择内核”指定可执行文件。')
      return current
    }
    update({ binary: selected.path, source: selected.source, phase: 'version', hint: process.env.OPENCODE_BIN && !existsSync(process.env.OPENCODE_BIN) ? 'OPENCODE_BIN 指向不存在的文件，已使用后续发现结果。' : undefined })
    const env = { ...process.env }
    for (const key of ['OPENCODE_CLIENT', 'OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME', 'OPENCODE_DISABLE_EMBEDDED_WEB_UI', 'OPENCODE_EXPERIMENTAL_FILEWATCHER', 'OPENCODE_EXPERIMENTAL_ICON_DISCOVERY']) delete env[key]
    let probe: ChildProcess
    try { probe = launch(selected.path, ['--version'], env) } catch (e) { fail('spawn', '无法执行内核', String(e)); return current }
    proc = probe
    const output = await new Promise<string>((resolve, reject) => {
      let text = ''
      const timer = setTimeout(() => { killTree(probe); reject(new Error('版本探测超时（5 秒）')) }, 5000)
      const cancel = () => { clearTimeout(timer); killTree(probe); reject(new Error('已取消')) }
      abort.signal.addEventListener('abort', cancel, { once: true })
      probe.stdout?.on('data', d => { text = (text + d).slice(-16000) })
      probe.stderr?.on('data', d => { text = (text + d).slice(-16000) })
      const finish = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', cancel) }
      probe.on('error', error => { finish(); reject(error) })
      probe.on('close', code => { finish(); code === 0 ? resolve(text) : reject(new Error(`版本探测退出码 ${code}：${text}`)) })
    }).catch(e => { if (valid()) fail('version', '无法识别内核版本', String(e)); return null })
    if (!valid() || output === null) return current
    const version = output.match(/\b([12]\.\d+\.\d+(?:-[\w.-]+)?)/)?.[1]
    if (!version) { fail('version', '不支持或无法识别的内核版本', output); return current }
    const protocol = version.startsWith('2.') ? 'v2' : 'v1'
    update({ version, protocol, phase: 'launching' })
    let port: number
    try { port = await freePort() } catch (e) { fail('port', '无法分配本地服务端口', String(e)); return current }
    if (!valid()) return current
    const url = `http://127.0.0.1:${port}`
    const args = ['serve', '--port', String(port), '--hostname', '127.0.0.1']
    const headers: Record<string, string> = {}
    if (protocol === 'v2') {
      secret = randomBytes(32).toString('base64url')
      env.OPENCODE_PASSWORD = secret
      headers.Authorization = `Basic ${Buffer.from(`opencode:${secret}`).toString('base64')}`
      args.push('--cors', 'null')
    }
    update({ url, port, args })
    child = launch(selected.path, args, env)
    proc = child
    let spawnError: Error | undefined
    let exited = false
    child.stdout?.on('data', d => log('stdout', d))
    child.stderr?.on('data', d => log('stderr', d))
    child.on('error', error => { spawnError = error; if (valid()) fail('spawn', '无法启动内核进程', error.message) })
    child.on('exit', code => {
      exited = true
      if (!valid()) return
      update({ exitCode: code })
      if (current.status === 'ready') fail('exited', `内核进程已退出（退出码 ${code ?? '未知'}）`)
    })
    update({ phase: 'checking' })
    const endpoint = `${url}${protocol === 'v2' ? '/api/info' : '/global/health'}`
    const deadline = Date.now() + 30000
    while (valid() && Date.now() < deadline) {
      if (spawnError) return current
      if (exited) { fail('exited', `内核启动后退出（退出码 ${current.exitCode ?? '未知'}）`, current.logs?.slice(-8).join('\n')); return current }
      try {
        const response = await fetch(endpoint, { headers, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(Math.min(2000, Math.max(1, deadline - Date.now())))]) })
        update({ lastProbe: { endpoint, status: response.status } })
        if (response.status === 401 || response.status === 403) { fail('auth', '内核鉴权失败'); return current }
        if (response.status === 404) { fail('protocol', '内核接口与检测到的版本不兼容'); return current }
        if (response.ok) {
          const body = await response.json()
          if (typeof body.version !== 'string' || (protocol === 'v1' && body.healthy !== true) || !body.version.startsWith(protocol === 'v2' ? '2.' : '1.')) { fail('protocol', '内核返回了不兼容的健康检查数据'); return current }
          if (!valid() || exited || spawnError) return current
          connection = { attempt, url, protocol, headers }
          update({ status: 'ready', phase: 'ready', version: body.version })
          return current
        }
      } catch (error) { update({ lastProbe: { endpoint, error: redactLog(String(error), secret) } }) }
      await new Promise<void>(resolve => { const timer = setTimeout(done, 400); function done() { clearTimeout(timer); abort.signal.removeEventListener('abort', done); resolve() }; abort.signal.addEventListener('abort', done, { once: true }) })
    }
    if (valid()) fail('timeout', '内核启动超时（30 秒未就绪）', current.logs?.slice(-8).join('\n'))
  } catch (error) { if (valid()) fail('spawn', '内核启动失败', String(error)) }
  return current
}
