import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

async function bundle(file) {
  const output = await build({ entryPoints: [file], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' })
  return import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text + '\n//# sourceURL=' + file + '.test.mjs').toString('base64'))
}
const { createKernelClient } = await bundle('src/renderer/src/kernel-client.ts')
const { V2Projection, partID } = await bundle('src/renderer/src/kernel-projection.ts')
const { reduceMessageEvents } = await bundle('src/renderer/src/stream-state.ts')

test('2.x 原生流：正文/思考结束快照替换增量，工具 ID 稳定且跨目录隔离', () => {
  const projection = new V2Projection('E:\\工作空间 A')
  const event = (type, data, directory = 'E:\\工作空间 A') => ({ type, id: 'event', created: 1000, location: { directory }, data: { sessionID: 'session', ...data } })
  let messages = []
  const receive = e => { messages = reduceMessageEvents(messages, projection.events(e).filter(e => e.type.startsWith('message.'))) }
  receive(event('session.inbox.enqueued', { inboxID: 'user', item: { type: 'user', payload: { text: 'hello' } } }))
  receive(event('session.step.started', { assistantMessageID: 'assistant', model: { id: 'model', providerID: 'provider' }, started: 1000 }))
  receive(event('session.reasoning.started', { assistantMessageID: 'assistant', ordinal: 0 }))
  receive(event('session.reasoning.delta', { assistantMessageID: 'assistant', ordinal: 0, delta: '思考' }))
  receive(event('session.reasoning.ended', { assistantMessageID: 'assistant', ordinal: 0, text: '思考' }))
  receive(event('session.text.started', { assistantMessageID: 'assistant', ordinal: 1 }))
  receive(event('session.text.delta', { assistantMessageID: 'assistant', ordinal: 1, delta: '你好' }))
  assert.equal(messages[1].parts[1].text, '你好', '增量立即可见')
  receive(event('session.text.ended', { assistantMessageID: 'assistant', ordinal: 1, text: '你好' }))
  assert.equal(messages[1].parts[1].text, '你好', '终态不重复追加')
  assert.equal(messages[1].parts[0].type, 'reasoning')
  assert.equal(messages[1].info.parentID, 'user')
  receive(event('session.text.delta', { assistantMessageID: 'assistant', ordinal: 1, delta: '串线' }, 'E:\\工作空间 B'))
  assert.equal(messages[1].parts[1].text, '你好')
  for (const [type, data] of [['session.tool.input.started', { name: 'shell' }], ['session.tool.input.delta', { delta: '{"x":1}' }], ['session.tool.called', { input: { x: 1 } }], ['session.tool.success', { content: [{ type: 'text', text: 'ok' }] }]]) receive(event(type, { assistantMessageID: 'assistant', id: 'tool', ...data }))
  const tool = messages[1].parts[2]
  assert.equal(tool.state.output, 'ok')
  assert.equal(tool.state.status, 'completed')
  const history = projection.history('session', [{ id: 'user', type: 'user', text: 'hello' }, { id: 'assistant', type: 'assistant', content: [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '你好' }, { type: 'tool', id: 'tool', name: 'shell', state: { status: 'completed', content: [{ type: 'text', text: 'ok' }] } }] }])
  assert.deepEqual(history[1].parts.map(p => p.id), messages[1].parts.map(p => p.id))
  assert.equal(history[1].parts[1].id, partID('assistant', 1))
  assert.deepEqual(projection.events({ type: 'session.text.delta', data: { sessionID: 'unknown', delta: 'foreign' } }), [])
})

