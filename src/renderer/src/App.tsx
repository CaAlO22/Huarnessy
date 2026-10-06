import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createOpencodeClient } from '@opencode-ai/sdk/client'
import { StreamingMarkdown } from './StreamingMarkdown'
import { SessionContextMenu, type SessionMenuTarget } from './SessionContextMenu'
import { sameWorkspace } from './workspace-path'
import { ReplyPresentation, hasVisiblePart } from './ReplyPresentation'
import { reduceMessageEvents, type MessageEntry, type MessageEvent, type MessageEventType } from './stream-state'

interface ServerInfo {
  status: 'starting' | 'ready' | 'error' | 'stopped'
  url?: string
  port?: number
  error?: string
  version?: string
  binary?: string
}

interface ModelOption {
  providerID: string
  providerName: string
  modelID: string
  modelName: string
}

interface SelectedModel {
  providerID: string
  modelID: string
}

const unwrap = (r: any): any => (r && r.data !== undefined ? r.data : r)

const toolColors: Record<string, string> = {
  read: 'read',
  write: 'write',
  edit: 'write',
  apply_patch: 'write',
  glob: 'glob',
  grep: 'search',
  bash: 'shell',
  task: 'task',
  todowrite: 'task',
  webfetch: 'web',
  websearch: 'web'
}

const PartView = memo(function PartView({ part, completed, textLimit }: { part: any; completed: boolean; textLimit?: number }): React.ReactElement | null {
  const done = completed || part.time?.end != null
  let text: string = part.text ?? ''
  if (textLimit !== undefined && textLimit < text.length) {
    let end = Math.max(0, textLimit)
    // Do not split a surrogate pair while revealing a received chunk.
    if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--
    text = text.slice(0, end)
  }
  if (part.type === 'text') {
    if (!text) return null
    return <StreamingMarkdown text={text} done={done} />
  }

  if (part.type === 'reasoning') {
    if (!text) return null
    return (
      <div className="hui-reasoning">
        <StreamingMarkdown text={text} done={done} />
      </div>
    )
  }

  if (part.type === 'tool') {
    const state = part.state ?? {}
    const toolName = String(part.tool ?? 'Tool')
    const toolColor = toolColors[toolName.toLowerCase()] ?? 'default'
    const displayName = toolName.charAt(0).toUpperCase() + toolName.slice(1)
    return (
      <details className="hui-tool-call" data-tool-color={toolColor}>
        <summary className="hui-tool-summary">
          <span className="hui-tool-name">{displayName}</span>
          <span className="hui-tool-status">
            {state.status ?? 'running'}
          </span>
          {state.title ? <span className="hui-tool-title" title={String(state.title)}>{state.title}</span> : null}
        </summary>
        {state.input ? (
          <pre className="hui-code mt-2 max-h-48 overflow-auto">{JSON.stringify(state.input, null, 2)}</pre>
        ) : null}
        {state.output ? (
          <pre className="hui-code mt-1 max-h-64 overflow-auto">{state.output}</pre>
        ) : null}
        {state.error ? (
          <pre className="mt-1 whitespace-pre-wrap text-rose-300">{String(state.error)}</pre>
        ) : null}
      </details>
    )
  }

  if (part.type === 'file') {
    return (
      <a
        href={part.url}
        target="_blank"
        rel="noreferrer"
        className="text-xs text-cyan-200/90 underline decoration-dotted"
      >
        {part.filename ?? part.url}
      </a>
    )
  }

  if (part.type === 'retry') {
    return <div className="text-[11px] text-amber-200/80">重试中…（第 {part.attempt} 次）</div>
  }

  return null
})

