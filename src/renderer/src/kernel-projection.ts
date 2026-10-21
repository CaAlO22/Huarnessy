import type { FormInfo } from '@opencode/client'
import type { MessageEntry } from './stream-state'
import { sameWorkspace } from './workspace-path'

export interface KernelEvent { type: string; properties: any; directory?: string }
export interface PermissionRequest { id: string; sessionID: string; permission: string; patterns: string[]; always: string[]; metadata: Record<string, unknown> }
export interface QuestionRequest {
  id: string; sessionID: string
  questions: { header: string; question: string; options: { label: string; description: string }[]; multiple?: boolean; custom?: boolean }[]
  form?: FormInfo
}
export function permissionV2(p: any): PermissionRequest {
  return { id: p.id, sessionID: p.sessionID, permission: p.action, patterns: p.resources ?? [], always: p.save ?? [], metadata: p.metadata ?? {} }
}
export function questionV2(form: FormInfo): QuestionRequest { return { id: form.id, sessionID: form.sessionID, questions: [], form } }
export const partID = (messageID: string, ordinal: number) => `${messageID}:content:${ordinal}`
const stamp = (value: any): number | undefined => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : undefined
function timeV2(time: any) { return Object.fromEntries(Object.entries(time ?? {}).map(([key, value]) => [key, stamp(value)])) }
function usageV2(tokens: any) {
  if (!tokens) return undefined
  return { ...tokens, input: tokens.input?.total ?? tokens.input, output: tokens.output?.total ?? tokens.output, reasoning: tokens.reasoning ?? tokens.output?.reasoning, cache: tokens.cache ?? { read: tokens.input?.cache?.read ?? 0, write: tokens.input?.cache?.write ?? 0 } }
}
function toolPart(messageID: string, sessionID: string, c: any) {
  const state = c.state ?? {}
  return { id: `${messageID}:tool:${c.id}`, messageID, sessionID, type: 'tool', callID: c.id, tool: c.name,
    state: { ...state, status: state.status === 'streaming' ? 'pending' : state.status, raw: typeof state.input === 'string' ? state.input : undefined,
      output: state.content?.filter((x: any) => x.type === 'text').map((x: any) => x.text).join('\n'),
      error: state.error?.message ?? state.error?.data?.message, time: timeV2(c.time), title: state.metadata?.title } }
}

/** One projection per directory/connection. Stable IDs must agree between REST history and live events. */
export class V2Projection {
  revision = 0
  readonly owned = new Set<string>()
  private users = new Map<string, string>()
  private messages = new Map<string, MessageEntry>()
  private tools = new Map<string, any>()
  private compactions = new Map<string, string>()
  constructor(readonly directory: string) {}

