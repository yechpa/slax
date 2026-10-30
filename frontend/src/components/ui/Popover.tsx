import type { ComponentChildren, RefObject } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

type Props = {
  /** The button that opened it: placed against it, and focused again on Escape. */
  anchor: RefObject<HTMLElement | null>
  /** `restoreFocus`: closed from the keyboard (Escape), focus goes back to the anchor. */
  onClose: (restoreFocus: boolean) => void
  children: ComponentChildren
  class?: string
}

const MARGIN = 8
const GAP = 4

/**
 * A small panel over everything (a menu, the emoji picker), placed under its anchor and
 * aligned with its inline end, or above it when there is no room below; kept inside the
 * window. It closes on Escape (focus back to the anchor), a click elsewhere, a scroll of
 * what is under it, or a resize: it never floats away from its anchor.
 *
 * The position goes through two custom properties set from script (CSSOM), not a style
 * attribute: the CSP needs no 'unsafe-inline'.
 */
export function Popover({ anchor, onClose, children, class: extra }: Props) {
  const panel = useRef<HTMLDivElement>(null)
  const [placed, setPlaced] = useState(false)
  const close = useRef(onClose)
  close.current = onClose

  useLayoutEffect(() => {
    const el = panel.current
    const at = anchor.current?.getBoundingClientRect()
    if (!el || !at) return
    const width = el.offsetWidth
    const height = el.offsetHeight
    const viewWidth = document.documentElement.clientWidth || innerWidth
    const viewHeight = document.documentElement.clientHeight || innerHeight
    const rtl = getComputedStyle(el).direction === 'rtl'
    // Distance from the inline-start edge of the window, aligning the inline ends.
    const fromStart = rtl ? viewWidth - at.left - width : at.right - width
    const inline = Math.max(MARGIN, Math.min(fromStart, viewWidth - width - MARGIN))
    let block = at.bottom + GAP
    if (block + height > viewHeight - MARGIN && at.top - GAP - height >= MARGIN) block = at.top - GAP - height
    block = Math.max(MARGIN, Math.min(block, viewHeight - height - MARGIN))
    el.style.setProperty('--pop-inline', `${Math.round(inline)}px`)
    el.style.setProperty('--pop-block', `${Math.round(block)}px`)
    setPlaced(true)
  }, [anchor])

  useEffect(() => {
    const el = panel.current
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      close.current(true)
    }
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node
      if (!el?.contains(target) && !anchor.current?.contains(target)) close.current(false)
    }
    const onScroll = (event: Event) => {
      if (!el?.contains(event.target as Node)) close.current(false)
    }
    const onResize = () => close.current(false)
    el?.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('scroll', onScroll, true)
    addEventListener('resize', onResize)
    return () => {
      el?.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer, true)
      document.removeEventListener('scroll', onScroll, true)
      removeEventListener('resize', onResize)
    }
  }, [anchor])

  return (
    <div ref={panel} class={['popover', placed && 'popover--placed', extra].filter(Boolean).join(' ')}>
      {children}
    </div>
  )
}
