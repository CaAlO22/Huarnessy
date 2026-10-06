// This fake kernel is installed before the app, including on Vite reloads.
const sessionID = 'benchmark-session'
window.api = {
  getServerInfo: async () => ({ status: 'ready', url: 'http://127.0.0.1:1', port: 1 }),
  onServerStatus: () => () => {}, window: { minimize() {}, maximize() {}, close() {} }
}
window.fetch = async url => {
  const path = new URL(typeof url === 'string' ? url : url.url, 'http://127.0.0.1:1').pathname
  let data = []
  if (path === '/session') data = [{ id: sessionID, title: 'Streaming benchmark' }, { id: 'other-session', title: 'Other session' }]
  else if (path === '/config/providers') data = { providers: [] }
  else if (path === '/config') data = {}
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })
}
window.EventSource = class {
  constructor() { window.benchSource = this }
  close() {}
}
window.benchEmit = (type, properties) => window.benchSource.onmessage({ data: JSON.stringify({ type, properties }) })