  session(s: any): any {
    const directory = s.location?.directory
    if (directory && sameWorkspace(directory, this.directory)) this.owned.add(s.id)
    return { ...s, directory, time: timeV2(s.time) }
  }
  history(sessionID: string, items: any[], remember = true): MessageEntry[] {
    let parent: string | undefined
    return items.flatMap(item => {
      if (item.type === 'user') parent = item.id
      const message = this.message(sessionID, item, parent, remember)
      return message ? [message] : []
    })
  }
  message(sessionID: string, item: any, parent?: string, remember = true): MessageEntry | null {
    const time = timeV2(item.time)
    let result: MessageEntry
    if (item.type === 'user') {
      if (remember) this.users.set(sessionID, item.id)
      result = { info: { id: item.id, sessionID, role: 'user', time }, parts: [
        { id: partID(item.id, 0), messageID: item.id, sessionID, type: 'text', text: item.text ?? '' },
        ...(item.files ?? []).map((f: any, i: number) => ({ id: partID(item.id, i + 1), messageID: item.id, sessionID, type: 'file', url: f.uri, filename: f.name }))
      ] }
    } else if (item.type === 'assistant') {
      result = { info: { ...item, role: 'assistant', sessionID, parentID: parent ?? this.users.get(sessionID), time,
        providerID: item.model?.providerID, modelID: item.model?.id, tokens: usageV2(item.tokens) },
        parts: (item.content ?? []).map((c: any, ordinal: number) => {
          if (c.type !== 'tool') return { ...c, id: partID(item.id, ordinal), messageID: item.id, sessionID }
          if (remember && !c.time?.completed) this.tools.set(`${item.id}:tool:${c.id}`, { ...c, state: { ...c.state }, time: { ...c.time } })
          return toolPart(item.id, sessionID, c)
        }) }
    } else if (item.type === 'compaction') {
      result = { info: { id: item.id, sessionID, role: 'assistant', summary: true, time: { ...time, ...(item.status !== 'running' ? { completed: time.created } : {}) }, tokens: usageV2(item.tokens), modelID: item.model?.id },
        parts: [{ id: partID(item.id, 0), messageID: item.id, sessionID, type: 'text', text: item.summary ?? '' }] }
    } else if (['synthetic', 'system', 'skill', 'shell'].includes(item.type)) {
      result = { info: { id: item.id, sessionID, role: 'assistant', synthetic: true, time }, parts: [{ id: partID(item.id, 0), messageID: item.id, sessionID, type: 'text', text: item.text ?? item.output?.text ?? item.description ?? '' }] }
    } else return null
    if (remember) this.messages.set(item.id, result)
    // A long-lived connection must not retain unbounded transcripts from every opened session.
    if (this.messages.size > 2048) this.messages.delete(this.messages.keys().next().value!)
    return result
  }

