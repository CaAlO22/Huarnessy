const { app, BrowserWindow, ipcMain } = require('electron')
const http = require('node:http')
const assert = require('node:assert/strict')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { mkdtemp, mkdir, writeFile } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  let window, server, runtime
  const timeout = setTimeout(() => { console.error('Kernel UI regression timed out'); app.exit(1) }, 150000)
  const root = await mkdtemp(join(tmpdir(), 'huarnessy-kernel-ui-'))
  let workspace = join(root, '中文 工作空间')
  await mkdir(workspace)
  let info = { status: 'starting', attempt: 1, sequence: 0, phase: 'discovering', startedAt: Date.now(), logs: [] }
  let credentials = null
  let restartCount = 0, chooseCount = 0, resetCount = 0
  let stateReads = 0
  const requests = [], streams = new Set(), forms = [], permissions = []
  const messages = new Map()
  const session = { id: 'ses_test', title: 'V2 测试会话', location: { directory: workspace }, time: { created: 1000, updated: 1000 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 }
  const other = { ...session, id: 'ses_other', title: '分页会话' }
  const model = { id: 'alpha', modelID: 'alpha', name: 'Alpha', providerID: 'test', enabled: true, variants: [{ id: 'high' }], limit: { context: 200000, output: 32000 } }
  const sessions = [session, other]
  const update = patch => { info = { ...info, ...patch, sequence: info.sequence + 1 }; window?.webContents.send('test:status', info) }
  const emit = (type, data, directory = workspace) => {
    const event = { id: `evt_${Date.now()}`, type, created: Date.now(), location: { directory }, data }
    for (const response of streams) response.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  const report = []
  const check = (condition, name) => { assert.ok(condition, name); report.push(name) }
  const js = code => window.webContents.executeJavaScript(code)
  async function until(predicate, name) {
    const end = Date.now() + 12000
    while (!(await predicate())) { if (Date.now() > end) throw new Error(`等待失败：${name}`); await wait(30) }
  }
  const text = () => js('document.body.textContent')
  ipcMain.handle('test:workspace', () => workspace)
  ipcMain.handle('test:choose-workspace', () => null)
  ipcMain.handle('test:server', async () => { const snapshot = info; stateReads++; if (!process.env.KERNEL_TEST_REAL) await wait(100); return snapshot })
  ipcMain.handle('test:connection', () => credentials)
  ipcMain.handle('test:restart', async () => { restartCount++; await wait(100); return info })
  ipcMain.handle('test:choose-kernel', async () => { chooseCount++; return null })
  ipcMain.handle('test:reset-kernel', async () => { resetCount++; return info })
  try {
    window = new BrowserWindow({ width: 1200, height: 820, show: false, webPreferences: { preload: join(__dirname, 'kernel-ui-preload.cjs'), sandbox: false, contextIsolation: false, backgroundThrottling: false, offscreen: true } })
    window.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message) })
    const load = () => process.env.KERNEL_TEST_URL ? window.loadURL(process.env.KERNEL_TEST_URL) : window.loadFile(join(__dirname, '../out/renderer/index.html'))
    if (process.env.KERNEL_TEST_REAL) {
      runtime = await import(pathToFileURL(join(__dirname, '../out/kernel-runtime.mjs')).href)
      const binaries = [process.env.HUI_KERNEL_V1_BIN ?? join(process.env.APPDATA, 'Clonely/bin/opencode.exe'), process.env.HUI_KERNEL_V2_BIN ?? join(tmpdir(), 'huarnessy-real-kernel-2.0.32/opencode.exe')]
      for (let i = 0; i < binaries.length; i++) {
        const isolated = join(root, `real-${i}`)
        for (const sub of ['config', 'data', 'cache', 'state']) await mkdir(join(isolated, sub), { recursive: true })
        Object.assign(process.env, { XDG_CONFIG_HOME: join(isolated, 'config'), XDG_DATA_HOME: join(isolated, 'data'), XDG_CACHE_HOME: join(isolated, 'cache'), XDG_STATE_HOME: join(isolated, 'state'), OPENCODE_CONFIG_DIR: join(isolated, 'config'), OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_CONFIG_CONTENT: '{}' })
        await writeFile(join(isolated, 'config', 'opencode.json'), '{}')
        info = await runtime.startServer(value => { info = value; window.webContents.send('test:status', value) }, binaries[i])
        assert.equal(info.status, 'ready', JSON.stringify(info))
        credentials = runtime.getServerConnection()
        await load()
        await until(async () => (await text()).includes('已连接') && !(await text()).includes('正在加载工作空间'), `真实 ${info.version} 初始化`)
        const health = await js(`(async () => { const r = await fetch(${JSON.stringify(credentials.url + (credentials.protocol === 'v2' ? '/api/info' : '/global/health'))}, { headers: ${JSON.stringify(credentials.headers ?? {})} }); return { status: r.status, version: (await r.json()).version } })()`)
        check(health.status === 200 && health.version === info.version, `真实 ${info.version} 浏览器 ${process.env.KERNEL_TEST_URL ? '开发' : 'file:// 生产'} 健康接口及跨域`)
        check(!/加载会话失败|加载模型或配置失败/.test(await text()), `真实 ${info.version} SDK 会话及配置接口`)
        const event = await js(`(async () => { const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 5000); try { const r = await fetch(${JSON.stringify(credentials.url + (credentials.protocol === 'v2' ? '/api/event' : '/event?directory=' + encodeURIComponent(workspace)))}, { headers: ${JSON.stringify({ ...credentials.headers, 'x-opencode-directory': encodeURIComponent(workspace) })}, signal: abort.signal }); const value = await r.body.getReader().read(); return { status: r.status, text: new TextDecoder().decode(value.value) }; } finally { clearTimeout(timer); abort.abort(); } })()`)
        check(event.status === 200 && event.text.includes('server.connected'), `真实 ${info.version} 带目录和鉴权的 SSE 连接`)
        check(await js(`document.querySelector('[aria-label="连接状态与诊断"]').textContent.includes(${JSON.stringify(info.version)})`), `真实 ${info.version} 显示内核版本`)
        runtime.stopServer()
        await wait(300)
      }
      console.log(JSON.stringify({ realKernels: report }))
      return
    }
    server = http.createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*')
      res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,x-opencode-directory')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
      if (req.method === 'OPTIONS') { res.writeHead(204).end(); return }
      if (req.headers.authorization !== 'Basic test') { res.writeHead(401).end(); return }
      const url = new URL(req.url, 'http://127.0.0.1')
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined
      requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), directory: req.headers['x-opencode-directory'], body })
      const send = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
      const empty = () => res.writeHead(204).end()
      const path = url.pathname
      if (path === '/api/event') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ type: 'server.connected', data: {} })}\n\n`)
        streams.add(res); res.on('close', () => streams.delete(res)); return
      }
      if (path === '/api/session/active') return send({ data: {} })
      if (path === '/api/session' && req.method === 'GET') return send({ data: url.searchParams.get('cursor') ? sessions.slice(1) : sessions.slice(0, 1), cursor: { next: url.searchParams.get('cursor') ? null : 'page2' } })
      if (path === '/api/session' && req.method === 'POST') return send({ data: session })
      if (/^\/api\/session\/[^/]+$/.test(path)) {
        const id = path.split('/')[3]
        if (req.method === 'DELETE') { const index = sessions.findIndex(s => s.id === id); if (index >= 0) sessions.splice(index, 1); return empty() }
        return send({ data: sessions.find(s => s.id === id) ?? session })
      }
      if (path.endsWith('/message')) return send({ data: messages.get(path.split('/')[3]) ?? [], cursor: {} })
      if (path.endsWith('/prompt')) {
        const user = { id: 'msg_user', type: 'user', text: body.text, files: body.files, time: { created: Date.now() } }
        messages.set('ses_test', [user])
        emit('session.inbox.enqueued', { sessionID: 'ses_test', inboxID: user.id, item: { type: 'user', payload: body } })
        return send({ data: { id: user.id, sessionID: 'ses_test', time: user.time, type: 'user', payload: body } })
      }
      if (path.endsWith('/model') && req.method === 'POST' || path.endsWith('/agent') && req.method === 'POST') return empty()
      if (path === '/api/model') return send({ location: { directory: workspace }, data: [model] })
      if (path === '/api/model/default') return send({ location: { directory: workspace }, data: model })
      if (path === '/api/provider') return send({ location: { directory: workspace }, data: [{ id: 'test', name: '测试模型' }] })
      if (path === '/api/agent') return send({ location: { directory: workspace }, data: [{ id: 'build', name: 'build', mode: 'primary', hidden: false }] })
      if (path === '/api/command') return send({ location: { directory: workspace }, data: [{ name: 'review' }] })
      if (path === '/api/skill') return send({ location: { directory: workspace }, data: [{ id: 'skill_test', name: 'skill-test' }] })
      if (path === '/api/permission/request') return send({ location: { directory: workspace }, data: permissions })
      if (path.includes('/permission/') && path.endsWith('/reply')) { permissions.length = 0; return empty() }
      if (path === '/api/form') return send({ location: { directory: workspace }, data: forms })
      if (path.includes('/form/') && path.endsWith('/reply')) { forms.length = 0; return empty() }
      if (path.endsWith('/revert/stage')) { session.revert = { messageID: body.messageID }; return send({ data: session.revert }) }
      if (path.endsWith('/revert') && req.method === 'DELETE') { delete session.revert; return empty() }
      if (path.endsWith('/interrupt')) return send({ interrupted: true })
      if (path.endsWith('/compact')) return send({ data: { id: 'msg_compaction' } })
      res.writeHead(404).end()
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    credentials = { url: `http://127.0.0.1:${server.address().port}`, protocol: 'v2', attempt: 1, headers: { Authorization: 'Basic test' } }
    await load()
    await until(async () => (await text()).includes('正在查找内核'), '初始查找状态')
    await until(async () => stateReads > 0, '状态快照读取开始')
    update({ phase: 'version' })
    await until(async () => (await text()).includes('正在检测版本'), '版本探测状态')
    await wait(150)
    check((await text()).includes('正在检测版本'), '迟到初始快照不能覆盖实时状态')
    update({ phase: 'launching' })
    await until(async () => (await text()).includes('正在启动服务'), '启动状态')
    update({ phase: 'checking' })
    await until(async () => (await text()).includes('正在验证接口'), '探测状态')
    update({ status: 'error', phase: 'error', error: '测试内核无法执行', hint: '请选择正确的内核文件', errorKind: 'spawn', binary: 'E:\\测试 内核\\opencode.exe' })
    await until(async () => (await text()).includes('测试内核无法执行'), '明确失败原因')
    await wait(120)
    await writeFile(join(__dirname, '../out/kernel-connection-failure.png'), (await window.webContents.capturePage()).toPNG())
    check(await js(`!!document.querySelector('[aria-label="内核连接状态"]')`), '首次连接进度与失败原因可见')
    await js(`document.querySelector('[aria-label="连接状态与诊断"]').click()`)
    await until(async () => await js(`!!document.querySelector('[aria-label="连接诊断"]')`), '诊断面板')
    await wait(240)
    check(await js(`(() => { const r=document.querySelector('[aria-label="连接诊断"]').getBoundingClientRect(); return r.top>=0 && r.bottom<=innerHeight && r.left>=0 && r.right<=innerWidth })()`), '诊断面板完整位于窗口内且不会被标题栏裁切')
    await writeFile(join(__dirname, '../out/kernel-connection-diagnostics.png'), (await window.webContents.capturePage()).toPNG())
    await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='复制诊断报告').click()`)
    await until(async () => await js(`window.testClipboard.includes('测试内核无法执行')`), '复制诊断')
    check(!await js(`window.testClipboard.includes('Basic test')`), '复制报告不含连接凭据')
    await js(`(() => { const b = Array.from(document.querySelectorAll('[aria-label="连接诊断"] button')).find(b=>b.textContent==='重试连接'); b.click(); b.click() })()`)
    await wait(150); check(restartCount === 1, '重试按钮防止重复提交')
    await js(`Array.from(document.querySelectorAll('[aria-label="连接诊断"] button')).find(b=>b.textContent==='选择内核').click()`)
    await until(async () => chooseCount === 1, '手动选择')
    await wait(50)
    await js(`Array.from(document.querySelectorAll('[aria-label="连接诊断"] button')).find(b=>b.textContent==='恢复自动选择').click()`)
    await until(async () => resetCount === 1, '恢复自动')
    await js(`document.querySelector('[aria-label="关闭连接诊断"]').click()`)
    update({ status: 'ready', phase: 'ready', error: undefined, hint: undefined, url: credentials.url, protocol: 'v2', version: '2.0.32' })
    await until(async () => (await text()).includes('分页会话') && streams.size > 0, '2.x 初始化及分页')
    check((await text()).includes('v2.0.32'), '新版版本与分页会话显示')
    await js(`Array.from(document.querySelectorAll('aside button')).find(b=>b.title==='V2 测试会话').click()`)
    await wait(100)
    await js(`(() => { const t=document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'测试问题'); t.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    await wait(50)
    await js(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`)
    await until(async () => requests.some(r => r.path.endsWith('/prompt')), '发送新版消息')
    const data = { sessionID: 'ses_test', assistantMessageID: 'msg_assistant' }
    emit('session.step.started', { ...data, model: { id: 'alpha', providerID: 'test' }, agent: 'build', started: Date.now() })
    emit('session.text.started', { ...data, ordinal: 0 })
    emit('session.text.delta', { ...data, ordinal: 0, delta: '原生流式正文' })
    await until(async () => (await text()).includes('原生流式正文'), '新版原生增量')
    emit('session.text.ended', { ...data, ordinal: 0, text: '原生流式正文' })
    await wait(150)
    check(await js(`Array.from(document.querySelectorAll('.hui-md')).filter(e=>e.textContent==='原生流式正文').length===1`), '新版原生增量和结束快照不会重复')
    emit('session.text.delta', { ...data, ordinal: 0, delta: '其他目录串线' }, join(root, 'foreign'))
    await wait(100); check(!(await text()).includes('其他目录串线'), '新版全局事件严格隔离目录')
    const permission = { id: 'per_test', sessionID: 'ses_test', action: 'shell', resources: ['echo test'], save: ['echo *'] }
    permissions.push(permission); emit('permission.asked', permission)
    await until(async () => (await text()).includes('工具等待授权'), '新版待授权')
    await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='允许一次').click()`)
    await until(async () => requests.some(r => r.path.includes('/permission/') && r.body?.decision === 'once'), '新版授权回复')
    const form = { id: 'frm_test', sessionID: 'ses_test', title: '新版条件表单', fields: [{ type: 'boolean', key: 'show', title: '展开数量' }, { type: 'integer', key: 'count', title: '数量', required: true, minimum: 1, when: [{ key: 'show', op: 'eq', value: true }] }] }
    forms.push(form); emit('form.created', { form })
    await until(async () => (await text()).includes('新版条件表单'), '新版表单')
    check(!await js(`!!document.querySelector('[aria-label="数量"]')`), '表单条件未满足时隐藏字段')
    await js(`document.querySelector('[aria-label="需要回答的表单"] input[type=checkbox]').click()`)
    await until(async () => await js(`!!document.querySelector('[aria-label="数量"]')`), '条件字段显示')
    await js(`(() => { const t=document.querySelector('[aria-label="数量"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(t,'2');t.dispatchEvent(new Event('input',{bubbles:true})); })()`)
    await wait(40)
    await js(`document.querySelector('[aria-label="需要回答的表单"]').requestSubmit()`)
    await until(async () => requests.some(r => r.path.includes('/form/') && r.body?.answer?.count === 2), '新版数字表单提交')
    check(requests.every(r => decodeURIComponent(r.directory) === workspace), '新版所有 REST 和事件连接携带目录')
    for (const response of streams) response.end()
    await until(async () => (await text()).includes('正在重连'), '新版事件断线提示')
    await until(async () => streams.size > 0 && !(await text()).includes('正在重连'), '新版事件恢复')
    await until(async () => requests.filter(r => r.path === '/api/session/active').length >= 2, '断线恢复状态查询')
    check(true, '新版断线恢复后补查会话状态')
    console.log(JSON.stringify({ kernelUI: report, mode: process.env.KERNEL_TEST_URL ? 'development' : 'production', input: '独立 2.0.32 HTTP/SSE 假内核，无模型请求' }))
  } catch (error) {
    console.error(error)
    if (window) console.error((await text().catch(() => '')).slice(-4500))
    process.exitCode = 1
  } finally {
    runtime?.stopServer()
    for (const response of streams) response.end()
    server?.closeAllConnections(); server?.close()
    window?.destroy(); clearTimeout(timeout); app.exit(process.exitCode ?? 0)
  }
})
