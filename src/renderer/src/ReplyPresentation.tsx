import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

// Protocol bookkeeping has no visual surface of its own.
export function hasVisiblePart(part: any): boolean {
  if (part.type === 'text' || part.type === 'reasoning') return !!part.text
  return part.type === 'tool' || part.type === 'file' || part.type === 'retry'
}

type Phase = 'waiting' | 'label-exit' | 'condensing' | 'dot-exit' | 'unfolding' | 'ready'

export function ReplyPresentation({ waiting, children }: { waiting: boolean; children?: ReactNode }): React.ReactElement {
  const wasWaiting = useRef(waiting)
  const [phase, setPhase] = useState<Phase>(waiting ? 'waiting' : 'ready')

  useLayoutEffect(() => {
    if (waiting) setPhase('waiting')
    else if (wasWaiting.current) setPhase('label-exit')
    wasWaiting.current = waiting
  }, [waiting])

  const showWait = phase === 'waiting' || phase === 'label-exit' || phase === 'condensing' || phase === 'dot-exit'
  return (
    <div className="hui-reply-stage">
      <div
        className={`glass hui-message hui-reply-bubble is-${phase}`}
        onAnimationEnd={(event) => {
          if (event.target !== event.currentTarget) return
          if (phase === 'condensing' && event.animationName === 'hui-reply-condense') setPhase('dot-exit')
          if (phase === 'unfolding' && event.animationName === 'hui-reply-unfold') setPhase('ready')
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
        <div className="hui-reply-content flex min-w-0 flex-col gap-2" aria-hidden={phase !== 'ready' || undefined}>
          {children}
        </div>
      </div>
    </div>
  )
}