  events(event: any): KernelEvent[] {
    const p = event.data ?? {}
    const sessionID = p.sessionID ?? p.form?.sessionID
    const directory = event.location?.directory ?? (event.type === 'session.created' ? p.location?.directory : undefined)
    if (directory ? !sameWorkspace(directory, this.directory) : !sessionID || !this.owned.has(sessionID)) return []
    this.revision++
    if (sessionID) this.owned.add(sessionID)
    const out: KernelEvent[] = []
    const emit = (type: string, properties: any) => out.push({ type, properties, directory: this.directory })
    const messageID = p.assistantMessageID ?? p.messageID
    const at = stamp(event.created) ?? Date.now()
    const snapshot = (message: MessageEntry) => {
      emit('message.updated', { info: message.info })
      message.parts.forEach(part => emit('message.part.updated', { part }))
    }
    const meta = (extra: any = {}) => {
      const old = this.messages.get(messageID)
      const info = { ...(old?.info ?? { id: messageID, sessionID, role: 'assistant', parentID: this.users.get(sessionID), time: { created: at } }), ...extra }
      this.messages.set(messageID, { info, parts: old?.parts ?? [] })
      if (this.messages.size > 2048) this.messages.delete(this.messages.keys().next().value!)
      emit('message.updated', { info })
    }
    if (event.type === 'session.inbox.enqueued' && p.item?.type === 'user') {
      snapshot(this.message(sessionID, { id: p.inboxID, type: 'user', ...p.item.payload, time: { created: at } })!)
    } else if (event.type === 'session.step.started') {
      meta({ agent: p.agent, providerID: p.model?.providerID, modelID: p.model?.id, time: { created: p.started ?? at } })
      emit('session.status', { sessionID, status: { type: 'busy' } })
    } else if (/^session\.(text|reasoning)\.(started|delta|ended)$/.test(event.type)) {
      const [, kind, phase] = event.type.split('.')
      const id = partID(messageID, p.ordinal)
      if (phase === 'delta') emit('message.part.delta', { sessionID, messageID, partID: id, field: 'text', delta: p.delta })
      else emit('message.part.updated', { part: { id, messageID, sessionID, type: kind, text: phase === 'ended' ? p.text : '' } })
    } else if (event.type.startsWith('session.tool.')) {
      const key = `${messageID}:tool:${p.id}`
      const tool = this.tools.get(key) ?? { id: p.id, name: p.name, state: {}, time: { created: at } }
      if (p.name) tool.name = p.name
      if (event.type === 'session.tool.input.started') tool.state = { status: 'streaming', input: '' }
      if (event.type === 'session.tool.input.delta') tool.state.input = String(tool.state.input ?? '') + p.delta
      if (event.type === 'session.tool.input.ended') tool.state.input = p.text
      if (event.type === 'session.tool.called') { tool.state = { status: 'running', input: p.input, metadata: {} }; tool.time.ran = at }
      if (event.type === 'session.tool.progress') tool.state.metadata = p.metadata
      if (event.type === 'session.tool.success' || event.type === 'session.tool.failed') {
        tool.state = { ...tool.state, status: p.error ? 'error' : 'completed', content: p.content, metadata: p.metadata, error: p.error }
        tool.time.completed = at
      }
      this.tools.set(key, tool)
      emit('message.part.updated', { part: toolPart(messageID, sessionID, tool) })
      if (tool.time.completed) this.tools.delete(key)
    } else if (event.type === 'session.step.ended' || event.type === 'session.step.failed') {
      const old = this.messages.get(messageID)?.info
      meta({ tokens: usageV2(p.tokens), cost: p.cost, finish: p.finish, error: p.error, time: { ...old?.time, completed: at } })
    } else if (event.type === 'session.retry.scheduled') {
      emit('session.status', { sessionID, status: { type: 'retry', attempt: p.attempt, next: p.at, message: p.error?.message ?? p.error?.data?.message ?? '模型请求失败' } })
    } else if (event.type.startsWith('session.compaction.')) {
      let id = this.compactions.get(sessionID)
      if (event.type === 'session.compaction.started' || !id) { id = p.inputID ?? `compaction:${event.id}`; this.compactions.set(sessionID, id!) }
      if (event.type === 'session.compaction.started') snapshot(this.message(sessionID, { id, type: 'compaction', status: 'running', summary: '', time: { created: at } })!)
      if (event.type === 'session.compaction.delta') emit('message.part.delta', { sessionID, messageID: id, partID: partID(id!, 0), field: 'text', delta: p.text })
      if (event.type === 'session.compaction.ended') snapshot(this.message(sessionID, { id, type: 'compaction', status: 'completed', summary: p.text, tokens: p.tokens, model: p.model, time: { created: at } })!)
      if (event.type === 'session.compaction.failed') emit('session.error', { sessionID, error: p.error })
    } else if (event.type === 'permission.asked') emit(event.type, permissionV2(p))
    else if (event.type === 'permission.replied') emit(event.type, p)
    else if (event.type === 'form.created') emit('question.asked', questionV2(p.form))
    else if (event.type === 'form.replied' || event.type === 'form.cancelled') emit(event.type === 'form.replied' ? 'question.replied' : 'question.rejected', { sessionID, requestID: p.id })
    else if (event.type === 'session.execution.failed') emit('session.error', { sessionID, error: p.error })
    else if (event.type === 'session.execution.succeeded' || event.type === 'session.execution.interrupted') emit('session.idle', { sessionID })
    else if (event.type === 'session.execution.started') emit('session.status', { sessionID, status: { type: 'busy' } })
    else if (event.type === 'session.status' || event.type === 'session.idle') emit(event.type, p)
    else if (event.type === 'session.deleted') { this.owned.delete(sessionID); emit(event.type, { info: { id: sessionID } }) }
    else if (event.type === 'session.created') emit(event.type, { info: { id: sessionID, directory: this.directory } })
    else if (['session.renamed', 'session.revert.staged', 'session.revert.cleared', 'session.revert.committed', 'session.moved'].includes(event.type)) emit('session.updated', { info: { id: sessionID, directory: this.directory } })
    else if (event.type === 'location.shutdown') emit('connection.reconcile', {})
    return out
  }
}
