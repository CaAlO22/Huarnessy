// This fake kernel is installed before the app, including on Vite reloads.
const sessionID = 'benchmark-session'
window.api = {
  getServerInfo: async () => ({ status: 'ready', url: 'http://127.0.0.1:1', port: 1 }),
  onServerStatus: () => () => {}, window: { minimize() {}, maximize() {}, close() {} }
}
window.benchSessions = [{ id: sessionID, title: 'Streaming benchmark' }, { id: 'other-session', title: 'Other session' }]
window.benchRequests = []
window.fetch = async (url, options) => {
  const path = new URL(typeof url === 'string' ? url : url.url, 'http://127.0.0.1:1').pathname
  const method = options?.method ?? (typeof url === 'string' ? 'GET' : url.method)
  window.benchRequests.push({ method, path })
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
    data = window.benchNextList ?? window.benchSessions
    window.benchNextList = null
  }
  else if (path === '/config/providers') data = { providers: [] }
  else if (path === '/config') data = {}
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
}
window.EventSource = class {
  constructor() { window.benchSource = this }
  close() {}
}
window.benchEmit = (type, properties) => window.benchSource.onmessage({ data: JSON.stringify({ type, properties }) })