test('2.x SDK 请求合约：分页、目录、鉴权、模型选择、附件、撤回、权限和表单', async () => {
  const original = globalThis.fetch
  const requests = []
  const directory = 'E:\\工作空间 A'
  const session = { id: 'session', title: 'test', location: { directory }, time: { created: 1000 }, model: { id: 'model', providerID: 'provider' } }
  globalThis.fetch = async (url, init) => {
    const u = new URL(url instanceof Request ? url.url : url)
    const body = init?.body ? JSON.parse(init.body) : undefined
    const path = u.pathname
    requests.push({ url: u, method: init?.method, headers: new Headers(init?.headers), body })
    let output
    if (path === '/api/session' && init.method === 'GET') output = { data: u.searchParams.get('cursor') ? [] : [session], cursor: { next: u.searchParams.get('cursor') ? null : 'page2' } }
    else if (path === '/api/session' && init.method === 'POST') output = { data: session }
    else if (path === '/api/session/session') { if (init.method === 'DELETE') return new Response(null, { status: 204 }); output = { data: session } }
    else if (path === '/api/session/session/message') output = { data: u.searchParams.get('cursor') ? [{ id: 'assistant', type: 'assistant', time: { created: 2000 }, content: [{ type: 'text', text: '回复' }] }] : [{ id: 'user', type: 'user', text: '问题', time: { created: 1000 } }], cursor: { next: u.searchParams.get('cursor') ? null : 'page2' } }
    else if (path.endsWith('/prompt')) output = { data: { id: 'new-user', type: 'user', time: { created: 3000 }, payload: body } }
    else if (path.endsWith('/revert/stage')) output = { data: { messageID: 'user' } }
    else if (path.endsWith('/compact')) output = { data: { id: 'compaction' } }
    else if (path === '/api/model') output = { location: { directory }, data: [{ id: 'model', providerID: 'provider', name: 'Model', enabled: true, variants: [{ id: 'high' }], limit: { context: 1000, output: 100 } }] }
    else if (path === '/api/provider') output = { location: { directory }, data: [{ id: 'provider', name: 'Provider' }] }
    else if (path === '/api/model/default') output = { location: { directory }, data: { id: 'model', providerID: 'provider' } }
    else if (path === '/api/agent') output = { location: { directory }, data: [{ id: 'build', name: 'Build', mode: 'primary', hidden: false }] }
    else if (path === '/api/command') output = { location: { directory }, data: [{ name: 'review' }] }
    else if (path === '/api/skill') output = { location: { directory }, data: [{ id: 'skill_id', name: 'skill' }] }
    else if (path === '/api/permission/request') output = { location: { directory }, data: [{ id: 'permission', sessionID: 'session', action: 'shell', resources: ['echo *'], save: ['echo *'] }] }
    else if (path === '/api/form') output = { location: { directory }, data: [{ id: 'form', sessionID: 'session', title: '表单', fields: [{ type: 'number', key: 'count', required: true }] }] }
    else if (path === '/api/session/active') output = { data: { session: { type: 'running' } } }
    else {
      if (/\/(model|agent|reply|wait|command|skill|revert)$/.test(path) || path.endsWith('/form/form') && init.method === 'DELETE') return new Response(null, { status: 204 })
      if (path.endsWith('/reply') || path.endsWith('/interrupt')) return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
      throw new Error(`未模拟接口 ${init.method} ${path}`)
    }
    return new Response(JSON.stringify(output), { headers: { 'Content-Type': 'application/json' } })
  }
  const client = createKernelClient({ protocol: 'v2', url: 'http://127.0.0.1:1234', headers: { Authorization: 'Basic test' } }, directory)
  try {
    assert.equal((await client.session.list()).data.length, 1)
    assert.equal((await client.session.create({ body: {} })).data.id, 'session')
    assert.equal(requests.find(r => r.url.pathname === '/api/session' && r.method === 'POST').body.location.directory, directory)
    assert.equal((await client.config.providers()).data.providers[0].models.model.variants.high instanceof Object, true)
    assert.equal((await client.config.get()).data.model, 'provider/model')
    assert.equal((await client.app.agents()).data[0].name, 'build')
    assert.deepEqual((await client.command.list()).data.map(c => c.name), ['review', 'skill'])
    const messages = (await client.session.messages({ path: { id: 'session' } })).data
    assert.equal(messages.length, 2)
    assert.equal(messages[1].info.parentID, 'user')
    await client.session.promptAsync({ path: { id: 'session' }, body: { model: { providerID: 'provider', modelID: 'model' }, variant: 'high', parts: [{ type: 'text', text: '问题' }, { type: 'file', filename: 'a.png', url: 'data:image/png;base64,YQ==' }] } })
    const prompt = requests.find(r => r.url.pathname.endsWith('/prompt'))
    assert.equal(prompt.body.files[0].uri, 'data:image/png;base64,YQ==')
    assert.equal(requests.find(r => r.url.pathname.endsWith('/model') && r.method === 'POST').body.model.variant, 'high')
    assert.equal((await client.session.revert({ path: { id: 'session' }, body: { messageID: 'user' } })).data.revert.messageID, 'user')
    assert.equal(requests.find(r => r.url.pathname.endsWith('/revert/stage')).body.files, true)
    await client.session.summarize({ path: { id: 'session' } })
    assert.ok(requests.some(r => r.url.pathname.endsWith('/wait')))
    await client.session.command({ path: { id: 'session' }, body: { command: 'review', arguments: 'changes' } })
    assert.equal(requests.find(r => r.url.pathname.endsWith('/command') && r.method === 'POST').body.name, 'review')
    await client.session.command({ path: { id: 'session' }, body: { command: 'skill', arguments: 'task' } })
    assert.equal(requests.find(r => r.url.pathname.endsWith('/skill') && r.method === 'POST').body.id, 'skill_id')
    await client.session.abort({ path: { id: 'session' } })
    assert.equal(requests.find(r => r.url.pathname.endsWith('/interrupt')).url.searchParams.get('resume'), 'false')
    await client.session.unrevert({ path: { id: 'session' } })
    assert.equal((await client.permission.list({ directory })).data[0].permission, 'shell')
    await client.permission.reply({ directory, requestID: 'permission', reply: 'once' })
    assert.equal(requests.find(r => r.url.pathname.endsWith('/permission/permission/reply')).body.decision, 'once')
    assert.ok((await client.question.list({ directory })).data[0].form)
    await client.question.reply({ directory, requestID: 'form', answer: { count: 2 } })
    assert.deepEqual(requests.find(r => r.url.pathname.endsWith('/form/form/reply')).body.answer, { count: 2 })
    assert.equal((await client.session.status()).data.session.type, 'busy')
    await client.question.list({ directory })
    await client.question.reject({ directory, requestID: 'form' })
    assert.equal((await client.session.delete({ path: { id: 'session' } })).data, true)
    assert.ok(requests.every(r => r.headers.get('Authorization') === 'Basic test'))
    assert.ok(requests.every(r => decodeURIComponent(r.headers.get('x-opencode-directory')) === directory))
  } finally { client.dispose(); globalThis.fetch = original }
})

