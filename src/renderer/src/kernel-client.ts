import { createOpencodeClient as legacyClient } from '@opencode-ai/sdk/client'
import { createOpencodeClient as legacyInteractions } from '@opencode-ai/sdk/v2/client'
import { OpenCode } from '@opencode/client'
import type { KernelConnection } from '../../shared/kernel'
import type { MessageEntry } from './stream-state'
import { sameWorkspace } from './workspace-path'
import { V2Projection, permissionV2, questionV2, type KernelEvent, type PermissionRequest, type QuestionRequest } from './kernel-projection'
export type { PermissionRequest, QuestionRequest } from './kernel-projection'

export interface KernelInput { path?: { id: string }; body?: any; query?: { directory?: string }; throwOnError?: boolean }
export interface KernelResult<T> { data: T; error?: any; response?: Response }
type Call<T> = (input?: KernelInput) => Promise<KernelResult<T>>
export interface KernelSubscription { close(): void }
export interface KernelClient {
  session: {
    list: Call<any[]>; create: Call<any>; get: Call<any>; delete: Call<boolean>; messages: Call<MessageEntry[]>
    status: Call<Record<string, any>>; promptAsync: Call<void>; command: Call<void>; abort: Call<void>
    revert: Call<any>; unrevert: Call<void>; summarize: Call<void>
  }
  config: { providers: Call<any>; get: Call<any> }
  app: { agents: Call<any[]> }
  command: { list: Call<any[]> }
  permission: {
    list(input: { directory: string }, options?: unknown): Promise<KernelResult<PermissionRequest[]>>
    reply(input: { directory: string; requestID: string; reply: 'once' | 'always' | 'reject' }, options?: unknown): Promise<unknown>
  }
  question: {
    list(input: { directory: string }, options?: unknown): Promise<KernelResult<QuestionRequest[]>>
    reply(input: { directory: string; requestID: string; answers?: string[][]; answer?: Record<string, string | number | boolean | readonly string[]> }, options?: unknown): Promise<unknown>
    reject(input: { directory: string; requestID: string }, options?: unknown): Promise<unknown>
  }
  subscribe(handlers: { open(): void; error(error?: unknown): void; event(event: KernelEvent): void }): KernelSubscription
  dispose(): void
}

const result = <T>(data: T): KernelResult<T> => ({ data })

