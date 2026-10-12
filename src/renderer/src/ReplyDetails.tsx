import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MessageEntry } from './stream-state'

export interface ReplyMetrics {
  model: string
  provider: string
  seconds: number | null
  speed: number | null
  tokens: number | null
}

// Completed kernel timestamps describe whole assistant steps, not exact token
// arrival times. Keep missing measurements explicit and label the rate estimate.
export function replyMetrics(user: MessageEntry | null, replies: MessageEntry[]): ReplyMetrics | null {
  const assistants = replies.filter(message => message.info?.role === 'assistant')
  if (!assistants.length || assistants.some(message => !Number.isFinite(message.info?.time?.completed))) return null
  const last = assistants.at(-1)!
  const start = user?.info?.time?.created ?? assistants[0].info?.time?.created
  const end = Math.max(...assistants.map(message => message.info.time.completed))
  let tokens = 0
  let duration = 0
  let completeUsage = true
  let completeTiming = true
  for (const { info } of assistants) {
    const output = info.tokens?.output
    const reasoning = info.tokens?.reasoning
    if (!Number.isFinite(output) || !Number.isFinite(reasoning)) completeUsage = false
    else tokens += output + reasoning
    const elapsed = info.time.completed - info.time.created
    if (!Number.isFinite(elapsed) || elapsed <= 0) completeTiming = false
    else duration += elapsed
  }
  return {
    model: last.info?.modelID || '未提供',
    provider: last.info?.providerID || '未提供',
    seconds: Number.isFinite(start) && end > start ? (end - start) / 1000 : null,
    speed: completeUsage && completeTiming && tokens > 0 ? tokens / (duration / 1000) : null,
    tokens: completeUsage ? tokens : null
  }
}

function durationLabel(seconds: number | null): string {
  if (seconds === null) return '未提供'
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`
  const rounded = Math.round(seconds)
  return `${Math.floor(rounded / 60)} 分 ${rounded % 60} 秒`
}

export function ReplyDetails({ metrics }: { metrics: ReplyMetrics }): React.ReactElement {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pinned = useRef(false)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 0, top: 0, below: false })
  const cancel = (): void => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null }
  const close = (): void => { cancel(); pinned.current = false; setOpen(false) }
  const enter = (): void => { cancel(); timer.current = setTimeout(() => setOpen(true), 200) }
  const leave = (): void => {
    cancel()
    if (!pinned.current) timer.current = setTimeout(() => {
      if (!panel.current?.contains(document.activeElement) && document.activeElement !== trigger.current) setOpen(false)
    }, 180)
  }
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return
    const anchor = trigger.current.getBoundingClientRect()
    const width = panel.current.offsetWidth
    const height = panel.current.offsetHeight
    const below = anchor.top < height + 20
    setPosition({
      left: Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12)),
      top: Math.max(12, Math.min(below ? anchor.bottom + 8 : anchor.top - height - 8, window.innerHeight - height - 12)),
      below
    })
  }, [open, metrics])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent): void => {
      if (!trigger.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) close()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        const restore = panel.current?.contains(document.activeElement)
        if (restore) trigger.current?.focus()
        close()
      }
    }
    const scroll = (event: Event): void => { if (!panel.current?.contains(event.target as Node)) close() }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    document.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
      document.removeEventListener('scroll', scroll, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [open])
  return <div className="hui-reply-details">
    <button ref={trigger} type="button" className="hui-reply-info" aria-label="查看生成详情"
      aria-expanded={open} aria-controls={id} aria-haspopup="dialog"
      onPointerEnter={enter} onPointerLeave={leave}
      onFocus={() => { cancel(); setOpen(true) }} onBlur={leave}
      onClick={() => { cancel(); if (pinned.current) close(); else { pinned.current = true; setOpen(true) } }}>
      <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M10 9v5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        <circle cx="10" cy="6.2" r=".9" fill="currentColor" />
      </svg>
    </button>
    {createPortal(<div ref={panel} id={id} className="hui-reply-details-panel" role="dialog" aria-label="生成详情"
      aria-hidden={!open} inert={!open} data-open={open} data-below={position.below}
      style={{ left: position.left, top: position.top, backdropFilter: 'blur(24px) saturate(140%)' }}
      onPointerEnter={cancel} onPointerLeave={leave} onFocus={cancel} onBlur={leave}>
      <h3>生成详情</h3>
      <dl>
        <div><dt>模型</dt><dd>{metrics.model}</dd></div>
        <div><dt>提供商</dt><dd>{metrics.provider}</dd></div>
        <div><dt>首 token 延迟</dt><dd>未提供</dd></div>
        <div><dt>端到端耗时</dt><dd>{durationLabel(metrics.seconds)}</dd></div>
        <div><dt>输出速度（估算）</dt><dd>{metrics.speed === null ? '未提供' : `${metrics.speed.toFixed(1)} token/秒`}</dd></div>
        <div><dt>输出及思考 token</dt><dd>{metrics.tokens === null ? '未提供' : metrics.tokens.toLocaleString()}</dd></div>
      </dl>
      <p>总耗时包含等待与工具执行。速度按输出及思考 token ÷ 各助手步骤耗时估算，包含步骤内等待，非纯解码速度。内核未提供首 token 时间戳。</p>
    </div>, document.body)}
  </div>
}
