// This fake kernel is installed before the app, including on Vite reloads.
const sessionID = 'benchmark-session'
window.benchDefaultWorkspace = 'E:\\工作空间\\项目 A'
window.benchWorkspace = window.benchDefaultWorkspace
window.benchSources = []
window.api = {
  getWorkspacePath: async () => window.benchWorkspace,
  chooseWorkspacePath: async () => {
    if (window.benchChoiceError) throw new Error('测试选择失败')
    const next = window.benchNextWorkspace ?? null
    window.benchNextWorkspace = null
    if (next) window.benchWorkspace = next
    return next
  },
  getServerInfo: async () => ({ status: 'ready', url: 'http://127.0.0.1:1', port: 1 }),
  onServerStatus: () => () => {}, window: { minimize() {}, maximize() {}, close() {} }
}
window.benchSessions = [
  { id: sessionID, title: 'Streaming benchmark', directory: window.benchWorkspace },
  { id: 'other-session', title: 'Other session', directory: window.benchWorkspace },
  { id: 'foreign-session', title: 'Foreign workspace', directory: 'E:\\工作空间\\项目 B' },
  { id: 'nested-session', title: 'Nested workspace', directory: window.benchWorkspace + '\\子目录' }
]
window.benchRequests = []
window.benchMessages = {}
window.benchClipboard = ''
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
  writeText: async text => { window.benchClipboard = text }
} })
let created = 0
window.fetch = async (url, options) => {
  const requestUrl = new URL(typeof url === 'string' ? url : url.url, 'http://127.0.0.1:1')
  const path = requestUrl.pathname
  const method = options?.method ?? (typeof url === 'string' ? 'GET' : url.method)
  const headers = new Headers(options?.headers ?? (typeof url === 'string' ? undefined : url.headers))
  const directory = requestUrl.searchParams.get('directory') ?? decodeURIComponent(headers.get('x-opencode-directory') ?? '')
  const body = method === 'POST' ? JSON.parse((options?.body ?? (typeof url === 'string' ? '{}' : await url.text())) || '{}') : undefined
  window.benchRequests.push({ method, path, directory, body })
  if (path === '/session' && method === 'POST') {
    if (window.benchHoldCreate === directory) await new Promise(resolve => { window.benchReleaseCreate = resolve })
    const session = { id: `created-${++created}`, title: body.title ?? 'New Session', directory }
    window.benchSessions.push(session)
    return new Response(JSON.stringify(session), { headers: { 'Content-Type': 'application/json' } })
  }
  if (path.endsWith('/prompt_async')) return new Response(null, { status: 204 })
  if (path.endsWith('/abort')) return new Response('true', { headers: { 'Content-Type': 'application/json' } })
  if (path === '/session/status') return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
  if (/^\/session\/[^/]+\/revert$/.test(path) && method === 'POST') {
    if (window.benchRevertFailure) return new Response(JSON.stringify({ message: '测试撤回失败' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    const session = window.benchSessions.find(item => item.id === path.split('/')[2])
    session.revert = { messageID: body.messageID }
    return new Response(JSON.stringify(session), { headers: { 'Content-Type': 'application/json' } })
  }
  if (/^\/session\/[^/]+\/unrevert$/.test(path) && method === 'POST') {
    const session = window.benchSessions.find(item => item.id === path.split('/')[2])
    delete session.revert
    return new Response(JSON.stringify(session), { headers: { 'Content-Type': 'application/json' } })
  }
  if (method === 'DELETE') {
    if (window.benchDeleteFailure) return new Response(JSON.stringify({ message: '测试删除失败' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
    if (window.benchHoldDelete) await new Promise(resolve => { window.benchReleaseDelete = resolve })
    const id = decodeURIComponent(path.split('/').at(-1))
    if (window.benchMissingID === id) return new Response(JSON.stringify({ message: '不存在' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
    window.benchSessions = window.benchSessions.filter(session => session.id !== id)
    return new Response('true', { headers: { 'Content-Type': 'application/json' } })
  }
  let data = []
  if (path === '/session') {
    data = (window.benchNextList ?? window.benchSessions).map(session => ({ directory: window.benchDefaultWorkspace, ...session }))
    window.benchNextList = null
    if (window.benchHoldList === directory) await new Promise(resolve => { window.benchReleaseList = resolve })
  }
  else if (/^\/session\/[^/]+$/.test(path) && method === 'GET') {
    data = window.benchSessions.find(session => session.id === path.split('/')[2]) ?? null
  }
  else if (/^\/session\/[^/]+\/message$/.test(path)) {
    const id = path.split('/')[2]
    data = window.benchMessages[id] ?? []
    if (window.benchHoldMessages === id) await new Promise(resolve => { window.benchReleaseMessages = resolve })
  }
  else if (path === '/config/providers') data = { providers: [] }
  else if (path === '/config') data = {}
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
}
window.EventSource = class {
  constructor(url) { this.url = url; window.benchSources.push(this); window.benchSource = this }
  close() { this.closed = true }
}
window.benchEmit = (type, properties) => window.benchSource.onmessage({ data: JSON.stringify({ type, properties }) })
