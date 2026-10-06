import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

// Protocol bookkeeping has no visual surface of its own.
export function hasVisiblePart(part: any): boolean {
  if (part.type === 'text' || part.type === 'reasoning') return !!part.text
  return part.type === 'tool' || part.type === 'file' || part.type === 'retry'
}

type Phase = 'waiting' | 'label-exit' | 'condensing' | 'dot-exit' | 'unfolding' | 'catching-up' | 'ready'

export function ReplyPresentation({ waiting, textLength = 0, children }: {
  waiting: boolean
  textLength?: number
  children?: ReactNode | ((visibleChars: number | undefined) => ReactNode)
}): React.ReactElement {
  const wasWaiting = useRef(waiting)
  const [phase, setPhase] = useState<Phase>(waiting ? 'waiting' : 'ready')
  const [visibleChars, setVisibleChars] = useState<number | undefined>(undefined)
  const latestTextLength = useRef(textLength)
  latestTextLength.current = textLength

  useLayoutEffect(() => {
    if (waiting) setPhase('waiting')
    else if (wasWaiting.current) setPhase('label-exit')
    wasWaiting.current = waiting
  }, [waiting])

  useLayoutEffect(() => {
    if (phase !== 'catching-up') return
    const initialLength = latestTextLength.current
    if (initialLength < 2 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setVisibleChars(undefined)
      setPhase('ready')
      return
    }

    // Only the text accumulated during the glass transition is briefly eased
    // in. SSE keeps updating the source; after this bounded bridge it is live.
    const duration = Math.min(560, Math.max(180, 120 + initialLength * 10))
    const started = performance.now()
    let frame = 0
    const advance = (now: number): void => {
      const progress = Math.min(1, (now - started) / duration)
      if (progress >= 1) {
        setVisibleChars(undefined)
        setPhase('ready')
        return
      }
      const next = Math.floor(latestTextLength.current * progress)
      setVisibleChars(previous => Math.max(previous ?? 0, next))
      frame = requestAnimationFrame(advance)
    }
    frame = requestAnimationFrame(advance)
    return () => cancelAnimationFrame(frame)
  }, [phase])

  const showWait = phase === 'waiting' || phase === 'label-exit' || phase === 'condensing' || phase === 'dot-exit'
  return (
    <div className="hui-reply-stage">
      <div
        className={`glass hui-message hui-reply-bubble is-${phase}`}
        onAnimationEnd={(event) => {
          if (event.target !== event.currentTarget) return
          if (phase === 'condensing' && event.animationName === 'hui-reply-condense') setPhase('dot-exit')
          if (phase === 'unfolding' && event.animationName === 'hui-reply-unfold') {
            setVisibleChars(0)
            setPhase('catching-up')
          }
        }}
      >
        {showWait ? (
          <div className="hui-reply-wait" role={waiting ? 'status' : undefined} aria-hidden={!waiting || undefined}>
            <span
              className="hui-wait-orbit"
              aria-hidden="true"
              onAnimationEnd={(event) => {
                if (phase === 'dot-exit' && event.animationName === 'hui-wait-dot-exit') setPhase('unfolding')
              }}
            ><span className="hui-wait-seed" /></span>
            <span
              className="hui-wait-label"
              onAnimationEnd={(event) => {
                if (phase === 'label-exit' && event.animationName === 'hui-wait-label-exit') {
                  setPhase('condensing')
                }
              }}
            >等待回复</span>
          </div>
        ) : null}
        <div className="hui-reply-content flex min-w-0 flex-col gap-2" aria-hidden={showWait || phase === 'unfolding' || undefined}>
          {typeof children === 'function' ? children(phase === 'catching-up' ? visibleChars ?? 0 : phase === 'ready' ? undefined : 0) : children}
        </div>
      </div>
    </div>
  )
}
