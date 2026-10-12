import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MessageEntry } from './stream-state'

export interface ReplyMetrics {
  model: string
  provider: string
  seconds: number | null
  speed: number | null
  firstTokenSeconds: number | null
  tokens: number | null
}

// End-to-end duration comes from the kernel; observed latency and throughput
// come only from live SSE receipt timings, never from whole-step durations.
export function replyMetrics(user: MessageEntry | null, replies: MessageEntry[], observed?: { firstTokenSeconds: number | null; speed: number | null }): ReplyMetrics | null {
  const assistants = replies.filter(message => message.info?.role === 'assistant')
  if (!assistants.length || assistants.some(message => !Number.isFinite(message.info?.time?.completed))) return null
  const last = assistants.at(-1)!
  const start = user?.info?.time?.created ?? assistants[0].info?.time?.created
  const end = Math.max(...assistants.map(message => message.info.time.completed))
  let tokens = 0
  let completeUsage = true
  for (const { info } of assistants) {
    const output = info.tokens?.output
    const reasoning = info.tokens?.reasoning
    if (!Number.isFinite(output) || !Number.isFinite(reasoning)) completeUsage = false
    else tokens += output + reasoning
  }
  return {
    model: last.info?.modelID || '未提供',
    provider: last.info?.providerID || '未提供',
    seconds: Number.isFinite(start) && end > start ? (end - start) / 1000 : null,
    speed: observed?.speed ?? null,
    firstTokenSeconds: observed?.firstTokenSeconds ?? null,
    tokens: completeUsage ? tokens : null
  }
}

function durationLabel(seconds: number | null): string {
  if (seconds === null) return '未提供'
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`
  const rounded = Math.round(seconds)
  return `${Math.floor(rounded / 60)} 分 ${rounded % 60} 秒`
}

function latencyLabel(seconds: number | null): string {
  if (seconds === null) return '未提供'
  return seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(2)} 秒`
}