export function createKernelClient(connection: KernelConnection, directory: string): KernelClient {
  const lifetime = new AbortController()
  const subscriptions = new Set<KernelSubscription>()
  // Request cancellation is connection/directory scoped; only reads have a bounded request deadline.
  const requestFetch: typeof fetch = (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const accept = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('accept')
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const signals = [lifetime.signal, ...(signal ? [signal] : [])]
    if (method === 'GET' && accept !== 'text/event-stream') signals.push(AbortSignal.timeout(15000))
    return fetch(input, { ...init, signal: AbortSignal.any(signals) })
  }
  const dispose = () => { lifetime.abort(); subscriptions.forEach(s => s.close()); subscriptions.clear() }
  if (connection.protocol === 'v1') {
    const sdk = legacyClient({ baseUrl: connection.url, directory, throwOnError: true, fetch: requestFetch })
    const interactions = legacyInteractions({ baseUrl: connection.url, directory, throwOnError: true, fetch: requestFetch })
    return {
      session: sdk.session as unknown as KernelClient['session'], config: sdk.config as unknown as KernelClient['config'],
      app: sdk.app as unknown as KernelClient['app'], command: sdk.command as unknown as KernelClient['command'],
      permission: interactions.permission as unknown as KernelClient['permission'], question: interactions.question as unknown as KernelClient['question'], dispose,
      subscribe(handlers) {
        const url = new URL(`${connection.url}/event`)
        url.searchParams.set('directory', directory)
        const source = new EventSource(url.href)
        const subscription = { close: () => { source.close(); subscriptions.delete(subscription) } }
        subscriptions.add(subscription)
        source.onopen = () => handlers.open()
        source.onerror = () => handlers.error()
        source.onmessage = event => {
          let raw: any
          try { raw = JSON.parse(event.data) } catch { return }
          if (raw.directory && !sameWorkspace(raw.directory, directory)) return
          const payload = raw.payload ?? raw
          if (payload.properties?.info?.directory && !sameWorkspace(payload.properties.info.directory, directory)) return
          handlers.event(payload)
        }
        return subscription
      }
    }
  }

  const headers = { ...connection.headers, 'x-opencode-directory': encodeURIComponent(directory) }
  const sdk = OpenCode.make({ baseUrl: connection.url, headers, fetch: requestFetch })
  const projection = new V2Projection(directory)
  const location = { directory }
  const permissions = new Map<string, PermissionRequest>()
  const questions = new Map<string, QuestionRequest>()
  const skills = new Map<string, string>()
  const emitters = new Set<(event: KernelEvent) => void>()
  const emit = (event: KernelEvent) => emitters.forEach(fn => fn(event))
  const id = (input?: KernelInput) => {
    if (!input?.path?.id) throw new Error('缺少会话 ID')
    return input.path.id
  }
  const ownSession = async (sessionID: string) => {
    if (!projection.owned.has(sessionID)) {
      const session = await sdk.session.get({ sessionID })
      if (!sameWorkspace(session.location.directory, directory)) throw new Error('会话不属于当前工作空间')
      projection.session(session)
    }
    return sessionID
  }
  const scope = async (input?: KernelInput) => ownSession(id(input))
  async function pages<T>(load: (cursor?: string) => Promise<{ data: T[]; cursor: { next?: string | null } }>): Promise<T[]> {
    const items: T[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const response = await load(cursor)
      items.push(...response.data)
      cursor = response.cursor.next ?? undefined
      if (cursor && seen.has(cursor)) throw new Error('内核返回了重复的分页游标')
      if (cursor) seen.add(cursor)
    } while (cursor && !lifetime.signal.aborted)
    return items
  }
  const select = async (sessionID: string, body: any) => {
    if (body?.agent) await sdk.session.switchAgent({ sessionID, agent: body.agent })
    if (body?.model) await sdk.session.switchModel({ sessionID, model: { id: body.model.modelID, providerID: body.model.providerID, ...(body.variant ? { variant: body.variant } : {}) } })
    else if (body?.variant) {
      const session = await sdk.session.get({ sessionID })
      if (session.model) await sdk.session.switchModel({ sessionID, model: { ...session.model, variant: body.variant } })
    }
  }
  const client: KernelClient = {
    dispose,
    session: {
      list: async () => result((await pages(cursor => sdk.session.list({ directory, order: 'desc', limit: 100, cursor }))).map(s => projection.session(s)).filter(s => sameWorkspace(s.directory, directory))),
      create: async input => result(projection.session(await sdk.session.create({ location, title: input?.body?.title }))),
      get: async input => result(projection.session(await sdk.session.get({ sessionID: await scope(input) }))),
      delete: async input => {
        try { await sdk.session.remove({ sessionID: await scope(input) }) }
        catch (error) { if (!(error instanceof Error) || !/UnexpectedStatus: 404\b/.test(error.message)) throw error }
        return result(true)
      },
      messages: async input => {
        const sessionID = await scope(input)
        const messages = await pages(cursor => sdk.message.list({ sessionID, order: 'asc', limit: 100, cursor }))
        return result(projection.history(sessionID, messages))
      },
      status: async () => {
        const active = await sdk.session.active()
        const statuses: Record<string, { type: string }> = {}
        for (const sessionID of Object.keys(active)) {
          try { await ownSession(sessionID); statuses[sessionID] = { type: 'busy' } } catch (error) {
            if (error instanceof Error && error.message === '会话不属于当前工作空间') continue
            throw error
          }
        }
        return result(statuses)
      },
      promptAsync: async input => {
        const sessionID = await scope(input)
        const body = input?.body ?? {}
        await select(sessionID, body)
        const item = await sdk.session.prompt({ sessionID, text: (body.parts ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n'),
          files: (body.parts ?? []).filter((p: any) => p.type === 'file').map((p: any) => ({ uri: p.url, name: p.filename })) })
        // The input is durably admitted before this response. Echo by its real ID; SSE uses the same ID.
        const message = projection.message(sessionID, { id: item.id, type: 'user', ...item.payload, time: item.time })!
        emit({ type: 'message.updated', properties: { info: message.info } })
        message.parts.forEach(part => emit({ type: 'message.part.updated', properties: { part } }))
        return result(undefined)
      },
      command: async input => {
        const sessionID = await scope(input)
        const body = input?.body ?? {}
        await select(sessionID, body)
        const skill = skills.get(body.command)
        if (skill) {
          await sdk.session.skill({ sessionID, id: skill, resume: !body.arguments })
          if (body.arguments) await sdk.session.prompt({ sessionID, text: body.arguments })
        }
        else await sdk.session.command({ sessionID, name: body.command, text: body.arguments ?? '' })
        return result(undefined)
      },
      abort: async input => { await sdk.session.interrupt({ sessionID: await scope(input), resume: false }); return result(undefined) },
      summarize: async input => { await sdk.session.compact({ sessionID: await scope(input) }); return result(undefined) },
      revert: async input => { const revert = await sdk.session.revert.stage({ sessionID: await scope(input), messageID: input?.body?.messageID }); return result({ revert }) },
      unrevert: async input => { await sdk.session.revert.clear({ sessionID: await scope(input) }); return result(undefined) }
    },
    config: {
      providers: async () => {
        const [models, providers] = await Promise.all([sdk.model.list({ location }), sdk.provider.list({ location })])
        const groups = new Map<string, any>()
        for (const p of providers.data) groups.set(p.id, { id: p.id, name: p.name, models: {} })
        for (const m of models.data) {
          if (!m.enabled) continue
          if (!groups.has(m.providerID)) groups.set(m.providerID, { id: m.providerID, name: m.providerID, models: {} })
          groups.get(m.providerID).models[m.id] = { ...m, variants: Object.fromEntries(m.variants.map(v => [v.id, {}])) }
        }
        return result({ providers: [...groups.values()] })
      },
      get: async () => {
        const response = await sdk.model.default({ location })
        return result({ model: response.data ? `${response.data.providerID}/${response.data.id}` : undefined })
      }
    },
    app: { agents: async () => result((await sdk.agent.list({ location })).data.filter(a => !a.hidden).map(a => ({ ...a, name: a.id }))) },
    command: { list: async () => {
      const [commands, available] = await Promise.all([sdk.command.list({ location }), sdk.skill.list({ location })])
      skills.clear()
      const names = new Set(commands.data.map(c => c.name))
      const extra = available.data.filter(s => !names.has(s.name)).map(s => { skills.set(s.name, s.id); return { name: s.name, description: s.description } })
      return result([...commands.data, ...extra])
    } },
    permission: {
      list: async () => {
        const response = await sdk.permission.request.list({ location })
        permissions.clear()
        const list = response.data.map(permissionV2)
        list.forEach(p => permissions.set(p.id, p))
        return result(list)
      },
      reply: async input => {
        const p = permissions.get(input.requestID)
        if (!p) throw new Error('授权请求已过期，请重新读取')
        await ownSession(p.sessionID)
        await sdk.permission.reply({ sessionID: p.sessionID, requestID: p.id, decision: input.reply })
        permissions.delete(p.id)
      }
    },
    question: {
      list: async () => {
        const response = await sdk.form.list({ location })
        questions.clear()
        const list = response.data.map(questionV2)
        list.forEach(q => questions.set(q.id, q))
        return result(list)
      },
      reply: async input => {
        const q = questions.get(input.requestID)
        if (!q) throw new Error('表单已过期，请重新读取')
        await ownSession(q.sessionID)
        await sdk.session.form.reply({ sessionID: q.sessionID, formID: q.id, answer: input.answer ?? {} })
        questions.delete(q.id)
      },
      reject: async input => {
        const q = questions.get(input.requestID)
        if (!q) throw new Error('表单已过期，请重新读取')
        await ownSession(q.sessionID)
        await sdk.session.form.cancel({ sessionID: q.sessionID, formID: q.id })
        questions.delete(q.id)
      }
    },
    subscribe(handlers) {
      const abort = new AbortController()
      const signal = AbortSignal.any([abort.signal, lifetime.signal])
      let retry = 0
      const subscription = { close: () => { abort.abort(); subscriptions.delete(subscription); emitters.delete(handlers.event) } }
      subscriptions.add(subscription)
      emitters.add(handlers.event)
      void (async () => {
        while (!signal.aborted) {
          try {
            for await (const raw of sdk.event.subscribe({ signal })) {
              if (signal.aborted) break
              if (raw.type === 'server.connected') { retry = 0; handlers.open(); continue }
              for (const event of projection.events(raw)) {
                if (event.type === 'permission.asked') permissions.set(event.properties.id, event.properties)
                if (event.type === 'question.asked') questions.set(event.properties.id, event.properties)
                handlers.event(event)
              }
            }
            if (!signal.aborted) throw new Error('内核事件连接已关闭')
          } catch (error) { if (signal.aborted) break; handlers.error(error) }
          const ms = [1000, 2000, 4000, 8000, 10000][Math.min(retry++, 4)]
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
            const timer = setTimeout(done, ms)
            signal.addEventListener('abort', done, { once: true })
          })
        }
      })()
      return subscription
    }
  }
  return client
}
