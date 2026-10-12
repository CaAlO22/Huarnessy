import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'
const source = readFileSync(new URL('../src/renderer/src/stream-observations.ts', import.meta.url), 'utf8')
const { code } = transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' })
const { StreamObservations } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

const fixture = () => {
  let now = 0
  const values = new Map()
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  const observer = new StreamObservations(storage, () => now)
  const directory = 'E:\\项目 A'
  const sessionID = 'session'
  const emit = (time, type, properties) => { now = time; observer.receive(directory, type, properties) }
  const info = (id, tokens, parentID = 'user') => ({ id, sessionID, role: 'assistant', parentID, tokens, time: { created: 1, ...(tokens ? { completed: 999999 } : {}) } })
  const begin = () => { observer.begin(directory, sessionID, 'old-user'); emit(1, 'message.updated', { info: { id: 'user', sessionID, role: 'user' } }) }
  const part = (time, id, type, text, messageID = 'one') => emit(time, 'message.part.updated', { part: { id, sessionID, messageID, type, text } })
  const delta = (time, partID, text, messageID = 'one') => emit(time, 'message.part.delta', { sessionID, messageID, partID, field: 'text', delta: text })
  const finish = (id = 'one', tokens = { output: 20, reasoning: 0 }) => {
    const entry = { info: info(id, tokens), parts: [] }
    emit(now + 1, 'message.updated', { info: entry.info })
    return entry
  }
  return { observer, storage, directory, sessionID, emit, info, begin, part, delta, finish }
}

test('first nonempty reasoning/text and actual output spans exclude empty parts, duplicates, tool gaps and completion delay', () => {
  const f = fixture(); f.begin()
  f.emit(2, 'message.updated', { info: f.info('one') })
  f.part(10, 'reason', 'reasoning', '')
  f.delta(100, 'reason', '思考')
  f.part(150, 'reason', 'reasoning', '思考')
  f.part(180, 'text', 'text', '')
  f.delta(200, 'text', '答')
  f.delta(300, 'text', '案')
  f.part(4000, 'text', 'text', '答案')
  const first = f.finish('one', { output: 20, reasoning: 20 })
  f.emit(8000, 'message.updated', { info: f.info('two') })
  f.part(9000, 'next', 'text', '', 'two')
  f.delta(10000, 'next', '结', 'two')
  f.delta(10200, 'next', '论', 'two')
  const second = f.finish('two', { output: 40, reasoning: 0 })
  assert.deepEqual(f.observer.metrics(f.directory, f.sessionID, [first, second]), { firstTokenSeconds: .1, speed: 200 })
})

test('completed observations survive reopening and remain isolated by workspace and session', () => {
  const f = fixture(); f.begin(); f.part(100, 'text', 'text', 'a'); f.delta(300, 'text', 'b')
  const entry = f.finish()
  const restored = new StreamObservations(f.storage)
  assert.deepEqual(restored.metrics('e:/项目 A/', f.sessionID, [entry]), { firstTokenSeconds: .1, speed: 100 })
  assert.deepEqual(restored.metrics('E:/项目 B', f.sessionID, [entry]), { firstTokenSeconds: null, speed: null })
  assert.deepEqual(restored.metrics(f.directory, 'other-session', [entry]), { firstTokenSeconds: null, speed: null })
  f.observer.begin(f.directory, f.sessionID, 'user')
  f.emit(400, 'message.updated', { info: entry.info })
  assert.equal(f.observer.metrics(f.directory, f.sessionID, [entry]).speed, 100)
})

test('history, empty streams, single batches and hidden reasoning never invent speeds', () => {
  const f = fixture()
  assert.deepEqual(f.observer.metrics(f.directory, f.sessionID, [f.finish()]), { firstTokenSeconds: null, speed: null })
  f.begin(); f.part(100, 'only', 'text', 'single batch')
  assert.equal(f.observer.metrics(f.directory, f.sessionID, [f.finish()]).speed, null)
  const hidden = fixture(); hidden.begin(); hidden.part(100, 'text', 'text', 'a'); hidden.delta(200, 'text', 'b')
  assert.equal(hidden.observer.metrics(hidden.directory, hidden.sessionID, [hidden.finish('one', { output: 10, reasoning: 100 })]).speed, null)
})

test('disconnects, removals and regressive snapshots invalidate incomplete observations', () => {
  for (const action of ['disconnect', 'remove', 'regress']) {
    const f = fixture(); f.begin(); f.part(100, 'text', 'text', 'abc'); f.delta(300, 'text', 'def')
    if (action === 'disconnect') f.observer.disconnect()
    if (action === 'remove') f.emit(350, 'message.part.removed', { sessionID: f.sessionID, messageID: 'one', partID: 'text' })
    if (action === 'regress') f.part(350, 'text', 'text', 'a')
    assert.equal(f.observer.metrics(f.directory, f.sessionID, [f.finish()]).speed, null)
  }
})

test('old message metadata cannot bind delayed snapshots to a new request', () => {
  const f = fixture(); f.begin()
  f.emit(2, 'message.updated', { info: f.info('old-reply', undefined, 'old-user') })
  f.part(100, 'old-text', 'text', 'late text', 'old-reply')
  f.delta(300, 'old-text', 'more', 'old-reply')
  assert.deepEqual(f.observer.metrics(f.directory, f.sessionID, [f.finish('old-reply')]), { firstTokenSeconds: null, speed: null })
})

test('typed snapshots can classify earlier deltas without adding their delivery time; synthetic text is excluded', () => {
  const f = fixture(); f.begin()
  f.delta(100, 'late-kind', '思考')
  f.part(200, 'late-kind', 'reasoning', '思考')
  f.delta(300, 'late-kind', '结束')
  const entry = f.finish('one', { output: 0, reasoning: 20 })
  assert.deepEqual(f.observer.metrics(f.directory, f.sessionID, [entry]), { firstTokenSeconds: .1, speed: 100 })
  const synthetic = fixture(); synthetic.begin()
  synthetic.emit(100, 'message.part.updated', { part: { id: 'synthetic', messageID: 'one', sessionID: synthetic.sessionID, type: 'text', synthetic: true, text: 'injected' } })
  synthetic.delta(200, 'synthetic', 'more')
  assert.deepEqual(synthetic.observer.metrics(synthetic.directory, synthetic.sessionID, [synthetic.finish()]), { firstTokenSeconds: null, speed: null })
})
