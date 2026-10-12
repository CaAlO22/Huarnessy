import type { MessageEntry } from './stream-state'

interface Observation {
  scope: string
  session: string
  message: string
  request: number
  first: number | null
  last: number | null
  output: boolean
  reasoning: boolean
  complete: boolean
  valid: boolean
}
interface Request { start: number; user: string | null; previous: string | null }
const scopeKey = (path: string): string => {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  return /^(?:[a-z]:|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized
}
const key = (...parts: string[]): string => JSON.stringify(parts)
const storageKey = 'hui.stream-observations.v1'

// Receipt times are measured before rAF batching/rendering. Only live, locally
// initiated requests qualify; historical REST snapshots never create timings.
export class StreamObservations {
  private requests = new Map<string, Request>()
  private records = new Map<string, Observation>()
  private parts = new Map<string, { kind: string; length: number; observed: boolean }>()
  private roles = new Map<string, string>()
  constructor(private storage?: Pick<Storage, 'getItem' | 'setItem'>, private clock = () => performance.now()) {
    try {
      const saved: unknown = JSON.parse(storage?.getItem(storageKey) ?? '[]')
      if (Array.isArray(saved)) for (const value of saved.slice(-256)) {
        if (typeof value?.scope !== 'string' || typeof value?.session !== 'string' || typeof value?.message !== 'string'
          || !Number.isFinite(value.request) || !Number.isFinite(value.first) || !Number.isFinite(value.last)
          || value.first < value.request || value.last < value.first || value.complete !== true
          || typeof value.output !== 'boolean' || typeof value.reasoning !== 'boolean' || value.valid !== true) continue
        this.records.set(key(value.scope, value.session, value.message), value)
      }
    } catch { /* Unavailable or invalid storage must not affect streaming. */ }
  }
  begin(directory: string, session: string, previous: string | null): void {
    this.requests.set(key(scopeKey(directory), session), { start: this.clock(), user: null, previous })
  }
  finish(directory: string, session: string): void { this.requests.delete(key(scopeKey(directory), session)) }
  disconnect(): void {
    // An interrupted SSE interval cannot prove an output speed. Keep completed
    // observations, and discard request/part state on workspace/connection change.
    for (const record of this.records.values()) if (!record.complete) record.valid = false
    this.requests.clear(); this.parts.clear(); this.roles.clear()
  }
  private save(): void {
    try { this.storage?.setItem(storageKey, JSON.stringify([...this.records.values()].filter(record => record.complete && record.valid).slice(-256))) } catch { /* Best effort. */ }
  }
  receive(directory: string, type: string, p: any): void {
    const scope = scopeKey(directory)
    const session = type === 'session.deleted' ? p.info?.id : p.info?.sessionID ?? p.part?.sessionID ?? p.sessionID
    if (typeof session !== 'string') return
    const id = p.info?.id ?? p.part?.messageID ?? p.messageID
    const requestKey = key(scope, session)
    if (type === 'session.idle' || type === 'session.error' || type === 'session.deleted') {
      this.requests.delete(requestKey)
      if (type === 'session.deleted') {
        for (const [recordKey, record] of this.records) if (record.scope === scope && record.session === session) this.records.delete(recordKey)
        this.save()
      }
      return
    }
    if (typeof id !== 'string') return
    const recordKey = key(scope, session, id)
    const request = this.requests.get(requestKey)
    if (type === 'message.removed') { this.records.delete(recordKey); this.save(); return }
    if (type === 'message.part.removed') {
      const record = this.records.get(recordKey)
      if (record) record.valid = false
      this.parts.delete(key(scope, session, id, p.partID)); this.save(); return
    }
    if (type === 'message.updated') {
      this.roles.set(recordKey, p.info?.role)
      if (this.roles.size > 4096) this.roles.delete(this.roles.keys().next().value!)
      if (p.info?.role === 'user') {
        this.records.delete(recordKey)
        if (request && id !== request.previous && !request.user) request.user = id
        return
      }
      if (p.info?.role !== 'assistant' || p.info?.summary) { this.roles.set(recordKey, 'ignored'); return }
      if (this.records.get(recordKey)?.complete) return
      if (request && p.info.parentID) {
        if (p.info.parentID === request.previous || (request.user && p.info.parentID !== request.user)) {
          this.roles.set(recordKey, 'ignored'); this.records.delete(recordKey); return
        }
        request.user ??= p.info.parentID
      }
      const record = this.records.get(recordKey)
      if (record && p.info?.time?.completed != null && !record.complete) { record.complete = true; this.save() }
      else if (!record && p.info?.time?.completed != null) this.roles.set(recordKey, 'ignored')
      return
    }
    if (!request || ['user', 'ignored'].includes(this.roles.get(recordKey) ?? '')) return
    let record = this.records.get(recordKey)
    if (record?.complete) return
    const part = p.part
    const partKey = key(scope, session, id, part?.id ?? p.partID)
    const previous = this.parts.get(partKey)
    let kind: string
    let length: number
    if (type === 'message.part.updated') {
      kind = part?.type
      if (part?.synthetic || part?.ignored) { this.parts.set(partKey, { kind: 'ignored', length: 0, observed: false }); return }
      if (kind === 'tool' && part?.state?.status === 'pending') {
        kind = 'text'; length = typeof part.state.raw === 'string' ? part.state.raw.length : 0
      } else if (kind === 'text' || kind === 'reasoning') length = typeof part.text === 'string' ? part.text.length : 0
      else return
    } else if (type === 'message.part.delta' && p.field === 'text' && typeof p.delta === 'string') {
      if (previous?.kind === 'ignored') return
      kind = previous?.kind ?? 'unknown'; length = (previous?.length ?? 0) + p.delta.length
    } else return
    this.parts.set(partKey, { kind, length, observed: previous?.observed === true || length > (previous?.length ?? 0) })
    if (this.parts.size > 4096) this.parts.delete(this.parts.keys().next().value!)
    if (previous && length < previous.length && record) record.valid = false
    // A delta may precede its typed part snapshot; classify that already
    // observed output without treating the identical snapshot as new output.
    if (record && previous?.observed) {
      if (kind === 'reasoning') record.reasoning = true
      if (kind === 'text') record.output = true
    }
    if (length <= (previous?.length ?? 0)) return
    const now = this.clock()
    if (!record) {
      record = { scope, session, message: id, request: request.start, first: null, last: null, output: false, reasoning: false, complete: false, valid: true }
      this.records.set(recordKey, record)
    }
    record.first ??= now
    record.last = now
    if (kind === 'reasoning') record.reasoning = true
    else if (kind === 'text') record.output = true
    // Bound bookkeeping even during exceptionally long sessions.
    if (this.records.size > 1024) this.records.delete(this.records.keys().next().value!)
  }
  metrics(directory: string, session: string, replies: MessageEntry[]): { firstTokenSeconds: number | null; speed: number | null } {
    const scope = scopeKey(directory)
    let latency = Infinity
    let tokens = 0
    let duration = 0
    let validSpeed = true
    for (const { info } of replies) {
      if (info?.role !== 'assistant') continue
      const record = this.records.get(key(scope, session, info.id))
      if (record?.valid && record.first !== null) latency = Math.min(latency, record.first - record.request)
      const output = info.tokens?.output
      const reasoning = info.tokens?.reasoning
      if (!Number.isFinite(output) || !Number.isFinite(reasoning) || output < 0 || reasoning < 0) { validSpeed = false; continue }
      if (output + reasoning === 0) continue
      if (!record?.valid || !record.complete || record.first === null || record.last === null || record.last <= record.first
        || (output > 0 && !record.output) || (reasoning > 0 && !record.reasoning)) { validSpeed = false; continue }
      tokens += output + reasoning
      duration += record.last - record.first
    }
    return { firstTokenSeconds: Number.isFinite(latency) ? latency / 1000 : null, speed: validSpeed && duration > 0 && tokens > 0 ? tokens / (duration / 1000) : null }
  }
}