const MessageView = memo(function MessageView({ msg, inReply = false, visibleChars }: { msg: MessageEntry; inReply?: boolean; visibleChars?: number }): React.ReactElement | null {
  const isUser = msg.info?.role === 'user'
  const visibleParts = msg.parts.filter(hasVisiblePart)
  if (visibleParts.length === 0) return null
  let remaining = visibleChars
  const parts = msg.parts.map((p, i) => {
    const textPart = p.type === 'text' || p.type === 'reasoning'
    const limit = textPart ? remaining : undefined
    if (textPart && remaining !== undefined) remaining = Math.max(0, remaining - (p.text?.length ?? 0))
    return <PartView key={p.id ?? i} part={p} completed={isUser || msg.info?.time?.completed != null} textLimit={limit} />
  })
  if (inReply) return <div className="hui-message-parts flex min-w-0 flex-col gap-2" data-first-part={visibleParts[0].type} data-last-part={visibleParts[visibleParts.length - 1].type}>{parts}</div>
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`hui-message-parts flex min-w-0 max-w-[82%] flex-col gap-2 rounded-2xl px-4 py-3 ${
          isUser ? 'border border-white/15 bg-white/12' : 'glass hui-message'
        }`}
      >
        {parts}
      </div>
    </div>
  )
})

function Select({
  value,
  onChange,
  children,
  title,
  disabled
}: {
  value: string
  onChange: (v: string) => void
  children: React.ReactNode
  title?: string
  disabled?: boolean
}): React.ReactElement {
  return (
    <select
      value={value}
      title={title}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="no-drag max-w-[220px] cursor-pointer truncate rounded-lg border border-white/12 bg-white/8 px-2 py-1 text-[11.5px] text-white/80 outline-none transition hover:bg-white/14 focus:border-white/25 disabled:opacity-40 [&>optgroup]:bg-slate-900 [&>optgroup]:text-white/50 [&>option]:bg-slate-900 [&>option]:text-white"
    >
      {children}
    </select>
  )
}

