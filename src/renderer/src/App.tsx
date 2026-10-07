import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ClipboardEvent } from 'react'
import { createOpencodeClient } from '@opencode-ai/sdk/client'
import { createOpencodeClient as createQuestionClient, type QuestionRequest } from '@opencode-ai/sdk/v2/client'
import { GradFlow } from 'gradflow'
import { StreamingMarkdown } from './StreamingMarkdown'
import { SessionContextMenu, type SessionMenuTarget } from './SessionContextMenu'
import { sameWorkspace } from './workspace-path'
import { ReplyPresentation, hasVisiblePart } from './ReplyPresentation'
import { useLiquidGlassSurface } from './LiquidGlass'
import { MottledBackground } from './MottledBackground'
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

interface Attachment {
  id: string
  name: string
  mime: string
  url: string
  size: number
}

interface MenuOption { value: string; label: string; group?: string }

interface RevertedTurn {
  sessionId: string
  messageID: string
  hiddenIds: ReadonlySet<string>
  rounds: number
  restoreAvailable: boolean
}

const revertedTurn = (sessionId: string, messages: MessageEntry[], messageID?: string): RevertedTurn | null => {
  if (!messageID) return null
  const index = messages.findIndex(message => message.info?.id === messageID)
  if (index < 0) return null
  const hidden = messages.slice(index)
  return {
    sessionId, messageID,
    hiddenIds: new Set(hidden.map(message => message.info?.id).filter(Boolean)),
    rounds: hidden.filter(message => message.info?.role === 'user').length,
    restoreAvailable: true
  }
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

const displayToolName = (name: string): string => name.charAt(0).toUpperCase() + name.slice(1)

const defaultPanelTransparency = 55
const defaultChatFontSize = 15.5
const colorFlow = {
  color1: '#252044',
  color2: '#173841',
  color3: '#47253f',
  type: 'wave' as const,
  speed: 0.95,
  scale: 0.9,
  noise: 0.015
}
type BackgroundMode = 'solid' | 'subtle' | 'color'
const backgroundModes: { value: BackgroundMode; label: string; description: string }[] = [
  { value: 'solid', label: '深灰纯色', description: '安静、无动画' },
  { value: 'subtle', label: '黑灰流动', description: '低对比度的柔和变化' },
  { value: 'color', label: '彩色流动', description: '深色底上的渐变色彩' }
]
const readBackgroundMode = (): BackgroundMode => {
  try {
    const saved = localStorage.getItem('hui.backgroundMode')
    if (saved === 'solid' || saved === 'subtle' || saved === 'color') return saved
  } catch { /* Keep the default when local storage is unavailable. */ }
  return 'color'
}
const readChatFontSize = (): number => {
  try {
    const saved = Number(localStorage.getItem('hui.chatFontSize'))
    if (Number.isFinite(saved) && saved >= 13 && saved <= 20) return saved
  } catch { /* Keep the default when local storage is unavailable. */ }
  return defaultChatFontSize
}
const readPanelTransparency = (): number => {
  try {
    const saved = localStorage.getItem('hui.panelTransparency')
    if (saved !== null) {
      const value = Number(saved)
      if (Number.isFinite(value)) return Math.min(90, Math.max(0, value))
    }
  } catch { /* Keep the default when local storage is unavailable. */ }
  return defaultPanelTransparency
}

const readLiquidGlass = (): boolean => {
  try { return localStorage.getItem('hui.liquidGlass') !== 'false' } catch { return true }
}
const plainGlassFilter: CSSProperties = {
  backdropFilter: 'blur(22px) saturate(160%)',
  WebkitBackdropFilter: 'blur(22px) saturate(160%)'
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
    const displayName = displayToolName(toolName)
    if (toolName.toLowerCase() === 'question') return (
      <div className="hui-tool-call hui-question-tool" data-tool-color="default">
        <span className="hui-tool-name">Question</span>
        <span className="hui-tool-status">{state.status === 'completed' ? '已回答' : state.status === 'error' ? '已结束' : '等待回答'}</span>
        {state.title ? <span className="hui-tool-title">{String(state.title)}</span> : null}
      </div>
    )
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

const MessageView = memo(function MessageView({ msg, inReply = false, visibleChars, liquidGlass = false, onCopyError, onRevert, reverting = false, revertDisabled = false }: {
  msg: MessageEntry
  inReply?: boolean
  visibleChars?: number
  liquidGlass?: boolean
  onCopyError?: (message: string) => void
  onRevert?: (message: MessageEntry) => void
  reverting?: boolean
  revertDisabled?: boolean
}): React.ReactElement | null {
  const lens = useLiquidGlassSurface<HTMLDivElement>(liquidGlass && !inReply)
  const [copied, setCopied] = useState(false)
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
  const copyText = msg.parts.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n')
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(copyText)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch (error) {
      onCopyError?.(`复制失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={isUser ? 'flex min-w-0 max-w-[82%] flex-col items-end gap-1' : 'w-full'}>
        <div
          ref={lens.ref}
          style={lens.style}
          className={`hui-message-parts flex min-w-0 flex-col gap-2 rounded-2xl px-4 py-3 ${isUser ? 'hui-user-message' : 'glass hui-message'} ${liquidGlass ? 'glass-liquid' : ''}`}
        >
          {lens.filter}
          {parts}
        </div>
        {isUser ? (
          <div className="hui-user-actions flex items-center gap-1">
            <button type="button" onClick={() => void copy()} disabled={!copyText} aria-label="复制消息" className="hui-user-action">{copied ? '已复制' : '复制'}</button>
            {onRevert ? <button type="button" onClick={() => onRevert(msg)} disabled={revertDisabled} aria-label="撤回消息" title="撤回此轮及之后的对话和相关工作区改动" className="hui-user-action hui-user-revert">{reverting ? '正在撤回…' : '撤回'}</button> : null}
          </div>
        ) : null}
      </div>
    </div>
  )
})

const CallBlock = memo(function CallBlock({ msg, order, foldedByNext, visibleChars, liquidGlass }: {
  msg: MessageEntry
  order: number
  foldedByNext: boolean
  visibleChars?: number
  liquidGlass: boolean
}): React.ReactElement {
  const panelId = useId()
  const lens = useLiquidGlassSurface<HTMLElement>(liquidGlass)
  const [expanded, setExpanded] = useState(!foldedByNext)
  const previousFolded = useRef(foldedByNext)

  // React only to a new call boundary, not to every streamed delta. A user
  // may reopen an older block without the next update closing it again.
  useLayoutEffect(() => {
    if (previousFolded.current === foldedByNext) return
    previousFolded.current = foldedByNext
    setExpanded(!foldedByNext)
  }, [foldedByNext])

  const tools = new Map<string, { name: string; count: number; color: string }>()
  if (foldedByNext) {
    for (const part of msg.parts) {
      if (part.type !== 'tool') continue
      const name = String(part.tool ?? 'Tool')
      const key = name.toLowerCase()
      const existing = tools.get(key)
      if (existing) existing.count++
      else tools.set(key, { name: displayToolName(name), count: 1, color: toolColors[key] ?? 'default' })
    }
  }
  return (
    <section ref={lens.ref} style={lens.style} className={`hui-call-block ${liquidGlass ? 'glass-liquid' : ''} ${foldedByNext ? 'is-step' : 'is-active'}`} data-expanded={expanded} data-message-id={msg.info?.id}>
      {lens.filter}
      {foldedByNext ? (
        <button className="hui-call-header" type="button" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded(value => !value)}>
          <span className="hui-call-chevron" aria-hidden="true" />
          <span className="hui-call-heading">步骤 {order}</span>
          {tools.size > 0 ? (
            <span className="hui-call-meta">
              调用了 {Array.from(tools, ([key, tool], index) => (
                <span key={key} className="hui-step-tool" data-tool-color={tool.color}>{index > 0 ? '，' : ''}{tool.count}次 {tool.name}</span>
              ))}
            </span>
          ) : null}
          <span className="hui-call-state">{expanded ? '收起' : '展开'}</span>
        </button>
      ) : null}
      <div className="hui-call-reveal" aria-hidden={foldedByNext && !expanded} inert={foldedByNext && !expanded}>
        <div id={panelId} className="hui-call-content">
          <MessageView msg={msg} inReply visibleChars={visibleChars} />
        </div>
      </div>
    </section>
  )
})

function GlassSelect({ value, onChange, options, title, disabled, empty }: {
  value: string
  onChange: (value: string) => void
  options: MenuOption[]
  title: string
  disabled?: boolean
  empty: string
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [focusIndex, setFocusIndex] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const listId = useId()
  const selectedIndex = options.findIndex(option => option.value === value)
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  return (
    <div ref={root} className="hui-picker no-drag" data-open={open}>
      <button type="button" title={title} disabled={disabled} aria-label={title} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
        onClick={() => { setFocusIndex(Math.max(0, selectedIndex)); setOpen(previous => !previous) }}
        onKeyDown={event => {
          if (event.key === 'Escape') { setOpen(false); return }
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (!open) { setFocusIndex(Math.max(0, selectedIndex)); setOpen(true) }
            else setFocusIndex(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length)
          }
          if (event.key === 'Enter' && open && options[focusIndex]) { onChange(options[focusIndex].value); setOpen(false) }
        }}
        className="hui-picker-trigger">
        <span className="truncate">{options[selectedIndex]?.label ?? empty}</span><span className="hui-picker-chevron" aria-hidden="true">⌄</span>
      </button>
      <div id={listId} role="listbox" aria-label={title} className="hui-picker-panel glass" style={plainGlassFilter}>
        <div className="hui-picker-scroll">
          {options.map((option, index) => (
            <div key={option.value}>
              {option.group && (index === 0 || options[index - 1].group !== option.group) ? <div className="hui-picker-group">{option.group}</div> : null}
              <button type="button" role="option" aria-selected={value === option.value} tabIndex={-1}
                className="hui-picker-option" data-focused={focusIndex === index}
                onMouseEnter={() => setFocusIndex(index)}
                onClick={() => { onChange(option.value); setOpen(false) }}>
                <span className="truncate">{option.label}</span>{value === option.value ? <span aria-hidden="true">✓</span> : null}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function QuestionDialog({ request, busy, onReply, onReject }: {
  request: QuestionRequest
  busy: boolean
  onReply: (answers: string[][]) => void
  onReject: () => void
}): React.ReactElement {
  const [answers, setAnswers] = useState<string[][]>(() => request.questions.map(() => []))
  const [custom, setCustom] = useState<string[]>(() => request.questions.map(() => ''))
  const choose = (questionIndex: number, label: string, multiple: boolean): void => {
    setAnswers(previous => previous.map((answer, index) => index !== questionIndex ? answer : multiple
      ? answer.includes(label) ? answer.filter(item => item !== label) : [...answer, label]
      : [label]))
  }
  const finalAnswers = request.questions.map((question, index) => {
    const typed = custom[index]?.trim()
    return typed && question.multiple ? [...answers[index], typed] : typed ? [typed] : answers[index]
  })
  return (
    <div className="hui-question-backdrop" role="presentation">
      <section className="hui-question-dialog glass" style={plainGlassFilter} role="dialog" aria-modal="true" aria-label="需要回答的问题">
        <div className="hui-question-heading"><span>需要你的回答</span><span className="hui-question-count">{request.questions.length} 个问题</span></div>
        <div className="hui-question-body">
          {request.questions.map((question, index) => (
            <fieldset key={index} className="hui-question-field">
              <legend><span className="hui-question-header">{question.header}</span>{question.question}</legend>
              <div className="hui-question-options">
                {question.options.map(option => {
                  const selected = answers[index].includes(option.label)
                  return <button key={option.label} type="button" aria-pressed={selected} onClick={() => choose(index, option.label, !!question.multiple)} className="hui-question-option">
                    <span className="hui-question-marker">{selected ? '✓' : ''}</span><span><strong>{option.label}</strong><small>{option.description}</small></span>
                  </button>
                })}
              </div>
              {question.custom !== false ? <input value={custom[index]} onChange={event => setCustom(previous => previous.map((text, i) => i === index ? event.target.value : text))} placeholder="输入其他回答…" className="hui-question-custom" /> : null}
            </fieldset>
          ))}
        </div>
        <div className="hui-question-actions">
          <button type="button" disabled={busy} onClick={onReject} className="hui-question-cancel">拒绝回答</button>
          <button type="button" disabled={busy || finalAnswers.some(answer => answer.length === 0)} onClick={() => onReply(finalAnswers)} className="hui-question-submit">{busy ? '提交中…' : '提交回答'}</button>
        </div>
      </section>
    </div>
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
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [draggingFiles, setDraggingFiles] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const attachmentEpoch = useRef(0)
  const [questions, setQuestions] = useState<QuestionRequest[]>([])
  const [answeringQuestion, setAnsweringQuestion] = useState(false)
  const questionClientRef = useRef<ReturnType<typeof createQuestionClient> | null>(null)
  const questionVersion = useRef(0)
  const [busy, setBusy] = useState(false)
  const beforeRequestUserId = useRef<string | null>(null)
  const pendingTurnKey = useRef<string | null>(null)
  const turnKeySequence = useRef(0)
  const turnKeys = useRef(new Map<string, string>())
  const [lastError, setLastError] = useState<string | null>(null)
  const [sessionMenu, setSessionMenu] = useState<SessionMenuTarget | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [revertingId, setRevertingId] = useState<string | null>(null)
  const [reverted, setReverted] = useState<RevertedTurn | null>(null)
  const revertOperation = useRef<{ client: any; sessionId: string; messageId: string } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [panelTransparency, setPanelTransparency] = useState(readPanelTransparency)
  const [chatFontSize, setChatFontSize] = useState(readChatFontSize)
  const [liquidGlass, setLiquidGlass] = useState(readLiquidGlass)
  const [backgroundMode, setBackgroundMode] = useState(readBackgroundMode)
  const settingsRef = useRef<HTMLDivElement | null>(null)

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

  useEffect(() => {
    try { localStorage.setItem('hui.panelTransparency', String(panelTransparency)) } catch { /* Preview still works. */ }
  }, [panelTransparency])

  useEffect(() => {
    try { localStorage.setItem('hui.chatFontSize', String(chatFontSize)) } catch { /* Preview still works. */ }
  }, [chatFontSize])

  useEffect(() => {
    try { localStorage.setItem('hui.liquidGlass', String(liquidGlass)) } catch { /* Preview still works. */ }
  }, [liquidGlass])

  useEffect(() => {
    try { localStorage.setItem('hui.backgroundMode', backgroundMode) } catch { /* Preview still works. */ }
  }, [backgroundMode])

  useEffect(() => {
    if (!settingsOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!settingsRef.current?.contains(event.target as Node)) setSettingsOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSettingsOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [settingsOpen])

  activeIdRef.current = activeId

  const modelGroups = useMemo(() => {
    const map = new Map<string, ModelOption[]>()
    for (const m of models) {
      if (!map.has(m.providerID)) map.set(m.providerID, [])
      map.get(m.providerID)!.push(m)
    }
    return Array.from(map.entries())
  }, [models])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 192)}px`
    textarea.style.overflowY = textarea.scrollHeight > 192 ? 'auto' : 'hidden'
  }, [input])

  const addFiles = useCallback(async (files: File[]) => {
    if (!files.length) return
    const epoch = attachmentEpoch.current
    const accepted = files.filter(file => {
      if (file.size > 25 * 1024 * 1024) {
        setLastError(`文件过大：${file.name}（上限 25 MB）`)
        return false
      }
      return true
    })
    try {
      const next = await Promise.all(accepted.map(file => new Promise<Attachment>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve({ id: crypto.randomUUID(), name: file.name, mime: file.type || 'application/octet-stream', url: String(reader.result), size: file.size })
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })))
      if (epoch === attachmentEpoch.current) setAttachments(previous => [...previous, ...next])
    } catch (error) {
      if (epoch === attachmentEpoch.current) setLastError(`读取附件失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [])

  const loadQuestions = useCallback(async (sessionId: string) => {
    const c = questionClientRef.current
    const directory = workspaceRef.current
    if (!c || !directory) return
    const version = ++questionVersion.current
    try {
      const result = await c.question.list({ directory }, { throwOnError: true })
      if (c !== questionClientRef.current || sessionId !== activeIdRef.current || version !== questionVersion.current) return
      setQuestions((unwrap(result) ?? []).filter((request: QuestionRequest) => request.sessionID === sessionId))
    } catch (error) {
      if (c === questionClientRef.current && sessionId === activeIdRef.current) console.error('load questions failed', error)
    }
  }, [])

  const resolveQuestion = async (request: QuestionRequest, answers?: string[][]): Promise<void> => {
    const c = questionClientRef.current
    const directory = workspaceRef.current
    if (!c || !directory || request.sessionID !== activeIdRef.current || answeringQuestion) return
    setAnsweringQuestion(true)
    try {
      if (answers) await c.question.reply({ requestID: request.id, directory, answers }, { throwOnError: true })
      else await c.question.reject({ requestID: request.id, directory }, { throwOnError: true })
      if (c === questionClientRef.current && request.sessionID === activeIdRef.current) setQuestions(previous => previous.filter(item => item.id !== request.id))
    } catch (error) {
      if (c === questionClientRef.current && request.sessionID === activeIdRef.current) setLastError(`回答问题失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      if (c === questionClientRef.current) setAnsweringQuestion(false)
    }
  }

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
        const snapshot: MessageEntry[] = unwrap(r) ?? []
        setMessages(snapshot)
        setReverted(previous => previous?.sessionId === id && !snapshot.some(message => previous.hiddenIds.has(message.info?.id)) ? null : previous)
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
    revertOperation.current = null
    setRevertingId(null)
    const epoch = sessionEpoch.current
    const version = revision.current
    setActiveId(id)
    activeIdRef.current = id
    setMessages([])
    setQuestions([])
    setAnsweringQuestion(false)
    void loadQuestions(id)
    setReverted(null)
    try {
      const [r, sessionResult] = await Promise.all([
        c.session.messages({ path: { id } }),
        c.session.get({ path: { id } })
      ])
      if (epoch !== sessionEpoch.current || id !== activeIdRef.current) return
      flushEvents()
      const snapshot: MessageEntry[] = unwrap(r) ?? []
      setReverted(revertedTurn(id, snapshot, unwrap(sessionResult)?.revert?.messageID))
      setMessages(prev => {
        if (version === revision.current) return snapshot
        const live = new Map(prev.map(message => [message.info?.id, message]))
        return [...snapshot.map(message => live.get(message.info?.id) ?? message),
          ...prev.filter(message => !snapshot.some(old => old.info?.id === message.info?.id))]
      })
    } catch (e) {
      console.error('open session failed', e)
    }
  }, [clearEvents, flushEvents, closeSessionMenu, loadQuestions])

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
      setQuestions([])
      questionVersion.current++
      setReverted(null)
      revertOperation.current = null
      setRevertingId(null)
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
    questionClientRef.current = null
    questionVersion.current++
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
    setQuestions([])
    setAnsweringQuestion(false)
    attachmentEpoch.current++
    setAttachments([])
    setDraggingFiles(false)
    setReverted(null)
    setRevertingId(null)
    revertOperation.current = null
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
    const questionClient = createQuestionClient({ baseUrl: url, directory: workspace })
    clientRef.current = client
    questionClientRef.current = questionClient
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
        case 'question.asked':
          if (active && p.sessionID === active && p.id) {
            questionVersion.current++
            setQuestions(previous => previous.some(request => request.id === p.id) ? previous : [...previous, p as QuestionRequest])
          }
          break
        case 'question.replied':
        case 'question.rejected':
          if (active && p.sessionID === active) {
            questionVersion.current++
            setQuestions(previous => previous.filter(request => request.id !== p.requestID))
          }
          break
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
      if (questionClientRef.current === questionClient) questionClientRef.current = null
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
    if ((!text && attachments.length === 0) || !c || !server?.url || busy) return

    const body: any = { parts: [
      ...(text ? [{ type: 'text', text }] : []),
      ...attachments.map(file => ({ type: 'file', mime: file.mime, filename: file.name, url: file.url }))
    ] }
    if (selectedModel) body.model = selectedModel
    if (selectedAgent) body.agent = selectedAgent

    beforeRequestUserId.current = [...visibleMessages].reverse().find((message) => message.info?.role === 'user')?.info?.id ?? null
    pendingTurnKey.current = `reply-request-${++turnKeySequence.current}`
    setBusy(true)
    setLastError(null)
    stickBottom.current = true

    try {
      let id = activeIdRef.current
      if (!id) {
        const r = await c.session.create({ body: { title: (text || attachments[0].name).slice(0, 48) }, throwOnError: true })
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
      await c.session.promptAsync({ path: { id }, body, throwOnError: true })
      if (c === clientRef.current && id === activeIdRef.current) {
        setInput(previous => previous === input ? '' : previous)
        setAttachments(previous => previous.filter(file => !attachments.some(sent => sent.id === file.id)))
        setReverted(previous => previous?.sessionId === id ? { ...previous, restoreAvailable: false } : previous)
      }
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

  const revertMessage = async (message: MessageEntry): Promise<void> => {
    const c = clientRef.current
    const sessionId = activeIdRef.current
    const messageId = message.info?.id
    if (!c || !sessionId || !messageId || revertOperation.current) return
    const operation = { client: c, sessionId, messageId }
    revertOperation.current = operation
    setRevertingId(messageId)
    setLastError(null)
    try {
      if (busy) {
        await c.session.abort({ path: { id: sessionId }, throwOnError: true })
        for (let attempt = 0; attempt < 30; attempt++) {
          const result = await c.session.status({ query: { directory: workspaceRef.current ?? undefined }, throwOnError: true })
          if (unwrap(result)?.[sessionId]?.type !== 'busy') break
          if (attempt === 29) throw new Error('当前回复尚未停止，请稍后重试')
          await new Promise(resolve => window.setTimeout(resolve, 100))
        }
      }
      const result = await c.session.revert({ path: { id: sessionId }, body: { messageID: messageId }, throwOnError: true })
      if (c !== clientRef.current || sessionId !== activeIdRef.current || revertOperation.current !== operation) return
      const snapshotResult = await c.session.messages({ path: { id: sessionId }, throwOnError: true })
      if (c !== clientRef.current || sessionId !== activeIdRef.current || revertOperation.current !== operation) return
      const snapshot: MessageEntry[] = unwrap(snapshotResult) ?? []
      const boundary = unwrap(result)?.revert?.messageID ?? messageId
      const next = revertedTurn(sessionId, snapshot, boundary)
      if (!next) throw new Error('无法确认撤回后的消息范围')
      clearEvents()
      setMessages(snapshot)
      setReverted(next)
      setBusy(false)
      pendingTurnKey.current = null
      await loadSessions()
    } catch (error) {
      if (c === clientRef.current && sessionId === activeIdRef.current && revertOperation.current === operation) {
        setLastError(`撤回失败：${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      if (revertOperation.current === operation) {
        revertOperation.current = null
        setRevertingId(null)
      }
    }
  }

  const restoreReverted = async (): Promise<void> => {
    const c = clientRef.current
    const state = reverted
    const sessionId = activeIdRef.current
    if (!c || !state?.restoreAvailable || state.sessionId !== sessionId || busy || revertOperation.current) return
    const operation = { client: c, sessionId, messageId: state.messageID }
    revertOperation.current = operation
    setRevertingId(state.messageID)
    setLastError(null)
    try {
      await c.session.unrevert({ path: { id: sessionId }, throwOnError: true })
      if (c !== clientRef.current || sessionId !== activeIdRef.current || revertOperation.current !== operation) return
      const result = await c.session.messages({ path: { id: sessionId }, throwOnError: true })
      if (c !== clientRef.current || sessionId !== activeIdRef.current || revertOperation.current !== operation) return
      clearEvents()
      setMessages(unwrap(result) ?? [])
      setReverted(null)
      await loadSessions()
    } catch (error) {
      if (c === clientRef.current && sessionId === activeIdRef.current && revertOperation.current === operation) {
        setLastError(`恢复撤回失败：${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      if (revertOperation.current === operation) {
        revertOperation.current = null
        setRevertingId(null)
      }
    }
  }

  const statusColor =
    server?.status === 'ready'
      ? 'bg-emerald-400'
      : server?.status === 'error'
        ? 'bg-rose-400'
        : 'bg-amber-400'

  const visibleMessages = useMemo(() => reverted && reverted.sessionId === activeId
    ? messages.filter(message => !reverted.hiddenIds.has(message.info?.id))
    : messages, [messages, reverted, activeId])
  const lastUser = [...visibleMessages].reverse().find((message) => message.info?.role === 'user')
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
    const replies = turnReplies.filter(message => message.parts.some(hasVisiblePart))
    const textLength = replies.at(-1)?.parts.reduce((count, part) =>
      count + ((part.type === 'text' || part.type === 'reasoning') ? (part.text?.length ?? 0) : 0), 0) ?? 0
    conversation.push(
      <ReplyPresentation key={turnKey} waiting={waiting && !visible} textLength={textLength} liquidGlass={liquidGlass}>
        {(visibleChars) => replies.map((message, index) => (
          <CallBlock key={message.info?.id ?? index} msg={message} order={index + 1} foldedByNext={index < replies.length - 1} visibleChars={index === replies.length - 1 ? visibleChars : undefined} liquidGlass={liquidGlass} />
        ))}
      </ReplyPresentation>
    )
  }
  for (const [index, message] of visibleMessages.entries()) {
    if (message.info?.role === 'user') {
      appendReply(false)
      conversation.push(<MessageView key={message.info?.id ?? `user-${index}`} msg={message} liquidGlass={liquidGlass} onCopyError={setLastError} onRevert={revertMessage} reverting={revertingId === message.info?.id} revertDisabled={revertingId !== null} />)
      turnKey = turnKeys.current.get(message.info?.id) ?? `reply-${message.info?.id ?? index}`
      turnReplies = []
    } else {
      turnReplies.push(message)
    }
  }
  appendReply(busy && !awaitingUserEcho)
  if (busy && awaitingUserEcho) {
    conversation.push(<ReplyPresentation key={pendingTurnKey.current ?? 'reply-pending'} waiting liquidGlass={liquidGlass} />)
  }


  return (
    <div className="relative flex h-screen w-screen flex-col overflow-hidden" style={{ '--hui-panel-strength': 1 - panelTransparency / 100, '--hui-chat-font-size': `${chatFontSize}px` } as CSSProperties}>
      <div className="app-bg" data-mode={backgroundMode} aria-hidden="true">
        {backgroundMode === 'color' ? <GradFlow config={colorFlow} /> : null}
        {backgroundMode === 'subtle' ? <MottledBackground /> : null}
      </div>
      {sessionMenu ? (
        <SessionContextMenu
          target={sessionMenu}
          disabled={deletingId != null || server?.status !== 'ready'}
          onDelete={deleteSession}
          onClose={closeSessionMenu}
        />
      ) : null}

      <header className="drag relative z-30 flex h-11 shrink-0 items-center justify-between px-3">
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
          <div ref={settingsRef} className="relative">
            <button
              type="button"
              aria-label="外观设置"
              aria-expanded={settingsOpen}
              aria-controls="hui-appearance-settings"
              onClick={() => setSettingsOpen(value => !value)}
              className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-white/70 hover:bg-white/10"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M10 2h4l.6 2.3 1.8.8 2.1-1.2 2.8 2.8-1.2 2.1.8 1.8 2.3.6v4l-2.3.6-.8 1.8 1.2 2.1-2.8 2.8-2.1-1.2-1.8.8L14 22h-4l-.6-2.3-1.8-.8-2.1 1.2-2.8-2.8 1.2-2.1-.8-1.8L1 14v-4l2.3-.6.8-1.8-1.2-2.1 2.8-2.8 2.1 1.2 1.8-.8L10 2Z" />
              </svg>
              设置
            </button>
            {settingsOpen ? (
              <div id="hui-appearance-settings" className="glass hui-settings-panel absolute right-0 top-9 w-72 rounded-xl p-4 shadow-2xl">
                <div className="mb-3 text-sm font-semibold text-white/90">外观设置</div>
                <fieldset className="hui-background-choices">
                  <legend className="mb-2 text-xs text-white/75">背景</legend>
                  {backgroundModes.map(mode => (
                    <label key={mode.value} className="hui-background-choice" data-selected={backgroundMode === mode.value}>
                      <input type="radio" name="hui-background-mode" value={mode.value} checked={backgroundMode === mode.value} onChange={() => setBackgroundMode(mode.value)} />
                      <span className="hui-background-swatch" data-mode={mode.value} aria-hidden="true" />
                      <span className="min-w-0 flex-1"><strong>{mode.label}</strong><small>{mode.description}</small></span>
                      <span className="hui-background-check" aria-hidden="true" />
                    </label>
                  ))}
                </fieldset>
                <div className="mt-4 border-t border-white/10 pt-3">
                  <label htmlFor="hui-panel-transparency" className="flex justify-between text-xs text-white/75">
                    <span>面板透明度</span><span>{panelTransparency}%</span>
                  </label>
                  <input
                    id="hui-panel-transparency"
                    type="range"
                    min="0"
                    max="90"
                    value={panelTransparency}
                    onChange={(event) => setPanelTransparency(Number(event.target.value))}
                    className="hui-transparency-range mt-3 w-full"
                  />
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="text-[11px] text-white/50">只调整底色，文字保持清晰</span>
                    <button type="button" onClick={() => setPanelTransparency(defaultPanelTransparency)} className="shrink-0 text-[11px] text-cyan-200/80 hover:text-cyan-100">重置</button>
                  </div>
                </div>
                <div className="mt-4 border-t border-white/10 pt-3">
                  <label htmlFor="hui-chat-font-size" className="flex justify-between text-xs text-white/75">
                    <span>对话正文字号</span><span>{chatFontSize}px</span>
                  </label>
                  <input
                    id="hui-chat-font-size"
                    type="range"
                    min="13"
                    max="20"
                    step="0.5"
                    value={chatFontSize}
                    onChange={(event) => setChatFontSize(Number(event.target.value))}
                    className="hui-transparency-range mt-3 w-full"
                  />
                  <div className="mt-2 flex justify-end">
                    <button type="button" onClick={() => setChatFontSize(defaultChatFontSize)} className="text-[11px] text-cyan-200/80 hover:text-cyan-100">重置</button>
                  </div>
                </div>
                <label className="mt-4 flex cursor-pointer items-center justify-between border-t border-white/10 pt-3 text-xs text-white/75">
                  <span>对话气泡折射 · 实验效果</span>
                  <input type="checkbox" checked={liquidGlass} onChange={event => setLiquidGlass(event.target.checked)} className="hui-liquid-toggle" />
                </label>
              </div>
            ) : null}
          </div>
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
        <aside className="glass flex w-64 shrink-0 flex-col rounded-2xl p-3" style={plainGlassFilter}>
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

        <main className="glass hui-chat-pane flex min-w-0 flex-1 flex-col rounded-2xl" style={{ backdropFilter: 'none', WebkitBackdropFilter: 'none' }}>
          <div className="hui-chat-pane-backdrop" style={plainGlassFilter} aria-hidden="true" />
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
            <div ref={contentRef} className={`space-y-4 ${visibleMessages.length === 0 && !busy ? 'h-full' : ''}`}>
              {visibleMessages.length === 0 && !busy ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-white/40">
                  <div className="text-lg font-medium text-white/60">开始一段对话</div>
                  <div className="text-xs">在下方输入内容，回车发送 · 支持 Markdown 与 LaTeX</div>
                </div>
              ) : conversation}
            </div>
          </div>

          <div className="shrink-0 p-3 pt-0">
            {reverted?.sessionId === activeId && reverted.restoreAvailable ? (
              <div className="hui-revert-notice mb-2 flex items-center justify-between gap-3 rounded-xl px-3 py-2 text-[12px]" role="status">
                <span>已撤回 {reverted.rounds} 轮对话及相关工作区改动</span>
                <button type="button" onClick={() => void restoreReverted()} disabled={busy || revertingId !== null} className="shrink-0 rounded-md px-2 py-1 font-medium text-cyan-200 transition hover:bg-white/10 disabled:opacity-40">{revertingId ? '恢复中…' : '恢复撤回'}</button>
              </div>
            ) : null}
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
            <div className="hui-composer glass-soft rounded-2xl p-2" data-dragging={draggingFiles}
              onDragEnter={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDraggingFiles(true) } }}
              onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } }}
              onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDraggingFiles(false) }}
              onDrop={(event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDraggingFiles(false); void addFiles(Array.from(event.dataTransfer.files)) }}>
              {attachments.length ? <div className="hui-attachments" aria-label="待发送附件">
                {attachments.map(file => <div key={file.id} className="hui-attachment">
                  {file.mime.startsWith('image/') ? <img src={file.url} alt="" /> : <span className="hui-attachment-icon">▤</span>}
                  <span className="truncate" title={file.name}>{file.name}</span>
                  <button type="button" aria-label={`移除 ${file.name}`} onClick={() => setAttachments(previous => previous.filter(item => item.id !== file.id))}>×</button>
                </div>)}
              </div> : null}
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
                  const files = Array.from(event.clipboardData.files)
                  if (files.length) { event.preventDefault(); void addFiles(files) }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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
                className="hui-composer-textarea min-h-[32px] w-full resize-none bg-transparent px-3 py-1.5 text-[13.5px] text-white/90 outline-none placeholder:text-white/35 disabled:opacity-50"
              />
              <div className="mt-1 flex items-center gap-2 px-1">
                <input ref={fileInputRef} type="file" multiple className="hidden" onChange={event => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
                <button type="button" title="添加图片或文件" aria-label="添加图片或文件" disabled={server?.status !== 'ready' || !workspace} onClick={() => fileInputRef.current?.click()} className="hui-attach-button">＋</button>
                <GlassSelect
                  value={selectedAgent ?? ''}
                  onChange={setSelectedAgent}
                  title="Agent"
                  disabled={agents.length === 0 || server?.status !== 'ready'}
                  empty="agent…"
                  options={agents.map(agent => ({ value: agent.name, label: agent.name }))}
                />

                <GlassSelect
                  value={selectedModel ? `${selectedModel.providerID}/${selectedModel.modelID}` : ''}
                  onChange={(v) => {
                    const idx = v.indexOf('/')
                    if (idx > 0)
                      setSelectedModel({ providerID: v.slice(0, idx), modelID: v.slice(idx + 1) })
                  }}
                  title="模型"
                  disabled={models.length === 0 || server?.status !== 'ready'}
                  empty="加载模型…"
                  options={modelGroups.flatMap(([, items]) => items.map(model => ({ value: `${model.providerID}/${model.modelID}`, label: model.modelName, group: model.providerName })))}
                />

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
                    disabled={(!input.trim() && attachments.length === 0) || server?.status !== 'ready' || !workspace}
                    className="rounded-xl bg-white/90 px-4 py-2 text-[13px] font-semibold text-slate-900 transition hover:bg-white disabled:opacity-40"
                  >
                    发送
                  </button>
                )}
              </div>
            </div>
          </div>
          {questions[0] && questions[0].sessionID === activeId ? <QuestionDialog key={questions[0].id} request={questions[0]} busy={answeringQuestion} onReply={answers => void resolveQuestion(questions[0], answers)} onReject={() => void resolveQuestion(questions[0])} /> : null}
        </main>
      </div>
    </div>
  )
}