export function ReplyDetails({ metrics }: { metrics: ReplyMetrics }): React.ReactElement {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const anchorRoot = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pinned = useRef(false)
  const [open, setOpen] = useState(false)
  const motion = useRef<Animation | null>(null)
  const contentMotion = useRef<Animation | null>(null)
  const anchorFrame = useRef<number | null>(null)
  const cancel = (): void => { if (timer.current !== null) clearTimeout(timer.current); timer.current = null }
  const close = (): void => { cancel(); pinned.current = false; setOpen(false) }
  const enter = (): void => { cancel(); timer.current = setTimeout(() => setOpen(true), 120) }
  const leave = (): void => {
    cancel()
    if (!pinned.current) timer.current = setTimeout(() => {
      const focused = document.activeElement
      const keyboardFocus = focused === trigger.current && trigger.current?.matches(':focus-visible')
      if (!panel.current?.contains(focused) && !keyboardFocus) setOpen(false)
    }, 100)
  }
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])
  useEffect(() => () => {
    motion.current?.cancel(); contentMotion.current?.cancel()
    if (anchorFrame.current !== null) cancelAnimationFrame(anchorFrame.current)
  }, [])
  useLayoutEffect(() => {
    const surface = panel.current
    const body = content.current
    const button = trigger.current
    const root = anchorRoot.current
    if (!surface || !body || !button || !root) return
    if (!open && surface.dataset.visible !== 'true') return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const wasVisible = surface.dataset.visible === 'true'
    const anchor = button.getBoundingClientRect()
    root.style.transform = `translate(${anchor.left}px, ${anchor.top}px)`
    // The same glass changes its actual bounds; text is never scaled. Capture
    // the current frame so reversing mid-flight does not reset the geometry.
    const current = getComputedStyle(surface)
    const from = {
      left: current.left, top: current.top, width: current.width,
      height: current.height, borderRadius: current.borderRadius
    }
    const textOpacity = getComputedStyle(body).opacity
    motion.current?.cancel()
    contentMotion.current?.cancel()
    const circle = {
      left: '0px', top: '0px',
      width: `${anchor.width}px`, height: `${anchor.height}px`, borderRadius: '14px'
    }
    let target = circle
    if (open) {
      const width = Math.min(320, window.innerWidth - 24)
      body.style.width = `${width - 2}px`
      const height = Math.min(body.offsetHeight + 2, window.innerHeight - 24)
      const below = anchor.bottom < height + 12
      const left = Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12))
      // The panel includes the circle, so there is no gap or separate popup.
      const top = Math.max(12, Math.min(below ? anchor.top : anchor.bottom - height, window.innerHeight - height - 12))
      // The icon's corner keeps the circle's 14px radius and center, while
      // the other corners soften into the card. Never interpolate that corner.
      target = { left: `${left - anchor.left}px`, top: `${top - anchor.top}px`, width: `${width}px`, height: `${height}px`,
        borderRadius: below ? '18px 14px 18px 18px' : '18px 18px 14px 18px' }
      surface.dataset.below = String(below)
      surface.dataset.visible = 'true'
      button.dataset.surface = 'expanded'
    }
    const animation = surface.animate([wasVisible ? from : circle, target], {
      duration: reduced ? 0 : open ? 520 : 380,
      easing: 'cubic-bezier(.3,0,.15,1)', fill: 'both'
    })
    // Let the glass open before revealing its contents; keep the info glyph
    // attached to the original circle throughout both directions.
    contentMotion.current = body.animate([
      { opacity: wasVisible ? textOpacity : 0 }, { opacity: open ? 1 : 0 }
    ], { duration: reduced ? 0 : open ? 220 : 100, delay: reduced || !open || wasVisible ? 0 : 150, fill: 'both', easing: 'ease-out' })
    motion.current = animation
    // Animate geometry relative to the real button, not stale viewport pixels.
    // Keep tracking through exit too: scroll listeners stop once open is false.
    if (anchorFrame.current === null) {
      const follow = (): void => {
        anchorFrame.current = null
        if (surface.dataset.visible !== 'true' || !button.isConnected) return
        const bounds = button.getBoundingClientRect()
        root.style.transform = `translate(${bounds.left}px, ${bounds.top}px)`
        anchorFrame.current = requestAnimationFrame(follow)
      }
      anchorFrame.current = requestAnimationFrame(follow)
    }
    void animation.finished.then(() => {
      if (!open && motion.current === animation) {
        surface.dataset.visible = 'false'
        if (anchorFrame.current !== null) cancelAnimationFrame(anchorFrame.current)
        anchorFrame.current = null
        delete button.dataset.surface
        animation.cancel()
      }
    }, () => { /* Reopening or unmounting cancels the previous animation. */ })
  }, [open])
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
      style={{ backdropFilter: 'blur(12px) saturate(125%)' }}
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
    {createPortal(<div ref={anchorRoot} className="hui-reply-details-root"><div ref={panel} id={id} className="hui-reply-details-panel" role="dialog" aria-label="生成详情"
      aria-hidden={!open} inert={!open} data-open={open}
      style={{ backdropFilter: 'blur(12px) saturate(125%)' }}
      onPointerEnter={cancel} onPointerLeave={leave} onFocus={cancel} onBlur={leave}>
      <div ref={content} className="hui-reply-details-body">
      <h3>生成详情</h3>
      <dl>
        <div><dt>模型</dt><dd>{metrics.model}</dd></div>
        <div><dt>提供商</dt><dd>{metrics.provider}</dd></div>
        <div><dt>观测首 token 延迟</dt><dd>{latencyLabel(metrics.firstTokenSeconds)}</dd></div>
        <div><dt>端到端耗时</dt><dd>{durationLabel(metrics.seconds)}</dd></div>
        <div><dt>观测输出速度</dt><dd>{metrics.speed === null ? '未提供' : `${metrics.speed.toFixed(1)} token/秒`}</dd></div>
        <div><dt>输出及思考 token</dt><dd>{metrics.tokens === null ? '未提供' : metrics.tokens.toLocaleString()}</dd></div>
      </dl>
      </div>
      <button type="button" className="hui-reply-details-anchor" aria-label="固定或收起生成详情"
        onPointerEnter={cancel} onPointerLeave={leave}
        onClick={() => { cancel(); if (pinned.current) close(); else pinned.current = true }}>
        <svg width="15" height="15" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M10 9v5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="10" cy="6.2" r=".9" fill="currentColor" />
        </svg>
      </button>
    </div></div>, document.body)}
  </div>
}
