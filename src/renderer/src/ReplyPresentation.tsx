import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

// Keep this aligned with PartView: protocol bookkeeping is not visible content.
export function hasVisiblePart(part: any): boolean {
  if (part.type === 'text' || part.type === 'reasoning') return !!part.text
  return part.type === 'tool' || part.type === 'file' || part.type === 'retry'
}

export function ReplyPresentation({ waiting, children }: { waiting: boolean; children: ReactNode }): React.ReactElement {
  const wasWaiting = useRef(waiting)
  const [leaving, setLeaving] = useState(false)
  useLayoutEffect(() => {
    if (wasWaiting.current && !waiting) setLeaving(true)
    if (waiting) setLeaving(false)
    wasWaiting.current = waiting
  }, [waiting])

  return (
    <div className={`hui-reply-stage${waiting ? ' is-waiting' : ''}${leaving ? ' is-revealing' : ''}`}>
      {waiting || leaving ? (
        <div
          className={`hui-reply-wait${leaving ? ' is-leaving' : ''}`}
          role={waiting ? 'status' : undefined}
          aria-hidden={leaving || undefined}
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget && event.animationName === 'hui-wait-leave') setLeaving(false)
          }}
        >
          <span className="hui-wait-orbit" aria-hidden="true"><span className="hui-wait-seed" /></span>
          <span>等待回复</span>
        </div>
      ) : null}
      <div className="hui-reply-content space-y-4">{children}</div>
    </div>
  )
}
