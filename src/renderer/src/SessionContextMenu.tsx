import { memo, useLayoutEffect, useRef } from 'react'

export interface SessionMenuTarget {
  id: string
  x: number
  y: number
}

export const SessionContextMenu = memo(function SessionContextMenu({ target, disabled, onDelete, onClose }: {
  target: SessionMenuTarget
  disabled: boolean
  onDelete: (id: string) => void
  onClose: () => void
}): React.ReactElement {
  const menuRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    const menu = menuRef.current!
    const previousFocus = document.activeElement
    const bounds = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(8, Math.min(target.x, window.innerWidth - bounds.width - 8))}px`
    menu.style.top = `${Math.max(8, Math.min(target.y, window.innerHeight - bounds.height - 8))}px`
    buttonRef.current?.focus()

    const outside = (event: PointerEvent): void => {
      if (!menu.contains(event.target as Node)) onClose()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', onClose)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', onClose)
      window.removeEventListener('blur', onClose)
      if ((menu.contains(document.activeElement) || document.activeElement === document.body)
        && previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [target.id, target.x, target.y, onClose])

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="会话操作"
      style={{ left: target.x, top: target.y }}
      className="no-drag fixed z-50 w-44 rounded-xl border border-white/15 bg-slate-900/95 p-1 shadow-xl"
      onContextMenu={event => event.preventDefault()}
    >
      <button
        ref={buttonRef}
        type="button"
        role="menuitem"
        disabled={disabled}
        onClick={() => onDelete(target.id)}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] text-rose-300 outline-none hover:bg-rose-400/10 focus:bg-rose-400/10 disabled:cursor-wait disabled:opacity-40"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" />
        </svg>
        删除会话
      </button>
    </div>
  )
})
