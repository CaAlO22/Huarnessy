import { createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ClipboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { createOpencodeClient } from '@opencode-ai/sdk/client'
import { createOpencodeClient as createQuestionClient, type QuestionRequest } from '@opencode-ai/sdk/v2/client'
import { GradFlow } from 'gradflow'
import { usePermissions } from './PermissionGate'
import { StreamingMarkdown } from './StreamingMarkdown'
import { SessionContextMenu, type SessionMenuTarget } from './SessionContextMenu'
import { sameWorkspace } from './workspace-path'
import { ReplyPresentation, hasVisiblePart } from './ReplyPresentation'
import { ReplyDetails, replyMetrics, type ReplyMetrics } from './ReplyDetails'
import { StreamObservations } from './stream-observations'
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
  contextLimit: number
  outputLimit: number
  variants: string[]
}

// Model "variants" carry provider-specific reasoning options; show the common
// effort names in Chinese and fall back to the raw name for anything custom.
function variantLabel(name: string): string {
  const known: Record<string, string> = { none: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' }
  return known[name.toLowerCase()] ?? name.charAt(0).toUpperCase() + name.slice(1)
}

interface CommandOption {
  name: string
  description?: string
  builtin?: boolean
}

// Commands the opencode kernel exposes through its TUI are not part of
// `command.list()`; provide the essential ones client-side so the slash menu
// is not limited to user-defined commands and skills.
const builtinCommands: CommandOption[] = [
  { name: 'compact', description: '压缩当前会话的上下文', builtin: true },
  { name: 'new', description: '新建会话', builtin: true },
  { name: 'undo', description: '撤回上一轮对话', builtin: true },
  { name: 'redo', description: '恢复撤回的对话', builtin: true }
]

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

// 内核 create 未传 title 时会生成 "New session - <ISO>" 默认标题，并只在标题匹配该格式时自动总结。
const DEFAULT_SESSION_TITLE = /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const sessionLabel = (title?: string): string =>
  !title ? '未命名会话' : DEFAULT_SESSION_TITLE.test(title) ? '新会话' : title

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

const imageFilePattern = /\.(avif|bmp|gif|heic|heif|ico|jpe?g|png|svg|tiff?|webp)$/i

// A `read` call whose result carries an image attachment (or whose path ends in
// an image extension) is surfaced as "PicRead" so it reads differently from a
// plain source Read.
const isImageRead = (tool: string, state: any): boolean => {
  if (tool.toLowerCase() !== 'read') return false
  const attachments = state?.attachments
  if (Array.isArray(attachments) && attachments.some((file: any) => typeof file?.mime === 'string' && file.mime.startsWith('image/'))) return true
  const mime = state?.metadata?.mime ?? state?.metadata?.display?.mime
  if (typeof mime === 'string' && mime.startsWith('image/')) return true
  const path = state?.input?.filePath ?? state?.input?.path ?? state?.metadata?.display?.path
  return typeof path === 'string' && imageFilePattern.test(path)
}

const toolDisplayName = (tool: string, state: any): string => isImageRead(tool, state) ? 'PicRead' : displayToolName(tool)

// Header context ring geometry: keep the progress arc in sync with the radius.
const contextRingRadius = 15.5
const contextRingCircumference = 2 * Math.PI * contextRingRadius

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
  return 'subtle'
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
  try { return localStorage.getItem('hui.liquidGlass') === 'true' } catch { return false }
}
const plainGlassFilter: CSSProperties = {
  backdropFilter: 'blur(22px) saturate(160%)',
  WebkitBackdropFilter: 'blur(22px) saturate(160%)'
}
const nonNegativeLineNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined

const readToolMetrics = (state: any): string | null => {
  const display = state.metadata?.display
  const offset = nonNegativeLineNumber(state.input?.offset)
  const requestedStart = offset && offset > 0 ? offset : 1
  if (state.status !== 'completed') return `从第 ${requestedStart} 行开始`
  if (display?.type === 'directory') return null

  if (display?.type === 'file') {
    const start = nonNegativeLineNumber(display.lineStart)
    const end = nonNegativeLineNumber(display.lineEnd)
    if (start !== undefined && end !== undefined) {
      return `从第 ${start} 行开始 · 读取 ${Math.max(0, end - start + 1)} 行`
    }
  }

  // Older kernels only expose the numbered lines in the text output.
  const output = typeof state.output === 'string' ? state.output : ''
  const lines = [...output.matchAll(/^\s*(\d+)(?::\s|\|)/gm)].map(match => Number(match[1]))
  if (lines.length) return `从第 ${lines[0]} 行开始 · 读取 ${lines.length} 行`
  return null
}

const editToolMetrics = (state: any): string | null => {
  if (state.status !== 'completed') return null
  const fileDiff = state.metadata?.filediff
  let added = nonNegativeLineNumber(fileDiff?.additions)
  let removed = nonNegativeLineNumber(fileDiff?.deletions)
  if (added === undefined || removed === undefined) {
    const diff = typeof state.metadata?.diff === 'string' ? state.metadata.diff : ''
    if (!diff) return null
    added = 0
    removed = 0
    for (const line of diff.split(/\r?\n/)) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++
      if (line.startsWith('-') && !line.startsWith('---')) removed++
    }
  }
  return `新增 ${added} 行 · 移除 ${removed} 行`
}

// A glowing comet that rolls along the tool bubble border: a bright core plus a
// stack of nested, progressively shorter faint tails that fade out behind it.
// The perimeter is measured so the dash pattern tiles seamlessly; the core and
// total comet lengths as well as the lap duration are derived from that
// perimeter so the effect stays proportional on any bubble size.
const BEAM_TAIL_STEPS = 8

const ToolBeam = (): React.ReactElement => {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const box = el.getBoundingClientRect()
      const rx = 13
      const w = Math.max(2 * rx, box.width - 3)
      const h = Math.max(2 * rx, box.height - 3)
      const perimeter = 2 * (w - 2 * rx) + 2 * (h - 2 * rx) + 2 * Math.PI * rx
      const beam = Math.min(64, Math.max(12, perimeter * 0.06))
      const comet = Math.min(perimeter * 0.18, beam * 2.4)
      const duration = 0.0375 * Math.pow(perimeter, 0.45)
      el.style.setProperty('--hui-perimeter', perimeter.toFixed(2))
      el.style.setProperty('--hui-beam', beam.toFixed(1))
      el.style.setProperty('--hui-comet', comet.toFixed(1))
      el.style.setProperty('--hui-beam-duration', `${duration.toFixed(2)}s`)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return (
    <svg ref={ref} className="hui-tool-beam" aria-hidden="true">
      <g className="hui-tool-beam-tails">
        {Array.from({ length: BEAM_TAIL_STEPS }, (_, i) => (
          <rect
            key={i}
            className="hui-tool-beam-tail"
            style={{ '--hui-tail': `calc(var(--hui-comet, 150) * ${((i + 1) / BEAM_TAIL_STEPS).toFixed(4)})` } as CSSProperties}
          />
        ))}
      </g>
      <rect className="hui-tool-beam-core" />
    </svg>
  )
}