test('1.x 适配保留旧路径及目录参数，HTTP 错误不会被吞掉', async () => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    calls.push(request)
    if (new URL(request.url).pathname === '/session') return new Response('[]', { headers: { 'Content-Type': 'application/json' } })
    return new Response(JSON.stringify({ message: '失败' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
  const client = createKernelClient({ protocol: 'v1', url: 'http://127.0.0.1:1234' }, 'E:\\中文目录')
  try {
    assert.deepEqual((await client.session.list({ query: { directory: 'E:\\中文目录' } })).data, [])
    await assert.rejects(client.config.get())
    assert.equal(new URL(calls[0].url).pathname, '/session')
    assert.equal(new URL(calls[0].url).searchParams.get('directory') ?? decodeURIComponent(calls[0].headers.get('x-opencode-directory')), 'E:\\中文目录')
  } finally { client.dispose(); globalThis.fetch = original }
})

test('1.x 命令列表使用较长读取时限，普通读取仍按短时限中止', async () => {
  const original = globalThis.fetch
  const directory = 'E:\\中文目录'
  const delayed = (body, delay, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(new Response(body, { headers: { 'Content-Type': 'application/json' } })), delay)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
  globalThis.fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const signal = init?.signal ?? request.signal
    if (new URL(request.url).pathname === '/command') return delayed(JSON.stringify([{ name: 'review' }]), 30, signal)
    return delayed('[]', 300, signal)
  }
  // 1.x /command 会等待 MCP prompts；用短时限验证策略选择，不依赖真实 MCP。
  const client = createKernelClient({ protocol: 'v1', url: 'http://127.0.0.1:1234' }, directory, { readTimeoutMs: 60, listingTimeoutMs: 1000 })
  try {
    assert.deepEqual((await client.command.list({ query: { directory } })).data.map(c => c.name), ['review'])
    await assert.rejects(client.session.list({ query: { directory } }), /timeout|timed out/i)
  } finally { client.dispose(); globalThis.fetch = original }
})

test('2.x 重连历史恢复工具状态，迟到历史不覆盖新一轮父消息', () => {
  const projection = new V2Projection('E:\\目录')
  projection.history('session', [{ type: 'user', id: 'old-user', time: { created: 1 } }, { type: 'assistant', id: 'assistant', content: [{ type: 'tool', id: 'call', name: 'shell', state: { status: 'running', input: { command: 'echo test' } } }] }])
  const event = (type, data) => ({ id: 'evt', created: 100, location: { directory: 'E:\\目录' }, type, data: { sessionID: 'session', ...data } })
  const tool = projection.events(event('session.tool.success', { assistantMessageID: 'assistant', id: 'call', content: [{ type: 'text', text: 'ok' }] }))[0].properties.part
  assert.equal(tool.tool, 'shell')
  assert.equal(tool.state.input.command, 'echo test')
  projection.events(event('session.inbox.enqueued', { inboxID: 'new-user', item: { type: 'user', payload: { text: 'new' } } }))
  projection.history('session', [{ type: 'user', id: 'old-user' }], false)
  const meta = projection.events(event('session.step.started', { assistantMessageID: 'new-assistant', model: { id: 'model', providerID: 'provider' } }))[0]
  assert.equal(meta.properties.info.parentID, 'new-user')
})