export default function App(): React.ReactElement {
  const [server, setServer] = useState<ServerInfo | null>(null)
  const [workspace, setWorkspace] = useState<string | null>(null)
  const [choosingWorkspace, setChoosingWorkspace] = useState(false)
  const [sessions, setSessions] = useState<any[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageEntry[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const beforeRequestUserId = useRef<string | null>(null)
  const pendingTurnKey = useRef<string | null>(null)
  const turnKeySequence = useRef(0)
  const turnKeys = useRef(new Map<string, string>())
  const [lastError, setLastError] = useState<string | null>(null)
  const [sessionMenu, setSessionMenu] = useState<SessionMenuTarget | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const [models, setModels] = useState<ModelOption[]>([])
  const [selectedModel, setSelectedModel] = useState<SelectedModel | null>(null)
  const [agents, setAgents] = useState<any[]>([])
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)

  const clientRef = useRef<any>(null)
  const workspaceRef = useRef<string | null>(null)
  const choosingWorkspaceRef = useRef(false)
  const clientBase = useRef<string | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const stickBottom = useRef(true)
  const userScrolling = useRef(false)
  const deletedSessions = useRef(new Set<string>())
  const sessionListVersion = useRef(0)
  const deletingRef = useRef<{ client: any; id: string } | null>(null)
  const closeSessionMenu = useCallback(() => setSessionMenu(null), [])

  activeIdRef.current = activeId

  const modelGroups = useMemo(() => {
    const map = new Map<string, ModelOption[]>()
    for (const m of models) {
      if (!map.has(m.providerID)) map.set(m.providerID, [])
      map.get(m.providerID)!.push(m)
    }
    return Array.from(map.entries())
  }, [models])

  const loadSessions = useCallback(async () => {
    const c = clientRef.current
    const directory = workspaceRef.current
    if (!c || !directory) return
    const version = ++sessionListVersion.current
    try {
      const r = await c.session.list({ query: { directory }, throwOnError: true })
      if (c !== clientRef.current || version !== sessionListVersion.current) return
      setSessions((unwrap(r) ?? []).filter((session: any) => sameWorkspace(session.directory, directory)
        && !deletedSessions.current.has(session.id)))
    } catch (e) {
      console.error('list sessions failed', e)
    }
  }, [])

  const loadConfig = useCallback(async () => {
    const c = clientRef.current
    if (!c) return
    try {
      const [provRes, agentsRes, configRes] = await Promise.all([
        c.config.providers(),
        c.app.agents(),
        c.config.get()
      ])
      if (c !== clientRef.current) return

      const list: ModelOption[] = []
      const pdata = unwrap(provRes) ?? {}
      for (const p of pdata.providers ?? []) {
        for (const [mid, m] of Object.entries(p.models ?? {})) {
          list.push({
            providerID: p.id,
            providerName: p.name ?? p.id,
            modelID: mid,
            modelName: (m as any)?.name ?? mid
          })
        }
      }
      setModels(list)

      const primary = (unwrap(agentsRes) ?? []).filter(
        (a: any) => a.mode === 'primary' && !['compaction', 'summary', 'title'].includes(a.name)
      )
      setAgents(primary)

      let chosen: SelectedModel | null = null
      try {
        const saved = localStorage.getItem('hui.model')
        if (saved) chosen = JSON.parse(saved)
      } catch {
        chosen = null
      }
      const cfgModel = (unwrap(configRes)?.model as string) ?? null
      if (!chosen && cfgModel && cfgModel.includes('/')) {
        const [pid, ...rest] = cfgModel.split('/')
        chosen = { providerID: pid, modelID: rest.join('/') }
      }
      const valid = (m: SelectedModel | null): boolean =>
        !!m && list.some((x) => x.providerID === m!.providerID && x.modelID === m!.modelID)
      if (!valid(chosen) && list.length) {
        chosen = { providerID: list[0].providerID, modelID: list[0].modelID }
      }
      if (valid(chosen)) setSelectedModel(chosen)

      const savedAgent = localStorage.getItem('hui.agent')
      const defAgent =
        savedAgent && primary.some((a: any) => a.name === savedAgent)
          ? savedAgent
          : (primary.find((a: any) => a.name === 'build')?.name ?? primary[0]?.name ?? null)
      setSelectedAgent(defAgent)
    } catch (e) {
      console.error('load config failed', e)
    }
  }, [])

  // All message events share one ordered queue, including snapshots/removals.
  const pendingEvents = useRef<MessageEvent[]>([])
  const rafRef = useRef<number | null>(null)
  const revision = useRef(0)
  const sessionEpoch = useRef(0)
  const flushEvents = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    const batch = pendingEvents.current
    pendingEvents.current = []
    if (batch.length) setMessages(prev => reduceMessageEvents(prev, batch))
  }, [])
  const clearEvents = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    pendingEvents.current = []
    sessionEpoch.current++
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
  }, [])
  const enqueueEvent = useCallback((type: MessageEventType, properties: any) => {
    revision.current++
    pendingEvents.current.push({ type, properties })
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(flushEvents)
  }, [flushEvents])

  const refreshMessages = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    const epoch = sessionEpoch.current
    refreshTimer.current = setTimeout(async () => {
      const c = clientRef.current
      const id = activeIdRef.current
      const version = revision.current
      if (!c || !id) return
      try {
        const r = await c.session.messages({ path: { id } })
        // A delayed REST response must not replace a newer SSE update/session.
        if (epoch !== sessionEpoch.current || id !== activeIdRef.current || version !== revision.current) return
        flushEvents()
        setMessages(unwrap(r) ?? [])
      } catch (e) {
        console.error('load messages failed', e)
      }
    }, 60)
  }, [flushEvents])

  const openSession = useCallback(async (id: string) => {
    const c = clientRef.current
    if (!c || deletedSessions.current.has(id) || deletingRef.current?.id === id) return
    closeSessionMenu()
    clearEvents()
    turnKeys.current.clear()
    pendingTurnKey.current = null
    const epoch = sessionEpoch.current
    const version = revision.current
    setActiveId(id)
    activeIdRef.current = id
    setMessages([])
    try {
      const r = await c.session.messages({ path: { id } })
      if (epoch !== sessionEpoch.current || id !== activeIdRef.current) return
      flushEvents()
      const snapshot: MessageEntry[] = unwrap(r) ?? []
      setMessages(prev => {
        if (version === revision.current) return snapshot
        const live = new Map(prev.map(message => [message.info?.id, message]))
        return [...snapshot.map(message => live.get(message.info?.id) ?? message),
          ...prev.filter(message => !snapshot.some(old => old.info?.id === message.info?.id))]
      })
    } catch (e) {
      console.error('open session failed', e)
    }
  }, [clearEvents, flushEvents, closeSessionMenu])

  const forgetSession = useCallback((id: string) => {
    deletedSessions.current.add(id)
    setSessions(previous => previous.filter(session => session.id !== id))
    setSessionMenu(previous => previous?.id === id ? null : previous)
    if (activeIdRef.current === id) {
      clearEvents()
      turnKeys.current.clear()
      pendingTurnKey.current = null
      activeIdRef.current = null
      setActiveId(null)
      setMessages([])
      setBusy(false)
      setLastError(null)
      stickBottom.current = true
    }
  }, [clearEvents])

  const deleteSession = useCallback(async (id: string) => {
    const c = clientRef.current
    if (!c || deletingRef.current || deletedSessions.current.has(id)) return
    const operation = { client: c, id }
    deletingRef.current = operation
    setDeletingId(id)
    closeSessionMenu()
    setLastError(null)
    try {
      const result = await c.session.delete({ path: { id } })
      if (result.response?.status !== 404 && (result.error || unwrap(result) !== true)) {
        throw new Error(result.error?.data?.message ?? result.error?.message ?? '服务器未能删除会话')
      }
      if (c !== clientRef.current) return
      forgetSession(id)
      await loadSessions()
    } catch (error) {
      if (c === clientRef.current && !deletedSessions.current.has(id)) {
        const message = error instanceof Error ? error.message : String(error)
        setLastError(`删除会话失败：${message}`)
      }
    } finally {
      if (deletingRef.current === operation) {
        deletingRef.current = null
        setDeletingId(null)
      }
    }
  }, [closeSessionMenu, forgetSession, loadSessions])

  const resetWorkspaceView = useCallback(() => {
    // Invalidate the old client immediately, before React reconnects the next
    // workspace. Late requests and already-queued SSE handlers become inert.
    clientRef.current = null
    clientBase.current = null
    esRef.current?.close()
    esRef.current = null
    clearEvents()
    turnKeys.current.clear()
    pendingTurnKey.current = null
    closeSessionMenu()
    sessionListVersion.current++
    deletedSessions.current.clear()
    deletingRef.current = null
    activeIdRef.current = null
    setDeletingId(null)
    setActiveId(null)
    setSessions([])
    setMessages([])
    setModels([])
    setAgents([])
    setSelectedModel(null)
    setSelectedAgent(null)
    setBusy(false)
    setInput('')
    setLastError(null)
    stickBottom.current = true
  }, [clearEvents, closeSessionMenu])

  const chooseWorkspace = useCallback(async () => {
    if (choosingWorkspaceRef.current) return
    choosingWorkspaceRef.current = true
    setChoosingWorkspace(true)
    try {
      const next = await window.api.chooseWorkspacePath()
      if (!next || sameWorkspace(next, workspaceRef.current)) return
      resetWorkspaceView()
      workspaceRef.current = next
      setWorkspace(next)
    } catch (error) {
      setLastError(`切换工作空间失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      choosingWorkspaceRef.current = false
      setChoosingWorkspace(false)
    }
  }, [resetWorkspaceView])

  useEffect(() => {
    let alive = true
    window.api.getWorkspacePath().then(directory => {
      if (!alive) return
      workspaceRef.current = directory
      setWorkspace(directory)
    }).catch(error => {
      if (alive) setLastError(`读取工作空间失败：${String(error)}`)
    })
    return () => { alive = false }
  }, [])

  useEffect(() => {
    let unsub: (() => void) | undefined
    window.api.getServerInfo().then((info) => {
      setServer(info)
      unsub = window.api.onServerStatus((next) => setServer(next))
    })
    return () => unsub?.()
  }, [])

  useEffect(() => {
    if (server?.status !== 'ready' || !server.url || !workspace) return
    const url = server.url
    const context = `${url}\n${workspace}`
    if (clientBase.current === context) return
    resetWorkspaceView()
    clientBase.current = context

    const client = createOpencodeClient({ baseUrl: url, directory: workspace })
    clientRef.current = client
    loadSessions()
    loadConfig()

    const eventUrl = new URL(`${url}/event`)
    eventUrl.searchParams.set('directory', workspace)
    const es = new EventSource(eventUrl.href)
    esRef.current = es
    es.onmessage = (e) => {
      if (clientRef.current !== client) return
      let evt: any
      try {
        evt = JSON.parse(e.data)
      } catch {
        return
      }
      if (evt?.directory && !sameWorkspace(evt.directory, workspace)) return
      evt = evt?.payload ?? evt
      const t = evt?.type
      const p = evt?.properties ?? {}
      if (p.info?.directory && !sameWorkspace(p.info.directory, workspace)) return
      const active = activeIdRef.current

      switch (t) {
        case 'message.updated': {
          if (!active || (p.info?.sessionID && p.info.sessionID !== active)) return
          enqueueEvent('message.updated', p)
          break
        }
        case 'message.part.updated': {
          if (!active || (p.part?.sessionID && p.part.sessionID !== active)) return
          enqueueEvent('message.part.updated', p)
          break
        }
        case 'message.part.delta': {
          if (!active || (p.sessionID && p.sessionID !== active)) return
          enqueueEvent('message.part.delta', p)
          break
        }
        case 'message.part.removed': {
          if (!active || (p.sessionID && p.sessionID !== active)) return
          enqueueEvent('message.part.removed', p)
          break
        }
        case 'message.removed': {
          if (!active || (p.sessionID && p.sessionID !== active)) return
          enqueueEvent('message.removed', p)
          break
        }
        case 'session.idle': {
          if (active && p.sessionID === active) {
            flushEvents()
            setBusy(false)
            refreshMessages()
          }
          break
        }
        case 'session.error': {
          if (active && p.sessionID === active) {
            const message =
              p?.error?.data?.message ?? p?.error?.message ?? p?.error?.name ?? '未知错误'
            setLastError(String(message))
            setBusy(false)
          }
          break
        }
        case 'session.created':
        case 'session.updated':
          loadSessions()
          break
        case 'session.deleted':
          if (p.info?.id) forgetSession(p.info.id)
          loadSessions()
          break
      }
    }

    return () => {
      es.close()
      clearEvents()
      if (esRef.current === es) esRef.current = null
      clientBase.current = null
      if (clientRef.current === client) clientRef.current = null
    }
  }, [
    server?.status,
    server?.url,
    workspace,
    loadSessions,
    loadConfig,
    refreshMessages,
    enqueueEvent,
    clearEvents,
    flushEvents,
    closeSessionMenu,
    forgetSession,
    resetWorkspaceView
  ])

  useEffect(() => {
    const el = scrollRef.current
    const content = contentRef.current
    if (!el || !content) return
    const observer = new ResizeObserver(() => {
      // ResizeObserver runs after layout and before paint. Deferring again to
      // rAF paints one frame at the old scroll position, then visibly jumps.
      if (stickBottom.current) el.scrollTop = el.scrollHeight
    })
    // Worker formatting can change height even when the message text is unchanged.
    observer.observe(content)
    return () => {
      observer.disconnect()
    }
  }, [])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    // Height changes/programmatic scrolling also emit scroll events. They must
    // not disable following the reply before the ResizeObserver can catch up.
    if (atBottom || userScrolling.current) stickBottom.current = atBottom
    userScrolling.current = false
  }

  useEffect(() => {
    if (selectedModel) localStorage.setItem('hui.model', JSON.stringify(selectedModel))
  }, [selectedModel])

  useEffect(() => {
    if (selectedAgent) localStorage.setItem('hui.agent', selectedAgent)
  }, [selectedAgent])

  const newSession = async (): Promise<void> => {
    const c = clientRef.current
    if (!c) return
    try {
      const r = await c.session.create({ body: { title: 'New Session' }, throwOnError: true })
      if (c !== clientRef.current) return
      const s = unwrap(r)
      await loadSessions()
      if (c === clientRef.current && s?.id) openSession(s.id)
    } catch (error) {
      if (c === clientRef.current) setLastError(`新建会话失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const send = async (): Promise<void> => {
    const text = input.trim()
    const c = clientRef.current
    if (!text || !c || !server?.url || busy) return

    const body: any = { parts: [{ type: 'text', text }] }
    if (selectedModel) body.model = selectedModel
    if (selectedAgent) body.agent = selectedAgent

    beforeRequestUserId.current = [...messages].reverse().find((message) => message.info?.role === 'user')?.info?.id ?? null
    pendingTurnKey.current = `reply-request-${++turnKeySequence.current}`
    setBusy(true)
    setLastError(null)
    stickBottom.current = true

    try {
      let id = activeIdRef.current
      if (!id) {
        const r = await c.session.create({ body: { title: text.slice(0, 48) }, throwOnError: true })
        if (c !== clientRef.current) return
        const s = unwrap(r)
        id = s?.id ?? null
        if (id) {
          clearEvents()
          setActiveId(id)
          activeIdRef.current = id
          setMessages([])
          await loadSessions()
        }
      }
      if (c !== clientRef.current) return
      if (!id) { setBusy(false); return }
      setInput('')
      await c.session.promptAsync({ path: { id }, body, throwOnError: true })
    } catch (e) {
      if (c !== clientRef.current) return
      setLastError(`发送失败：${e instanceof Error ? e.message : String(e)}`)
      setBusy(false)
    }
  }

  const abort = async (): Promise<void> => {
    const id = activeIdRef.current
    const c = clientRef.current
    if (!id || !c) return
    try {
      await c.session.abort({ path: { id }, throwOnError: true })
    } catch (e) {
      if (c === clientRef.current) setLastError(`停止失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const statusColor =
    server?.status === 'ready'
      ? 'bg-emerald-400'
      : server?.status === 'error'
        ? 'bg-rose-400'
        : 'bg-amber-400'

  const lastUser = [...messages].reverse().find((message) => message.info?.role === 'user')
  const awaitingUserEcho = busy && (lastUser?.info?.id ?? null) === beforeRequestUserId.current
  if (busy && !awaitingUserEcho && lastUser?.info?.id && pendingTurnKey.current) {
    if (!turnKeys.current.has(lastUser.info.id)) turnKeys.current.set(lastUser.info.id, pendingTurnKey.current)
  }

  // Keep each turn at one stable React position. Moving an older reply into a
  // different parent would remount its Worker-rendered Markdown on every send.
  const conversation: React.ReactNode[] = []
  let turnReplies: MessageEntry[] = []
  let turnKey = 'reply-initial'
  const appendReply = (waiting: boolean): void => {
    const visible = turnReplies.some((message) => message.parts.some(hasVisiblePart))
    if (!visible && !waiting) return
    const replies = turnReplies
    const textLength = replies.reduce((total, message) => total + message.parts.reduce((count, part) =>
      count + ((part.type === 'text' || part.type === 'reasoning') ? (part.text?.length ?? 0) : 0), 0), 0)
    conversation.push(
      <ReplyPresentation key={turnKey} waiting={waiting && !visible} textLength={textLength}>
        {(visibleChars) => {
          let remaining = visibleChars
          return replies.map((message, index) => {
            const allowance = remaining
            if (remaining !== undefined) remaining = Math.max(0, remaining - message.parts.reduce((total, part) =>
              total + ((part.type === 'text' || part.type === 'reasoning') ? (part.text?.length ?? 0) : 0), 0))
            return <MessageView key={message.info?.id ?? index} msg={message} inReply visibleChars={allowance} />
          })
        }}
      </ReplyPresentation>
    )
  }
  for (const [index, message] of messages.entries()) {
    if (message.info?.role === 'user') {
      appendReply(false)
      conversation.push(<MessageView key={message.info?.id ?? `user-${index}`} msg={message} />)
      turnKey = turnKeys.current.get(message.info?.id) ?? `reply-${message.info?.id ?? index}`
      turnReplies = []
    } else {
      turnReplies.push(message)
    }
  }
  appendReply(busy && !awaitingUserEcho)
  if (busy && awaitingUserEcho) {
    conversation.push(<ReplyPresentation key={pendingTurnKey.current ?? 'reply-pending'} waiting />)
  }

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden">
      <div className="app-bg" />
      {sessionMenu ? (
        <SessionContextMenu
          target={sessionMenu}
          disabled={deletingId != null || server?.status !== 'ready'}
          onDelete={deleteSession}
          onClose={closeSessionMenu}
        />
      ) : null}

      <header className="drag flex h-11 shrink-0 items-center justify-between px-3">
        <div className="flex items-center gap-2 text-xs text-white/70">
          <span className="font-semibold tracking-wide text-white/90">OpencodeHUI</span>
          <span className={`h-2 w-2 rounded-full ${statusColor}`} />
          <span>
            {server?.status === 'ready'
              ? `已连接 :${server.port}${server.version ? ` · v${server.version}` : ''}`
              : server?.status === 'error'
                ? '启动失败'
                : '正在启动 opencode…'}
          </span>
        </div>
        <div className="no-drag flex items-center gap-1">
          <button
            onClick={() => window.api.window.minimize()}
            className="grid h-7 w-9 place-items-center rounded-md text-white/70 hover:bg-white/10"
          >
            &#8211;
          </button>
          <button
            onClick={() => window.api.window.maximize()}
            className="grid h-7 w-9 place-items-center rounded-md text-white/70 hover:bg-white/10"
          >
            &#9723;
          </button>
          <button
            onClick={() => window.api.window.close()}
            className="grid h-7 w-9 place-items-center rounded-md text-white/70 hover:bg-white/10"
          >
            &#10005;
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 gap-3 p-3 pt-0">
        <aside className="glass flex w-64 shrink-0 flex-col rounded-2xl p-3">
          <button
            onClick={newSession}
            disabled={server?.status !== 'ready' || !workspace}
            className="mb-3 rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm font-medium text-white/90 transition hover:bg-white/16 disabled:opacity-40"
          >
            + 新建会话
          </button>
          <div onScroll={closeSessionMenu} className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
            {sessions.length === 0 ? (
              <div className="px-2 py-6 text-center text-xs text-white/40">暂无会话</div>
            ) : (
              sessions.map((s, i) => (
                <button
                  key={s.id ?? i}
                  onClick={() => openSession(s.id)}
                  disabled={deletingId === s.id}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    const bounds = event.currentTarget.getBoundingClientRect()
                    setSessionMenu({
                      id: s.id,
                      x: event.clientX || bounds.left + 24,
                      y: event.clientY || bounds.bottom
                    })
                  }}
                  className={`w-full truncate rounded-xl px-3 py-2 text-left text-[13px] transition disabled:cursor-wait disabled:opacity-40 ${
                    s.id === activeId
                      ? 'glass-soft text-white'
                      : 'text-white/60 hover:bg-white/8 hover:text-white/90'
                  }`}
                  title={s.title}
                >
                  {deletingId === s.id ? '正在删除…' : s.title || '未命名会话'}
                </button>
              ))
            )}
          </div>
          {server?.status === 'error' ? (
            <div className="mt-2 text-[11px] leading-snug text-rose-300/90">
              {server.error}
              <button
                onClick={() => window.api.restartServer()}
                className="mt-1 block w-full rounded-lg bg-rose-500/20 px-2 py-1 text-rose-200 hover:bg-rose-500/30"
              >
                重试
              </button>
            </div>
          ) : null}
          <div className="mt-3 shrink-0 border-t border-white/10 pt-3">
            <button
              type="button"
              onClick={chooseWorkspace}
              disabled={!workspace || choosingWorkspace}
              className="mb-3 flex w-full items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/8 px-3 py-2 text-[13px] text-white/80 transition hover:bg-white/14 disabled:cursor-wait disabled:opacity-40"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="M3 7V5h6l2 2h10v3M3 7v13h16l3-10H7l-4 10" />
              </svg>
              {choosingWorkspace ? '正在选择…' : '切换工作空间'}
            </button>
            <div className="mb-1 text-[10px] text-white/40">当前工作空间</div>
            <div aria-label="当前工作空间" title={workspace ?? ''} className="truncate font-mono text-[11px] text-white/65">
              {workspace ?? '正在读取…'}
            </div>
          </div>
        </aside>

        <main className="glass flex min-w-0 flex-1 flex-col rounded-2xl">
          <div
            ref={scrollRef}
            onScroll={onScroll}
            onWheel={(event) => {
              userScrolling.current = true
              if (event.deltaY < 0) stickBottom.current = false
            }}
            onPointerDown={(event) => {
              if (event.clientX >= event.currentTarget.getBoundingClientRect().right - 12) userScrolling.current = true
            }}
            onTouchStart={() => { userScrolling.current = true }}
            onKeyDown={(event) => {
              if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) userScrolling.current = true
            }}
            className="hui-chat-scroll min-h-0 flex-1 overflow-y-auto p-5"
          >
            <div ref={contentRef} className={`space-y-4 ${messages.length === 0 && !busy ? 'h-full' : ''}`}>
              {messages.length === 0 && !busy ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-white/40">
                  <div className="text-lg font-medium text-white/60">开始一段对话</div>
                  <div className="text-xs">在下方输入内容，回车发送 · 支持 Markdown 与 LaTeX</div>
                </div>
              ) : conversation}
            </div>
          </div>

          <div className="shrink-0 p-3 pt-0">
            {lastError ? (
              <div className="mb-2 flex items-start justify-between gap-2 rounded-xl border border-rose-400/30 bg-rose-500/15 px-3 py-2 text-[12px] text-rose-100">
                <span className="min-w-0 break-words">{lastError}</span>
                <button
                  onClick={() => setLastError(null)}
                  className="shrink-0 rounded px-1 text-rose-200/80 hover:text-white"
                >
                  ✕
                </button>
              </div>
            ) : null}
            <div className="glass-soft rounded-2xl p-2">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                rows={1}
                placeholder={
                  server?.status === 'ready'
                    ? '输入消息… (Enter 发送 / Shift+Enter 换行)'
                    : '等待 opencode 启动…'
                }
                disabled={server?.status !== 'ready' || !workspace}
                className="max-h-40 min-h-[22px] w-full resize-none bg-transparent px-3 py-1.5 text-[13.5px] text-white/90 outline-none placeholder:text-white/35 disabled:opacity-50"
              />
              <div className="mt-1 flex items-center gap-2 px-1">
                <Select
                  value={selectedAgent ?? ''}
                  onChange={setSelectedAgent}
                  title="Agent"
                  disabled={agents.length === 0 || server?.status !== 'ready'}
                >
                  {agents.length === 0 ? <option value="">agent…</option> : null}
                  {agents.map((a) => (
                    <option key={a.name} value={a.name}>
                      {a.name}
                    </option>
                  ))}
                </Select>

                <Select
                  value={selectedModel ? `${selectedModel.providerID}/${selectedModel.modelID}` : ''}
                  onChange={(v) => {
                    const idx = v.indexOf('/')
                    if (idx > 0)
                      setSelectedModel({ providerID: v.slice(0, idx), modelID: v.slice(idx + 1) })
                  }}
                  title="模型"
                  disabled={models.length === 0 || server?.status !== 'ready'}
                >
                  {models.length === 0 ? <option value="">加载模型…</option> : null}
                  {modelGroups.map(([pid, items]) => (
                    <optgroup key={pid} label={items[0].providerName}>
                      {items.map((m) => (
                        <option
                          key={`${m.providerID}/${m.modelID}`}
                          value={`${m.providerID}/${m.modelID}`}
                        >
                          {m.modelName}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>

                <div className="flex-1" />

                {busy ? (
                  <button
                    onClick={() => void abort()}
                    className="rounded-xl border border-white/15 bg-white/8 px-4 py-2 text-[13px] font-medium text-white/80 transition hover:bg-white/14"
                  >
                    停止
                  </button>
                ) : (
                  <button
                    onClick={() => void send()}
                    disabled={!input.trim() || server?.status !== 'ready' || !workspace}
                    className="rounded-xl bg-white/90 px-4 py-2 text-[13px] font-semibold text-slate-900 transition hover:bg-white disabled:opacity-40"
                  >
                    发送
                  </button>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