const PartView = memo(function PartView({ part, completed, textLimit }: { part: any; completed: boolean; textLimit?: number }): React.ReactElement | null {
  const done = completed || part.time?.end != null
  const toolKey = part.type === 'tool' ? String(part.tool ?? '').toLowerCase() : ''
  const toolRunning = part.type === 'tool'
    && (toolKey === 'bash' || toolColors[toolKey] === 'web')
    && (part.state ?? {}).status === 'running'
  const [flash, setFlash] = useState(false)
  const wasRunningRef = useRef(false)
  useEffect(() => {
    if (wasRunningRef.current && !toolRunning) setFlash(true)
    wasRunningRef.current = toolRunning
  }, [toolRunning])
  useEffect(() => {
    if (!flash) return
    const timer = setTimeout(() => setFlash(false), 800)
    return () => clearTimeout(timer)
  }, [flash])
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
    const toolColor = toolColors[toolKey] ?? 'default'
    const imageRead = isImageRead(toolName, state)
    const displayName = imageRead ? 'PicRead' : displayToolName(toolName)
    const bashRunning = toolKey === 'bash'
    const command = bashRunning && typeof state.input?.command === 'string' ? state.input.command : ''
    const toolTitle = bashRunning && command ? command : (state.title || command)
    const toolMetrics = toolName.toLowerCase() === 'read' ? readToolMetrics(state)
      : toolName.toLowerCase() === 'edit' ? editToolMetrics(state) : null
    if (toolName.toLowerCase() === 'question') return (
      <div className="hui-tool-call hui-question-tool" data-tool-color="default">
        <span className="hui-tool-name">Question</span>
        <span className="hui-tool-status">{state.status === 'completed' ? '已回答' : state.status === 'error' ? '已结束' : '等待回答'}</span>
        {state.title ? <span className="hui-tool-title">{String(state.title)}</span> : null}
      </div>
    )
    return (
      <details className="hui-tool-call" data-tool-color={toolColor} data-running={toolRunning} data-flash={flash}>
        <summary className="hui-tool-summary">
          {toolRunning ? <ToolBeam /> : null}
          <span className={`hui-tool-name${imageRead ? ' hui-pic-read' : ''}`}>{displayName}</span>
          <span className="hui-tool-status">
            {state.status ?? 'running'}
          </span>
          {toolTitle ? <span className="hui-tool-title" title={String(toolTitle)}>{toolTitle}</span> : null}
          {toolMetrics ? <span className="hui-tool-metrics">{toolMetrics}</span> : null}
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

// Folding a card taller than the viewport removes height above the reader, so
// the content below snaps up. The provider receives the collapsing card and
// glides the scroll position so that motion reads as a smooth scroll instead.
const CollapseScrollContext = createContext<((card: HTMLElement | null) => void) | null>(null)

const CallBlock = memo(function CallBlock({ messages, order, foldedByNext, visibleChars, liquidGlass, metrics }: {
  messages: MessageEntry[]
  metrics?: ReplyMetrics | null
  order: number
  foldedByNext: boolean
  visibleChars?: number
  liquidGlass: boolean
}): React.ReactElement {
  const msg = messages.length === 1 ? messages[0] : {
    info: messages[0].info,
    parts: messages.flatMap(message => message.parts)
  }
  const panelId = useId()
  const lens = useLiquidGlassSurface<HTMLElement>(liquidGlass)
  const [expanded, setExpanded] = useState(!foldedByNext)
  const previousFolded = useRef(foldedByNext)
  const collapseScroll = useContext(CollapseScrollContext)

  // Folding a card taller than the viewport drops height the reader cannot see,
  // which snaps the content below up. Tell the pane to glide the scroll instead.
  const collapse = (event: React.MouseEvent<HTMLButtonElement>): void => {
    collapseScroll?.(event.currentTarget.closest('.hui-call-block') as HTMLElement | null)
    setExpanded(false)
  }

  // React only to a new call boundary, not to every streamed delta. A user
  // may reopen an older block without the next update closing it again.
  useLayoutEffect(() => {
    if (previousFolded.current === foldedByNext) return
    previousFolded.current = foldedByNext
    setExpanded(!foldedByNext)
  }, [foldedByNext])

  const tools = new Map<string, { name: string; count: number; color: string; picRead: boolean }>()
  if (foldedByNext) {
    for (const part of msg.parts) {
      if (part.type !== 'tool') continue
      const name = String(part.tool ?? 'Tool')
      const imageRead = isImageRead(name, part.state)
      const key = imageRead ? 'picread' : name.toLowerCase()
      const existing = tools.get(key)
      if (existing) existing.count++
      else tools.set(key, { name: imageRead ? 'PicRead' : displayToolName(name), count: 1, color: toolColors[name.toLowerCase()] ?? 'default', picRead: imageRead })
    }
  }
  return (
    <section ref={lens.ref} style={lens.style} className={`hui-call-block ${liquidGlass ? 'glass-liquid' : ''} ${foldedByNext ? 'is-step' : 'is-active'}`} data-expanded={expanded} data-message-id={msg.info?.id}>
      {lens.filter}
      {foldedByNext ? (
        <button className="hui-call-header" type="button" aria-expanded={expanded} aria-controls={panelId} onClick={(event) => { if (expanded) collapse(event); else setExpanded(true) }}>
          <span className="hui-call-chevron" aria-hidden="true" />
          <span className="hui-call-heading">步骤 {order}</span>
          {tools.size > 0 ? (
            <span className="hui-call-meta">
              调用了 {Array.from(tools, ([key, tool], index) => (
                <span key={key} className="hui-step-tool" data-tool-color={tool.color}>{index > 0 ? '，' : ''}{tool.count}次 <span className={tool.picRead ? 'hui-step-tool-name hui-pic-read' : 'hui-step-tool-name'}>{tool.name}</span></span>
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
      {metrics && !foldedByNext ? <ReplyDetails metrics={metrics} /> : null}
      {foldedByNext && expanded ? (
        <div className="hui-call-foot">
          <button className="hui-call-collapse" type="button" aria-label="收起步骤" title="收起" onClick={collapse}>
            <span className="hui-call-chevron" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </section>
  )
}, (previous, next) => previous.order === next.order
  && previous.foldedByNext === next.foldedByNext
  && previous.visibleChars === next.visibleChars
  && previous.liquidGlass === next.liquidGlass
  && (previous.metrics === next.metrics || (!!previous.metrics && !!next.metrics
    && previous.metrics.model === next.metrics.model && previous.metrics.provider === next.metrics.provider
    && previous.metrics.seconds === next.metrics.seconds && previous.metrics.speed === next.metrics.speed
    && previous.metrics.firstTokenSeconds === next.metrics.firstTokenSeconds
    && previous.metrics.tokens === next.metrics.tokens))
  && previous.messages.length === next.messages.length
  && previous.messages.every((message, index) => message === next.messages[index]))

const stepRangeSize = 10
const recentCallCount = 4

// A compaction message is a kernel-generated assistant summary; it has no user
// echo, so it must not join a normal reply turn.
const isCompactionMessage = (message: MessageEntry): boolean =>
  message.info?.role === 'assistant' && message.info?.summary === true

// Kernel-driven compaction gets one centered bubble. It mirrors the reply wait
// lifecycle ("等待会话压缩" -> streamed summary) through ReplyPresentation, then
// folds into a step-style card ("会话已压缩") the reader can reopen.
const CompactionBlock = memo(function CompactionBlock({ msg, liquidGlass }: {
  msg: MessageEntry
  liquidGlass: boolean
}): React.ReactElement {
  const panelId = useId()
  const completed = msg.info?.time?.completed != null
  const hasText = msg.parts.some(hasVisiblePart)
  const [expanded, setExpanded] = useState(!completed)
  const lens = useLiquidGlassSurface<HTMLElement>(liquidGlass && completed)
  const collapseScroll = useContext(CollapseScrollContext)
  // A freshly completed summary collapses with the shared step animation; a
  // summary loaded from history mounts already folded, without replaying it.
  useEffect(() => { if (completed) setExpanded(false) }, [completed])

  const collapse = (event: React.MouseEvent<HTMLButtonElement>): void => {
    collapseScroll?.(event.currentTarget.closest('.hui-call-block') as HTMLElement | null)
    setExpanded(false)
  }

  if (!completed) {
    return (
      <ReplyPresentation waiting={!hasText} waitLabel="等待会话压缩" center wideWait liquidGlass={liquidGlass}>
        <div className="hui-compaction-body"><MessageView msg={msg} inReply /></div>
      </ReplyPresentation>
    )
  }
  return (
    <section ref={lens.ref} style={lens.style} className={`hui-call-block is-step hui-compaction ${liquidGlass ? 'glass-liquid' : ''}`} data-expanded={expanded} data-message-id={msg.info?.id}>
      <button className="hui-call-header" type="button" aria-expanded={expanded} aria-controls={panelId} onClick={(event) => { if (expanded) collapse(event); else setExpanded(true) }}>
        <span className="hui-call-chevron" aria-hidden="true" />
        <span className="hui-call-heading">会话已压缩</span>
        <span className="hui-call-state">{expanded ? '收起' : '展开'}</span>
      </button>
      <div className="hui-call-reveal" aria-hidden={!expanded} inert={!expanded}>
        <div id={panelId} className="hui-call-content">
          <MessageView msg={msg} inReply />
        </div>
      </div>
      {expanded ? (
        <div className="hui-call-foot">
          <button className="hui-call-collapse" type="button" aria-label="收起压缩摘要" title="收起" onClick={collapse}>
            <span className="hui-call-chevron" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </section>
  )
})

function StepRange({ groups, start, liquidGlass, onExpand }: {
  groups: MessageEntry[][]
  start: number
  liquidGlass: boolean
  onExpand: () => void
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [mounted, setMounted] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const measureStack = (): void => {
    const content = contentRef.current
    if (!content) return
    const items = Array.from(content.children as HTMLCollectionOf<HTMLElement>)
    const tops = items.map(item => item.offsetTop)
    for (const [index, item] of items.entries()) {
      // Every card leaves the card immediately above it. A different origin
      // after the third card creates a visible break in the cascade.
      const travel = index === 0 ? Math.max(0, tops[0] - 3) : tops[index] - tops[index - 1]
      item.style.setProperty('--range-start', `${-travel}px`)
    }
  }
  useLayoutEffect(() => {
    if (!mounted) return
    // Measure the distance between neighbors so expanded child steps still
    // return to the card immediately above them when the range closes.
    measureStack()
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        setPreparing(false)
        setExpanded(true)
      })
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      window.cancelAnimationFrame(secondFrame)
    }
  }, [mounted])
  useEffect(() => {
    if (expanded || !mounted) return
    const timer = window.setTimeout(() => setMounted(false), 760)
    return () => window.clearTimeout(timer)
  }, [expanded, mounted])

  const tools = new Map<string, { name: string; count: number; color: string; picRead: boolean }>()
  for (const messages of groups) for (const message of messages) for (const part of message.parts) {
    if (part.type !== 'tool') continue
    const name = String(part.tool ?? 'Tool')
    const picRead = isImageRead(name, part.state)
    const key = picRead ? 'picread' : name.toLowerCase()
    const existing = tools.get(key)
    if (existing) existing.count++
    else tools.set(key, { name: toolDisplayName(name, part.state), count: 1, color: toolColors[name.toLowerCase()] ?? 'default', picRead })
  }
  const topTools = [...tools.values()].sort((a, b) => b.count - a.count).slice(0, 3)
  const remainingKinds = Math.max(0, tools.size - topTools.length)

  return (
    <section className="hui-step-range" data-start={start + 1} data-end={start + groups.length} data-expanded={expanded} data-preparing={preparing}>
      <button className="hui-step-range-header" type="button" aria-expanded={expanded} aria-controls={panelId}
        onClick={() => {
          if (expanded) { measureStack(); setExpanded(false) }
          else {
            onExpand()
            if (mounted) { setPreparing(false); setExpanded(true) }
            else { setPreparing(true); setMounted(true) }
          }
        }}>
        <span className="hui-call-chevron" aria-hidden="true" />
        <span className="hui-call-heading">步骤 {start + 1}–{start + groups.length}</span>
        <span className="hui-call-meta">{groups.length} 步{topTools.length ? ' · ' : ''}{topTools.map((tool, index) => (
          <span key={tool.name} className="hui-step-tool" data-tool-color={tool.color}>{index ? '，' : ''}{tool.count}次 <span className={tool.picRead ? 'hui-step-tool-name hui-pic-read' : 'hui-step-tool-name'}>{tool.name}</span></span>
        ))}{remainingKinds ? `，另 ${remainingKinds} 种` : ''}</span>
        <span className="hui-call-state">{expanded ? '收起' : '展开'}</span>
      </button>
      <div className="hui-step-range-reveal" aria-hidden={!expanded} inert={!expanded}>
        <div id={panelId} ref={contentRef} className="hui-step-range-content">
          {mounted ? groups.map((messages, index) => (
            <div className="hui-step-range-item" style={{
              '--range-index': index,
              '--range-move-delay': `${index * 18}ms`
            } as CSSProperties} key={messages[0].info?.id ?? start + index}>
              <CallBlock messages={messages} order={start + index + 1} foldedByNext liquidGlass={liquidGlass} />
            </div>
          )) : null}
        </div>
      </div>
    </section>
  )
}

function StepList({ groups, visibleChars, liquidGlass, canCompact, onExpandRange, metrics }: {
  groups: MessageEntry[][]
  metrics?: ReplyMetrics | null
  visibleChars?: number
  liquidGlass: boolean
  canCompact: boolean
  onExpandRange: () => void
}): React.ReactElement {
  // Sliding compaction: the newest calls stay individual, and every older call
  // is absorbed into the trailing range as soon as a new call arrives, so the
  // reader sees "步骤 1–2" grow to "步骤 1–3" one step at a time. A range
  // needs at least two steps, and new compaction is postponed while history
  // is read.
  const eligible = groups.length - recentCallCount >= 2 ? groups.length - recentCallCount : 0
  const [compacted, setCompacted] = useState(eligible)
  useLayoutEffect(() => {
    if (eligible < compacted || (canCompact && eligible > compacted)) setCompacted(eligible)
  }, [eligible, compacted, canCompact])

  const items: React.ReactNode[] = []
  // Ranges stay capped near stepRangeSize so expanding one never mounts a huge
  // stack; a lone leftover step merges into the previous range instead of
  // becoming a "步骤 N–N" summary of its own.
  for (let start = 0; start < compacted; ) {
    const remaining = compacted - start
    const size = remaining > stepRangeSize + 1 ? stepRangeSize : remaining
    items.push(<StepRange key={`range-${start}`} groups={groups.slice(start, start + size)} start={start} liquidGlass={liquidGlass} onExpand={onExpandRange} />)
    start += size
  }
  for (let index = compacted; index < groups.length; index++) {
    const messages = groups[index]
    items.push(<CallBlock key={messages[0].info?.id ?? index} messages={messages} order={index + 1} foldedByNext={index < groups.length - 1} metrics={index === groups.length - 1 ? metrics : null} visibleChars={index === groups.length - 1 ? visibleChars : undefined} liquidGlass={liquidGlass} />)
  }
  return <>{items}</>
}

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
  const [panelPos, setPanelPos] = useState<{ left: number; bottom: number } | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const selectedIndex = options.findIndex(option => option.value === value)
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!root.current?.contains(target) && !panelRef.current?.contains(target)) setOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  // The composer's own backdrop-filter makes it a Backdrop Root, so a panel
  // inside it could only blur the composer itself. Portaling to the body lets
  // the panel's frost sample the conversation behind it.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const trigger = triggerRef.current
    const place = (): void => {
      const rect = trigger.getBoundingClientRect()
      const width = panelRef.current?.offsetWidth || 0
      const left = Math.min(Math.max(12, rect.left), Math.max(12, window.innerWidth - width - 12))
      setPanelPos({ left, bottom: window.innerHeight - rect.top + 10 })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])
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
        ref={triggerRef}
        className="hui-picker-trigger">
        <span className="truncate">{options[selectedIndex]?.label ?? empty}</span><svg className="hui-picker-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9.5l6 6 6-6" /></svg>
      </button>
      {createPortal(
        <div ref={panelRef} id={listId} role="listbox" aria-label={title} className="hui-picker-panel glass no-drag" data-open={open}
          style={{ ...plainGlassFilter, left: panelPos?.left ?? -9999, bottom: panelPos?.bottom ?? -9999 }}>
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
        </div>,
        document.body
      )}
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
  const [unlimitedPermissions, setUnlimitedPermissions] = useState(() => {
    try { return localStorage.getItem('hui.unlimitedPermissions') === 'true' } catch { return false }
  })
  const { dialog: permissionDialog, receive: receivePermission, reload: reloadPermissions } = usePermissions(server?.status === 'ready' ? server.url : undefined, workspace, activeId, unlimitedPermissions)
  useEffect(() => {
    try { localStorage.setItem('hui.unlimitedPermissions', String(unlimitedPermissions)) } catch { /* Keep the preference for this window. */ }
  }, [unlimitedPermissions])
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
  // Track busy per session so switching to an idle session shows "发送" instead
  // of leaking another session's "停止" state; switching back restores it.
  const [busySessions, setBusySessions] = useState<ReadonlySet<string>>(() => new Set<string>())
  const busy = activeId !== null && busySessions.has(activeId)
  const markSessionBusy = useCallback((id: string | null | undefined, value: boolean): void => {
    if (!id) return
    setBusySessions(previous => {
      if (value === previous.has(id)) return previous
      const next = new Set(previous)
      if (value) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  const sendingRef = useRef(false)
  const [observations] = useState(() => {
    try { return new StreamObservations(window.localStorage) } catch { return new StreamObservations() }
  })
  // Compaction is driven by the kernel, not a submitted prompt, so it gets its
  // own centered bubble instead of a user echo plus a reply turn.
  const [compactingSessionId, setCompactingSessionId] = useState<string | null>(null)
  const compactionKnownIds = useRef(new Set<string>())
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
  const [selectedVariant, setSelectedVariant] = useState<string | null>(null)
  const [agents, setAgents] = useState<any[]>([])
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [commands, setCommands] = useState<CommandOption[]>([])
  const [slashHighlight, setSlashHighlight] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [followingReply, setFollowingReply] = useState(true)

  const clientRef = useRef<any>(null)
  const workspaceRef = useRef<string | null>(null)
  const choosingWorkspaceRef = useRef(false)
  const clientBase = useRef<string | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const composerDockRef = useRef<HTMLDivElement | null>(null)
  const stickBottom = useRef(true)
  const userScrolling = useRef(false)
  const rangeReading = useRef(false)
  const collapseScrollFrame = useRef<number | null>(null)
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

  const activeVariants = useMemo(() => {
    if (!selectedModel) return []
    return models.find(m => m.providerID === selectedModel.providerID && m.modelID === selectedModel.modelID)?.variants ?? []
  }, [models, selectedModel])

  // Slash commands open a frosted menu while the user is still typing the
  // command name (there is no whitespace yet). Escape hides it until the next
  // edit, and completing an entry keeps the textarea focused for arguments.
  const slashMatch = /^\/(\S*)$/.exec(input)
  const slashQuery = slashMatch ? slashMatch[1].toLowerCase() : null
  const slashResults = useMemo(() => slashQuery === null
    ? []
    : commands.filter(command => command.name.toLowerCase().includes(slashQuery)).slice(0, 8),
    [slashQuery, commands])
  const slashOpen = slashQuery !== null && !slashDismissed && slashResults.length > 0

  useEffect(() => { setSlashHighlight(0) }, [slashQuery, commands])
  useEffect(() => { setSlashDismissed(false) }, [input])

  const applyCommand = (command: CommandOption): void => {
    if (command.builtin) { void runBuiltin(command.name); return }
    setInput(`/${command.name} `)
    setSlashDismissed(true)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

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
          const rawVariants = (m as any)?.variants as Record<string, any> | undefined
          const variants = rawVariants
            ? Object.entries(rawVariants)
                .filter(([, option]) => !(option && typeof option === 'object' && (option as any).disabled))
                .map(([name]) => name)
            : []
          list.push({
            providerID: p.id,
            providerName: p.name ?? p.id,
            modelID: mid,
            modelName: (m as any)?.name ?? mid,
            contextLimit: Number((m as any)?.limit?.context) || 0,
            outputLimit: Number((m as any)?.limit?.output) || 0,
            variants
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

      const chosenVariants = chosen
        ? (list.find(x => x.providerID === chosen!.providerID && x.modelID === chosen!.modelID)?.variants ?? [])
        : []
      const savedVariant = localStorage.getItem('hui.variant')
      setSelectedVariant(savedVariant && chosenVariants.includes(savedVariant) ? savedVariant : null)

      const savedAgent = localStorage.getItem('hui.agent')
      const defAgent =
        savedAgent && primary.some((a: any) => a.name === savedAgent)
          ? savedAgent
          : (primary.find((a: any) => a.name === 'build')?.name ?? primary[0]?.name ?? null)
      setSelectedAgent(defAgent)

      try {
        const cmdRes = await c.command.list({ query: { directory: workspaceRef.current ?? undefined } })
        if (c !== clientRef.current) return
        const builtinNames = new Set(builtinCommands.map(command => command.name))
        const loaded: CommandOption[] = (unwrap(cmdRes) ?? [])
          .filter((cmd: any) => typeof cmd?.name === 'string' && cmd.name.length > 0)
          .map((cmd: any) => ({ name: cmd.name, description: cmd.description }))
        setCommands([...builtinCommands, ...loaded.filter(command => !builtinNames.has(command.name))])
      } catch (e) {
        console.error('load commands failed', e)
      }
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
    if (workspaceRef.current) observations.receive(workspaceRef.current, 'session.deleted', { info: { id } })
    deletedSessions.current.add(id)
    setSessions(previous => previous.filter(session => session.id !== id))
    setSessionMenu(previous => previous?.id === id ? null : previous)
    markSessionBusy(id, false)
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
      setLastError(null)
      stickBottom.current = true
      rangeReading.current = false
      setFollowingReply(true)
    }
  }, [clearEvents, markSessionBusy])

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
    observations.disconnect()
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
    setCommands([])
    setSlashDismissed(false)
    setBusySessions(new Set<string>())
    setInput('')
    setLastError(null)
    stickBottom.current = true
    rangeReading.current = false
    setFollowingReply(true)
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
    es.onopen = () => { if (clientRef.current === client) void reloadPermissions() }
    es.onerror = () => { if (clientRef.current === client) observations.disconnect() }
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
      observations.receive(workspace, t, p)
      const active = activeIdRef.current
      if (t === 'permission.asked' || t === 'permission.replied') receivePermission(t, p)

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
          if (p.sessionID) markSessionBusy(p.sessionID, false)
          if (active && p.sessionID === active) {
            flushEvents()
            refreshMessages()
          }
          break
        }
        case 'session.error': {
          if (p.sessionID) markSessionBusy(p.sessionID, false)
          if (active && p.sessionID === active) {
            const message =
              p?.error?.data?.message ?? p?.error?.message ?? p?.error?.name ?? '未知错误'
            setLastError(String(message))
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
      observations.disconnect()
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
    resetWorkspaceView,
    receivePermission,
    reloadPermissions,
    markSessionBusy
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

  // Reserve space inside the content flow, including a clear gap above the
  // floating composer. Reapply the bottom position when the dock grows.
  useLayoutEffect(() => {
    const el = scrollRef.current
    const dock = composerDockRef.current
    if (!el || !dock) return
    const apply = (): void => {
      el.style.setProperty('--hui-composer-reserve', `${Math.ceil(dock.getBoundingClientRect().height) + 12}px`)
      if (stickBottom.current) el.scrollTop = el.scrollHeight
    }
    const observer = new ResizeObserver(apply)
    observer.observe(dock)
    apply()
    return () => {
      observer.disconnect()
      el.style.removeProperty('--hui-composer-reserve')
    }
  }, [])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    if (rangeReading.current && !userScrolling.current) return
    if (userScrolling.current) rangeReading.current = false
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    // Height changes/programmatic scrolling also emit scroll events. They must
    // not disable following the reply before the ResizeObserver can catch up.
    if (atBottom || userScrolling.current) {
      stickBottom.current = atBottom
      setFollowingReply(atBottom)
    }
    userScrolling.current = false
  }

  // Folding a card taller than the pane drops height that is scrolled above the
  // viewport, so with scroll anchoring off the content below snaps upward. This
  // tracks the card's animating height and moves the scroll up by the same
  // amount each frame, turning that snap into a smooth scroll. It is skipped at
  // the bottom (the ResizeObserver already follows) and when the card top is in
  // view (the fold is already an in-place motion).
  const adjustScrollForCollapse = useCallback((card: HTMLElement | null): void => {
    const el = scrollRef.current
    if (!el || !card) return
    if (collapseScrollFrame.current !== null) { cancelAnimationFrame(collapseScrollFrame.current); collapseScrollFrame.current = null }
    if (stickBottom.current) return
    const containerTop = el.getBoundingClientRect().top
    if (card.getBoundingClientRect().top >= containerTop - 1) return
    const startTop = el.scrollTop
    const startHeight = card.getBoundingClientRect().height
    const started = performance.now()
    const follow = (now: number): void => {
      if (!card.isConnected) { collapseScrollFrame.current = null; return }
      const collapsed = Math.max(0, startHeight - card.getBoundingClientRect().height)
      el.scrollTop = Math.max(0, startTop - collapsed)
      collapseScrollFrame.current = now - started < 520 ? requestAnimationFrame(follow) : null
    }
    collapseScrollFrame.current = requestAnimationFrame(follow)
  }, [])

  useEffect(() => () => {
    if (collapseScrollFrame.current !== null) cancelAnimationFrame(collapseScrollFrame.current)
  }, [])

  useEffect(() => {
    if (selectedModel) localStorage.setItem('hui.model', JSON.stringify(selectedModel))
  }, [selectedModel])

  useEffect(() => {
    if (selectedAgent) localStorage.setItem('hui.agent', selectedAgent)
  }, [selectedAgent])

  useEffect(() => {
    try {
      if (selectedVariant) localStorage.setItem('hui.variant', selectedVariant)
      else localStorage.removeItem('hui.variant')
    } catch { /* Preference only. */ }
  }, [selectedVariant])

  const newSession = async (): Promise<void> => {
    const c = clientRef.current
    if (!c) return
    try {
      const r = await c.session.create({ body: {}, throwOnError: true })
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
    if ((!text && attachments.length === 0) || !c || !server?.url || busy || sendingRef.current) return

    // A leading slash runs a configured command instead of a plain prompt.
    const commandMatch = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text)
    const command = commandMatch
      ? commands.find(item => item.name.toLowerCase() === commandMatch[1].toLowerCase())
      : undefined
    if (command && attachments.length > 0) {
      setLastError('斜杠命令不支持同时发送附件')
      return
    }

    const body: any = { parts: [
      ...(text ? [{ type: 'text', text }] : []),
      ...attachments.map(file => ({ type: 'file', mime: file.mime, filename: file.name, url: file.url }))
    ] }
    if (selectedModel) body.model = selectedModel
    if (selectedAgent) body.agent = selectedAgent
    if (selectedVariant) body.variant = selectedVariant

    beforeRequestUserId.current = [...visibleMessages].reverse().find((message) => message.info?.role === 'user')?.info?.id ?? null
    pendingTurnKey.current = `reply-request-${++turnKeySequence.current}`
    const requestId = activeIdRef.current
    markSessionBusy(requestId, true)
    sendingRef.current = true
    setLastError(null)
    stickBottom.current = true
    rangeReading.current = false
    setFollowingReply(true)

    let observedSession: string | null = null
    try {
      let id = activeIdRef.current
      if (!id) {
        const r = await c.session.create({ body: {}, throwOnError: true })
        if (c !== clientRef.current) return
        const s = unwrap(r)
        id = s?.id ?? null
        if (id) {
          clearEvents()
          setActiveId(id)
          activeIdRef.current = id
          markSessionBusy(id, true)
          setMessages([])
          await loadSessions()
        }
      }
      if (c !== clientRef.current) return
      if (!id) { markSessionBusy(requestId, false); return }
      if (workspaceRef.current) {
        observations.begin(workspaceRef.current, id, beforeRequestUserId.current)
        observedSession = id
      }
      if (command) {
        await c.session.command({ path: { id }, body: { command: command.name, arguments: commandMatch?.[2] ?? '', ...(selectedVariant ? { variant: selectedVariant } : {}) }, throwOnError: true })
      } else {
        await c.session.promptAsync({ path: { id }, body, throwOnError: true })
      }
      if (c === clientRef.current && id === activeIdRef.current) {
        setInput(previous => previous === input ? '' : previous)
        setAttachments(previous => previous.filter(file => !attachments.some(sent => sent.id === file.id)))
        setReverted(previous => previous?.sessionId === id ? { ...previous, restoreAvailable: false } : previous)
      }
    } catch (e) {
      if (c !== clientRef.current) return
      if (workspaceRef.current && observedSession) observations.finish(workspaceRef.current, observedSession)
      setLastError(`发送失败：${e instanceof Error ? e.message : String(e)}`)
      markSessionBusy(requestId, false)
    } finally {
      sendingRef.current = false
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
      markSessionBusy(sessionId, false)
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

  // Context occupancy: find the latest assistant message that actually reported
  // token usage. A fresh assistant entry or a step before its first usage event
  // carries an empty/zero `tokens` report; treating that as real usage is what
  // made the meter flicker between a number and 0.
  const contextUsage = useMemo(() => {
    const total = (tokens: any): number => tokens
      ? Number(tokens.input ?? 0) + Number(tokens.output ?? 0) + Number(tokens.cache?.read ?? 0) + Number(tokens.cache?.write ?? 0)
      : 0
    const last = [...visibleMessages].reverse().find(message =>
      message.info?.role === 'assistant' && total(message.info?.tokens) > 0)
    const used = total(last?.info?.tokens)
    // Prefer the model that produced the last reply over whatever is currently
    // selected in the composer: sessions may each use a different model.
    const providerID = last?.info?.providerID ?? selectedModel?.providerID
    const modelID = last?.info?.modelID ?? selectedModel?.modelID
    const max = models.find(model => model.providerID === providerID && model.modelID === modelID)?.contextLimit ?? 0
    const percent = max > 0 ? Math.min(100, (used / max) * 100) : 0
    return { used, max, percent }
  }, [visibleMessages, models, selectedModel])

  const contextLevel = contextUsage.percent >= 90 ? 'high' : contextUsage.percent >= 70 ? 'medium' : 'low'
  const contextPercentLabel = contextUsage.max > 0
    ? `${contextUsage.percent >= 10 ? Math.round(contextUsage.percent) : contextUsage.percent >= 0.5 ? contextUsage.percent.toFixed(1) : 0}%`
    : '—'

  const lastUser = [...visibleMessages].reverse().find((message) => message.info?.role === 'user')
  const awaitingUserEcho = busy && (lastUser?.info?.id ?? null) === beforeRequestUserId.current
  if (busy && !awaitingUserEcho && lastUser?.info?.id && pendingTurnKey.current) {
    if (!turnKeys.current.has(lastUser.info.id)) turnKeys.current.set(lastUser.info.id, pendingTurnKey.current)
  }

  // Keep each turn at one stable React position. Moving an older reply into a
  // different parent would remount its Worker-rendered Markdown on every send.
  const conversation: React.ReactNode[] = []
  let turnReplies: MessageEntry[] = []
  let turnUser: MessageEntry | null = null
  let turnKey = 'reply-initial'
  const appendReply = (waiting: boolean): void => {
    const visible = turnReplies.some((message) => message.parts.some(hasVisiblePart))
    if (!visible && !waiting) return
    const replies = turnReplies.filter(message => message.parts.some(hasVisiblePart))
    const groups: MessageEntry[][] = []
    for (const message of replies) {
      const parts = message.parts.filter(hasVisiblePart)
      if (groups.length > 0 && parts.every(part => part.type === 'tool')) groups[groups.length - 1].push(message)
      else groups.push([message])
    }
    const textLength = groups.at(-1)?.flatMap(group => group.parts).reduce((count, part) =>
      count + ((part.type === 'text' || part.type === 'reasoning') ? (part.text?.length ?? 0) : 0), 0) ?? 0
    const observed = workspace && activeId ? observations.metrics(workspace, activeId, turnReplies) : undefined
    const metrics = waiting ? null : replyMetrics(turnUser, turnReplies, observed)
    conversation.push(
      <ReplyPresentation key={turnKey} waiting={waiting && !visible} textLength={textLength} liquidGlass={liquidGlass}>
        {(visibleChars) => <StepList groups={groups} metrics={metrics} visibleChars={visibleChars} liquidGlass={liquidGlass} canCompact={followingReply} onExpandRange={() => { rangeReading.current = true; stickBottom.current = false; setFollowingReply(false) }} />}
      </ReplyPresentation>
    )
  }
  const compactingActive = compactingSessionId !== null && compactingSessionId === activeId
  const compactionArrived = visibleMessages.some(message => isCompactionMessage(message) && !compactionKnownIds.current.has(message.info?.id))
  for (const [index, message] of visibleMessages.entries()) {
    if (message.info?.role === 'user') {
      appendReply(false)
      conversation.push(<MessageView key={message.info?.id ?? `user-${index}`} msg={message} liquidGlass={liquidGlass} onCopyError={setLastError} onRevert={revertMessage} reverting={revertingId === message.info?.id} revertDisabled={revertingId !== null} />)
      turnKey = turnKeys.current.get(message.info?.id) ?? `reply-${message.info?.id ?? index}`
      turnReplies = []
      turnUser = message
    } else if (isCompactionMessage(message)) {
      // Close the current turn so the centered compaction card stands alone,
      // then advance the turn key so a following reply turn cannot reuse it.
      appendReply(false)
      conversation.push(<CompactionBlock key={message.info?.id ?? `compaction-${index}`} msg={message} liquidGlass={liquidGlass} />)
      turnKey = `reply-${message.info?.id ?? index}`
      turnReplies = []
      turnUser = null
    } else {
      turnReplies.push(message)
    }
  }
  appendReply(busy && !awaitingUserEcho && !compactingActive)
  if (busy && awaitingUserEcho && !compactingActive) {
    conversation.push(<ReplyPresentation key={pendingTurnKey.current ?? 'reply-pending'} waiting liquidGlass={liquidGlass} />)
  }
  // Compaction is kernel-driven: no user echo precedes it, so show a centered
  // wait bubble until the summary message itself arrives.
  if (compactingActive && !compactionArrived) {
    conversation.push(<ReplyPresentation key="compaction-pending" waiting waitLabel="等待会话压缩" center wideWait liquidGlass={liquidGlass} />)
  }

  // Runs a client-side built-in command immediately: these take no arguments,
  // so selecting one from the slash menu executes instead of completing text.
  const runBuiltin = async (name: string): Promise<void> => {
    if (busy || !server?.url) return
    setSlashDismissed(true)
    setInput('')
    setLastError(null)
    const c = clientRef.current
    const sessionId = activeIdRef.current
    if (name === 'new') { await newSession(); return }
    if (!c || !sessionId) { setLastError('请先开始一段对话再使用该命令'); return }
    if (name === 'compact') {
      if (!selectedModel) { setLastError('请先选择模型再压缩上下文'); return }
      markSessionBusy(sessionId, true)
      setCompactingSessionId(sessionId)
      compactionKnownIds.current = new Set(visibleMessages.filter(isCompactionMessage).map(message => message.info?.id).filter((id): id is string => !!id))
      try {
        await c.session.summarize({ path: { id: sessionId }, body: selectedModel, throwOnError: true })
        if (c === clientRef.current && sessionId === activeIdRef.current) refreshMessages()
      } catch (error) {
        if (c === clientRef.current) setLastError(`压缩失败：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        if (c === clientRef.current) markSessionBusy(sessionId, false)
        setCompactingSessionId(current => current === sessionId ? null : current)
      }
      return
    }
    if (name === 'undo') {
      if (!lastUser) { setLastError('没有可撤回的用户消息'); return }
      await revertMessage(lastUser)
      return
    }
    if (name === 'redo') {
      if (!(reverted && reverted.sessionId === activeId)) { setLastError('当前没有可恢复的撤回'); return }
      await restoreReverted()
    }
  }

  // Falls through to a normal prompt (which itself may dispatch a
  // user-defined `/command`) when the input is not a built-in command.
  const submit = async (): Promise<void> => {
    const match = /^\/(\S+)(?:\s+[\s\S]*)?$/.exec(input.trim())
    const builtin = match ? builtinCommands.find(item => item.name === match[1].toLowerCase()) : undefined
    if (!builtin) { await send(); return }
    await runBuiltin(builtin.name)
  }

  return (
    <CollapseScrollContext.Provider value={adjustScrollForCollapse}>
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
          <span className="font-semibold tracking-wide text-white/90">Huarnessy</span>
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${statusColor}`}
            title={server?.status === 'ready'
              ? `已连接 :${server.port}${server.version ? ` · v${server.version}` : ''}`
              : server?.status === 'error'
                ? '启动失败'
                : '正在启动 opencode…'}
          />
          <div ref={settingsRef} className="relative no-drag">
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
              <div id="hui-appearance-settings" className="glass hui-settings-panel absolute left-0 top-9 w-72 rounded-xl p-4 shadow-2xl">
                <div className="mb-3 text-sm font-semibold text-white/90">设置</div>
                <div className="hui-unlimited-permissions mb-4 rounded-lg border p-3">
                  <label className="flex cursor-pointer items-center justify-between gap-3 text-xs font-semibold">
                    <span>默认无限权限</span>
                    <input type="checkbox" aria-label="默认无限权限" checked={unlimitedPermissions} onChange={event => setUnlimitedPermissions(event.target.checked)} className="hui-liquid-toggle" />
                  </label>
                  <p className="mt-2 text-[11px] leading-relaxed">开启后自动放行当前工作空间内所有会话的工具权限请求，包括访问工作空间外的文件和执行命令。</p>
                </div>
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
                  <input type="checkbox" aria-label="对话气泡折射" checked={liquidGlass} onChange={event => setLiquidGlass(event.target.checked)} className="hui-liquid-toggle" />
                </label>
              </div>
            ) : null}
          </div>
        </div>
        <div className="no-drag flex items-center gap-1">
          <div
            className="hui-context-meter no-drag"
            role="status"
            data-level={contextLevel}
            aria-label={`上下文占用 ${contextPercentLabel}`}
            title={contextUsage.max > 0
              ? `上下文：已用 ${contextUsage.used.toLocaleString()} / 上限 ${contextUsage.max.toLocaleString()} tokens`
              : '当前模型未提供上下文上限'}
          >
            <svg className="hui-context-ring" viewBox="0 0 36 36" aria-hidden="true">
              <circle className="hui-context-ring-track" cx="18" cy="18" r={contextRingRadius} />
              <circle
                className="hui-context-ring-fill"
                cx="18"
                cy="18"
                r={contextRingRadius}
                strokeDasharray={contextRingCircumference}
                strokeDashoffset={contextRingCircumference * (1 - contextUsage.percent / 100)}
              />
            </svg>
            <span className="hui-context-percent">{contextPercentLabel}</span>
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
                  title={sessionLabel(s.title)}
                >
                  {deletingId === s.id ? '正在删除…' : sessionLabel(s.title)}
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
              if (event.deltaY < 0) { stickBottom.current = false; setFollowingReply(false) }
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
            <div ref={contentRef} className={`hui-chat-content space-y-4 ${visibleMessages.length === 0 && !busy ? 'h-full' : ''}`}>
              {visibleMessages.length === 0 && !busy ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-white/40">
                  <div className="text-lg font-medium text-white/60">开始一段对话</div>
                  <div className="text-xs">在下方输入内容，回车发送 · 支持 Markdown 与 LaTeX</div>
                </div>
              ) : conversation}
            </div>
          </div>

          <div ref={composerDockRef} className="hui-composer-dock">
            <div className="mx-auto w-full max-w-[684px]">
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
            <div className="relative">
            <div className="hui-composer glass-soft rounded-[20px] p-2" data-dragging={draggingFiles}
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
                  if (slashOpen) {
                    const last = slashResults.length - 1
                    const current = Math.min(slashHighlight, last)
                    if (e.key === 'ArrowDown') { e.preventDefault(); setSlashHighlight((current + 1) % slashResults.length); return }
                    if (e.key === 'ArrowUp') { e.preventDefault(); setSlashHighlight((current - 1 + slashResults.length) % slashResults.length); return }
                    if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); applyCommand(slashResults[current]); return }
                    if (e.key === 'Escape') { e.preventDefault(); setSlashDismissed(true); return }
                  }
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    void submit()
                  }
                }}
                rows={1}
                placeholder={
                  server?.status === 'ready'
                    ? '输入消息… (Enter 发送 / Shift+Enter 换行 / 输入 / 使用命令)'
                    : '等待 opencode 启动…'
                }
                disabled={server?.status !== 'ready' || !workspace}
                className="hui-composer-textarea min-h-[64px] w-full resize-none bg-transparent px-3 py-1.5 text-[13.5px] text-white/90 outline-none placeholder:text-white/35 disabled:opacity-50"
              />
              <div className="mt-1 flex items-center gap-2 px-0.5">
                <input ref={fileInputRef} type="file" multiple className="hidden" onChange={event => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
                <button type="button" title="添加图片或文件" aria-label="添加图片或文件" disabled={server?.status !== 'ready' || !workspace} onClick={() => fileInputRef.current?.click()} className="hui-attach-button">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                  </svg>
                </button>
                <GlassSelect
                  value={selectedAgent ?? ''}
                  onChange={setSelectedAgent}
                  title="Agent"
                  disabled={agents.length === 0 || server?.status !== 'ready'}
                  empty="agent…"
                  options={agents.map(agent => ({ value: agent.name, label: agent.name.charAt(0).toUpperCase() + agent.name.slice(1) }))}
                />

                <GlassSelect
                  value={selectedModel ? `${selectedModel.providerID}/${selectedModel.modelID}` : ''}
                  onChange={(v) => {
                    const idx = v.indexOf('/')
                    if (idx > 0) {
                      setSelectedModel({ providerID: v.slice(0, idx), modelID: v.slice(idx + 1) })
                      setSelectedVariant(null)
                    }
                  }}
                  title="模型"
                  disabled={models.length === 0 || server?.status !== 'ready'}
                  empty="加载模型…"
                  options={modelGroups.flatMap(([, items]) => items.map(model => ({ value: `${model.providerID}/${model.modelID}`, label: model.modelName, group: model.providerName })))}
                />

                <GlassSelect
                  value={selectedVariant ?? ''}
                  onChange={(v) => setSelectedVariant(v || null)}
                  title="思考等级"
                  disabled={activeVariants.length === 0 || server?.status !== 'ready'}
                  empty="默认"
                  options={[{ value: '', label: '默认' }, ...activeVariants.map(name => ({ value: name, label: variantLabel(name) }))]}
                />

                <div className="flex-1" />

                {busy ? (
                  <button
                    onClick={() => void abort()}
                    className="flex h-[30px] items-center rounded-[10px] border border-white/15 bg-white/8 px-4 text-[13px] font-medium text-white/80 transition hover:bg-white/14 active:scale-[.97]"
                  >
                    停止
                  </button>
                ) : (
                  <button
                    onClick={() => void submit()}
                    disabled={(!input.trim() && attachments.length === 0) || server?.status !== 'ready' || !workspace}
                    className="flex h-[30px] items-center rounded-[10px] bg-white/90 px-4 text-[13px] font-semibold text-slate-900 transition hover:bg-white active:scale-[.97] disabled:opacity-40"
                  >
                    发送
                  </button>
                )}
              </div>
            </div>
            {slashOpen ? (
              <div className="hui-slash-menu" role="listbox" aria-label="斜杠命令">
                <div className="hui-slash-scroll">
                  {slashResults.map((command, index) => (
                    <button
                      key={command.name}
                      type="button"
                      role="option"
                      aria-selected={index === slashHighlight}
                      className="hui-slash-option"
                      data-focused={index === slashHighlight}
                      onMouseEnter={() => setSlashHighlight(index)}
                      onMouseDown={event => event.preventDefault()}
                      onClick={() => applyCommand(command)}
                    >
                      <span className="hui-slash-name">/{command.name}</span>
                      {command.description ? <span className="hui-slash-desc">{command.description}</span> : null}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            </div>
            </div>
          </div>
          {permissionDialog ?? (questions[0] && questions[0].sessionID === activeId ? <QuestionDialog key={questions[0].id} request={questions[0]} busy={answeringQuestion} onReply={answers => void resolveQuestion(questions[0], answers)} onReject={() => void resolveQuestion(questions[0])} /> : null)}
        </main>
      </div>
    </div>
    </CollapseScrollContext.Provider>
  )
}
