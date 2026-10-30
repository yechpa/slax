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

const CLIPPING = new Set(['auto', 'scroll', 'hidden', 'clip'])

/** Is `box` (the anchor's rectangle) inside every box that clips `el` (scrolling or hidden overflow)? */
function shownInClippers(el: HTMLElement, box: DOMRect): boolean {
  for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const style = getComputedStyle(parent)
    if (!CLIPPING.has(style.overflowX) && !CLIPPING.has(style.overflowY)) continue
    const clip = parent.getBoundingClientRect()
    if (box.bottom <= clip.top || box.top >= clip.bottom || box.right <= clip.left || box.left >= clip.right) return false
  }
  return true
}

/**
 * A small panel over everything (a menu, the emoji picker), placed under its anchor and
 * aligned with its inline end, or above it when there is no room below; kept inside the
 * window. It closes on Escape (focus back to the anchor), a click elsewhere, or a change of the
 * window's width (a change of its height alone, the on-screen keyboard, re-places it).
 * When what is under it scrolls (the reader, or a message list keeping to its newest
 * message as one arrives), it follows its anchor, and closes once the anchor is out of
 * sight (out of the window, or out of a scrolling box around it, such as under the channel
 * header): it never floats away from its anchor. A new anchor is followed from then on.
 *
 * The position goes through two custom properties set from script (CSSOM), not a style
 * attribute: the CSP needs no 'unsafe-inline'.
 */
export function Popover({ anchor, onClose, children, class: extra }: Props) {
  const panel = useRef<HTMLDivElement>(null)
  const [placed, setPlaced] = useState(false)
  const close = useRef(onClose)
  close.current = onClose
  // The latest anchor (it may change while open), read by `place` below.
  const anchorRef = useRef(anchor)
  anchorRef.current = anchor

  /** Placed against the anchor; false when the anchor is gone or out of sight. */
  const place = useRef(() => {
    const el = panel.current
    const target = anchorRef.current.current
    const at = target?.isConnected ? target.getBoundingClientRect() : null
    if (!el || !target || !at) return false
    const width = el.offsetWidth
    const height = el.offsetHeight
    const viewWidth = document.documentElement.clientWidth || innerWidth
    const viewHeight = document.documentElement.clientHeight || innerHeight
    if (at.bottom < 0 || at.top > viewHeight || !shownInClippers(target, at)) return false
    const rtl = getComputedStyle(el).direction === 'rtl'
    // Distance from the inline-start edge of the window, aligning the inline ends.
    const fromStart = rtl ? viewWidth - at.left - width : at.right - width
    const inline = Math.max(MARGIN, Math.min(fromStart, viewWidth - width - MARGIN))
    let block = at.bottom + GAP
    if (block + height > viewHeight - MARGIN && at.top - GAP - height >= MARGIN) block = at.top - GAP - height
    block = Math.max(MARGIN, Math.min(block, viewHeight - height - MARGIN))
    el.style.setProperty('--pop-inline', `${Math.round(inline)}px`)
    el.style.setProperty('--pop-block', `${Math.round(block)}px`)
    return true
  })

  useLayoutEffect(() => {
    if (place.current()) setPlaced(true)
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
      if (!el?.contains(event.target as Node) && !place.current()) close.current(false)
    }
    // A change of width (a rotation, a resized window) closes it. A change of height alone is
    // Android's keyboard opening or closing (the page is resized for it, see index.html): the
    // popover follows its anchor instead, and closes only if the anchor went out of sight.
    const width = innerWidth
    const onResize = () => {
      if (innerWidth !== width || !place.current()) close.current(false)
    }
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
