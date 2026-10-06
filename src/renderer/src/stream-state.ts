export interface MessageEntry {
  info: any
  parts: any[]
}

export type MessageEventType = 'message.updated' | 'message.part.updated' | 'message.part.delta' | 'message.part.removed' | 'message.removed'
export interface MessageEvent {
  type: MessageEventType
  properties: any
}

export function reduceMessageEvents(previous: MessageEntry[], events: MessageEvent[]): MessageEntry[] {
  if (!events.length) return previous
  const next = previous.slice()
  const index = new Map(next.map((message, i) => [message.info?.id, i]))
  const changed = new Set<string>()

  function message(id: string): MessageEntry {
    let i = index.get(id)
    if (i === undefined) {
      i = next.length
      index.set(id, i)
      next.push({ info: { id, role: 'assistant' }, parts: [] })
      changed.add(id)
    } else if (!changed.has(id)) {
      next[i] = { ...next[i], parts: next[i].parts.slice() }
      changed.add(id)
    }
    return next[i]
  }

  // Apply snapshots and deltas in the same SSE order. A snapshot replaces the
  // preceding deltas; only deltas AFTER that snapshot may be appended to it.
  for (const { type, properties: p } of events) {
    if (type === 'message.updated' && p.info?.id) {
      const entry = message(p.info.id)
      entry.info = { ...entry.info, ...p.info }
    } else if (type === 'message.part.updated' && p.part?.id && p.part.messageID) {
      const entry = message(p.part.messageID)
      const i = entry.parts.findIndex(part => part.id === p.part.id)
      if (i === -1) entry.parts.push(p.part)
      else entry.parts[i] = p.part
    } else if (type === 'message.part.delta' && p.messageID && p.partID && typeof p.field === 'string' && typeof p.delta === 'string') {
      const entry = message(p.messageID)
      const i = entry.parts.findIndex(part => part.id === p.partID)
      if (i === -1) {
        entry.parts.push({ id: p.partID, messageID: p.messageID, sessionID: p.sessionID, type: p.field === 'text' ? 'text' : p.field, [p.field]: p.delta })
      } else {
        const part = entry.parts[i]
        entry.parts[i] = { ...part, [p.field]: (part[p.field] ?? '') + p.delta }
      }
    } else if (type === 'message.part.removed' && index.has(p.messageID)) {
      const entry = message(p.messageID)
      entry.parts = entry.parts.filter(part => part.id !== p.partID)
    } else if (type === 'message.removed' && index.has(p.messageID)) {
      const i = index.get(p.messageID)!
      next.splice(i, 1)
      index.clear()
      next.forEach((entry, j) => index.set(entry.info?.id, j))
      changed.delete(p.messageID)
    }
  }
  return next
}
