import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createOpencodeClient } from '@opencode-ai/sdk/client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'

interface ServerInfo {
  status: 'starting' | 'ready' | 'error' | 'stopped'
  url?: string
  port?: number
  error?: string
  version?: string
  binary?: string
}

interface MessageEntry {
  info: any
  parts: any[]
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

function reduceDelta(prev: MessageEntry[], d: any): MessageEntry[] {
  const { sessionID, messageID, partID, field, delta } = d
  if (!partID || typeof delta !== 'string') return prev
  let next = prev
  let i = next.findIndex((m) => m.info?.id === messageID)
  if (i === -1) {
    next = [...prev, { info: { id: messageID, role: 'assistant' }, parts: [] }]
    i = next.length - 1
  } else {
    next = prev.slice()
  }
  const msg = next[i]
  const pi = msg.parts.findIndex((p: any) => p.id === partID)
  const parts = msg.parts.slice()
  if (pi === -1) {
    parts.push({
      id: partID,
      messageID,
      sessionID,
      type: field === 'text' ? 'text' : field,
      [field]: delta
    })
  } else {
    const p = parts[pi]
    parts[pi] = { ...p, [field]: (p[field] ?? '') + delta }
  }
  next[i] = { ...msg, parts }
  return next
}

const Markdown = memo(function Markdown({ text }: { text: string }): React.ReactElement {
  return (
    <div className="hui-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false }], [rehypeHighlight, { detect: false, ignoreMissing: true }]]}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})

const FENCE_RE = /^\s*(```+|~~~+)/
function splitStreaming(text: string): { blocks: string[]; openTail: boolean } {
  const lines = text.split('\n')
  const blocks: string[] = []
  let buf: string[] = []
  let fence: string | null = null
  for (const line of lines) {
    const m = line.match(FENCE_RE)
    if (m) {
      if (!fence) fence = m[1][0]
      else if (line.trim().startsWith(fence.repeat(3))) fence = null
    }
    buf.push(line)
    if (!fence && line.trim() === '') {
      blocks.push(buf.join('\n'))
      buf = []
    }
  }
  const tail = buf.join('\n')
  const openTail = fence !== null
  if (tail) blocks.push(tail)
  return { blocks, openTail }
}

/* 流式期间按块渲染：已完成块被 memo 缓存只解析一次，
   未闭合的代码块先以纯文本显示，避免每个 delta 全量重跑 markdown/highlight */
const StreamingMarkdown = memo(function StreamingMarkdown({
  text,
  done
}: {
  text: string
  done?: boolean
}): React.ReactElement {
  if (done) return <Markdown text={text} />
  const { blocks, openTail } = splitStreaming(text)
  return (
    <>
      {blocks.map((b, i) =>
        openTail && i === blocks.length - 1 ? (
          <pre key={i} className="hui-code hui-code-live">
            {b}
          </pre>
        ) : (
          <Markdown key={i} text={b} />
        )
      )}
    </>
  )
})

const PartView = memo(function PartView({ part }: { part: any }): React.ReactElement | null {
  const done = part.time?.end != null
  if (part.type === 'text') {
    if (!part.text) return null
    return <StreamingMarkdown text={part.text} done={done} />
  }

  if (part.type === 'reasoning') {
    if (!part.text) return null
    return (
      <div className="hui-reasoning">
        <StreamingMarkdown text={part.text} done={done} />
      </div>
    )
  }

  if (part.type === 'tool') {
    const state = part.state ?? {}
    return (
      <details className="glass-soft rounded-xl px-3 py-2 text-xs">
        <summary className="flex cursor-pointer list-none items-center gap-2">
          <span className="font-mono text-[11px] text-cyan-200/90">{part.tool}</span>
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-[10px] text-white/60">
            {state.status ?? 'running'}
          </span>
          {state.title ? <span className="truncate text-white/50">{state.title}</span> : null}
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

const MessageView = memo(function MessageView({ msg }: { msg: MessageEntry }): React.ReactElement {
  const isUser = msg.info?.role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`flex min-w-0 max-w-[82%] flex-col gap-2 rounded-2xl px-4 py-3 ${
          isUser ? 'border border-white/15 bg-white/12' : 'glass'
        }`}
      >
        {msg.parts?.map((p, i) => (
          <PartView key={p.id ?? i} part={p} />
        ))}
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
  const [sessions, setSessions] = useState<any[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageEntry[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [lastError, setLastError] = useState<string | null>(null)

  const [models, setModels] = useState<ModelOption[]>([])
  const [selectedModel, setSelectedModel] = useState<SelectedModel | null>(null)
  const [agents, setAgents] = useState<any[]>([])
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)

  const clientRef = useRef<any>(null)
  const clientBase = useRef<string | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickBottom = useRef(true)

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
    if (!c) return
    try {
      const r = await c.session.list()
      setSessions(unwrap(r) ?? [])
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

  const upsertPart = useCallback((part: any) => {
    if (!part?.id) return
    setMessages((prev) => {
      let next = prev
      let i = next.findIndex((m) => m.info?.id === part.messageID)
      if (i === -1) {
        next = [...prev, { info: { id: part.messageID, role: 'assistant' }, parts: [] }]
        i = next.length - 1
      } else {
        next = prev.slice()
      }
      const msg = next[i]
      const pi = msg.parts.findIndex((p: any) => p.id === part.id)
      const parts = msg.parts.slice()
      if (pi === -1) parts.push(part)
      else parts[pi] = part
      next[i] = { ...msg, parts }
      return next
    })
  }, [])

  const upsertMessage = useCallback((info: any) => {
    if (!info?.id) return
    setMessages((prev) => {
      const i = prev.findIndex((m) => m.info?.id === info.id)
      if (i === -1) return [...prev, { info, parts: [] }]
      const next = prev.slice()
      next[i] = { ...next[i], info: { ...next[i].info, ...info } }
      return next
    })
  }, [])

  /* 按动画帧合并提交：同一帧内到达的多个 delta 只触发一次渲染。
     显示器每帧最多画一次，所以这不增加任何可见延迟；
     但它保证主线程不会被"每个 delta 各渲染一次"的积压淹没（那正是之前一坨一坨的根因）。*/
  const pendingDeltas = useRef<any[]>([])
  const rafRef = useRef<number | null>(null)
  const flushDeltas = useCallback(() => {
    rafRef.current = null
    const batch = pendingDeltas.current
    if (batch.length === 0) return
    pendingDeltas.current = []
    setMessages((prev) => {
      let next = prev
      for (const d of batch) next = reduceDelta(next, d)
      return next
    })
  }, [])
  const enqueueDelta = useCallback(
    (d: any) => {
      if (!d?.partID || typeof d.delta !== 'string') return
      pendingDeltas.current.push(d)
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(flushDeltas)
    },
    [flushDeltas]
  )

  const removePart = useCallback((messageID: string, partID: string) => {
    setMessages((prev) =>
      prev.map((m) =>
        m.info?.id === messageID ? { ...m, parts: m.parts.filter((p) => p.id !== partID) } : m
      )
    )
  }, [])

  const removeMessage = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.info?.id !== id))
  }, [])

  const refreshMessages = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current)
    refreshTimer.current = setTimeout(async () => {
      const c = clientRef.current
      const id = activeIdRef.current
      if (!c || !id) return
      try {
        const r = await c.session.messages({ path: { id } })
        setMessages(unwrap(r) ?? [])
      } catch (e) {
        console.error('load messages failed', e)
      }
    }, 60)
  }, [])

  const openSession = useCallback(async (id: string) => {
    setActiveId(id)
    activeIdRef.current = id
    setMessages([])
    const c = clientRef.current
    if (!c) return
    try {
      const r = await c.session.messages({ path: { id } })
      setMessages(unwrap(r) ?? [])
    } catch (e) {
      console.error('open session failed', e)
    }
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
    if (server?.status !== 'ready' || !server.url) return
    const url = server.url
    if (clientBase.current === url) return
    clientBase.current = url

    const client = createOpencodeClient({ baseUrl: url })
    clientRef.current = client
    setSessions([])
    setMessages([])
    setModels([])
    setAgents([])
    setActiveId(null)
    activeIdRef.current = null
    loadSessions()
    loadConfig()

    const es = new EventSource(`${url}/event`)
    esRef.current = es
    es.onmessage = (e) => {
      let evt: any
      try {
        evt = JSON.parse(e.data)
      } catch {
        return
      }
      const t = evt?.type
      const p = evt?.properties ?? {}
      const active = activeIdRef.current

      switch (t) {
        case 'message.updated': {
          if (!active || (p.info?.sessionID && p.info.sessionID !== active)) return
          upsertMessage(p.info)
          break
        }
        case 'message.part.updated': {
          if (!active || (p.part?.sessionID && p.part.sessionID !== active)) return
          if (p.part) upsertPart(p.part)
          break
        }
        case 'message.part.delta': {
          if (!active || (p.sessionID && p.sessionID !== active)) return
          enqueueDelta(p)
          break
        }
        case 'message.part.removed': {
          if (!active || (p.sessionID && p.sessionID !== active)) return
          removePart(p.messageID, p.partID)
          break
        }
        case 'message.removed': {
          if (!active || (p.sessionID && p.sessionID !== active)) return
          removeMessage(p.messageID)
          break
        }
        case 'session.idle': {
          if (!active || !p.sessionID || p.sessionID === active) {
            setBusy(false)
            refreshMessages()
          }
          break
        }
        case 'session.error': {
          if (!active || !p.sessionID || p.sessionID === active) {
            const message =
              p?.error?.data?.message ?? p?.error?.message ?? p?.error?.name ?? '未知错误'
            setLastError(String(message))
            setBusy(false)
          }
          break
        }
        case 'session.created':
        case 'session.updated':
        case 'session.deleted':
          loadSessions()
          break
      }
    }

    return () => {
      es.close()
      if (esRef.current === es) esRef.current = null
      clientBase.current = null
    }
  }, [
    server?.status,
    server?.url,
    loadSessions,
    loadConfig,
    refreshMessages,
    upsertMessage,
    upsertPart,
    enqueueDelta,
    removePart,
    removeMessage
  ])

  useEffect(() => {
    if (!stickBottom.current) return
    const el = scrollRef.current
    if (!el) return
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(raf)
  }, [messages])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
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
    const r = await c.session.create({ body: { title: 'New Session' } })
    const s = unwrap(r)
    await loadSessions()
    if (s?.id) openSession(s.id)
  }

  const send = async (): Promise<void> => {
    const text = input.trim()
    const c = clientRef.current
    if (!text || !c || !server?.url) return

    let id = activeIdRef.current
    if (!id) {
      const r = await c.session.create({ body: { title: text.slice(0, 48) } })
      const s = unwrap(r)
      id = s?.id ?? null
      if (id) {
        setActiveId(id)
        activeIdRef.current = id
        setMessages([])
        await loadSessions()
      }
    }
    if (!id) return

    setInput('')
    setBusy(true)
    setLastError(null)
    stickBottom.current = true

    const body: any = { parts: [{ type: 'text', text }] }
    if (selectedModel) body.model = selectedModel
    if (selectedAgent) body.agent = selectedAgent

    try {
      await fetch(`${server.url}/session/${id}/prompt_async`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    } catch (e) {
      console.error('prompt failed', e)
      setBusy(false)
    }
  }

  const abort = async (): Promise<void> => {
    const id = activeIdRef.current
    if (!id || !server?.url) return
    try {
      await fetch(`${server.url}/session/${id}/abort`, { method: 'POST' })
    } catch (e) {
      console.error('abort failed', e)
    }
  }

  const statusColor =
    server?.status === 'ready'
      ? 'bg-emerald-400'
      : server?.status === 'error'
        ? 'bg-rose-400'
        : 'bg-amber-400'

  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden">
      <div className="app-bg" />

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
            disabled={server?.status !== 'ready'}
            className="mb-3 rounded-xl border border-white/15 bg-white/10 px-3 py-2 text-sm font-medium text-white/90 transition hover:bg-white/16 disabled:opacity-40"
          >
            + 新建会话
          </button>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
            {sessions.length === 0 ? (
              <div className="px-2 py-6 text-center text-xs text-white/40">暂无会话</div>
            ) : (
              sessions.map((s, i) => (
                <button
                  key={s.id ?? i}
                  onClick={() => openSession(s.id)}
                  className={`w-full truncate rounded-xl px-3 py-2 text-left text-[13px] transition ${
                    s.id === activeId
                      ? 'glass-soft text-white'
                      : 'text-white/60 hover:bg-white/8 hover:text-white/90'
                  }`}
                  title={s.title}
                >
                  {s.title || '未命名会话'}
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
        </aside>

        <main className="glass flex min-w-0 flex-1 flex-col rounded-2xl">
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5"
          >
            {messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-white/40">
                <div className="text-lg font-medium text-white/60">开始一段对话</div>
                <div className="text-xs">在下方输入内容，回车发送 · 支持 Markdown 与 LaTeX</div>
              </div>
            ) : (
              messages.map((m, i) => <MessageView key={m.info?.id ?? i} msg={m} />)
            )}
            {busy ? (
              <div className="flex items-center gap-2 pl-1 text-xs text-white/50">
                <span className="h-2 w-2 animate-pulse rounded-full bg-cyan-300" />
                正在思考…
              </div>
            ) : null}
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
                disabled={server?.status !== 'ready'}
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
                    disabled={!input.trim() || server?.status !== 'ready'}
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
