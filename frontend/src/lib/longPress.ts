/**
 * A long press on a touch screen (a finger held still), for what a right click or a hover gives a
 * mouse: a message's menu. Only a finger counts (a mouse keeps its right click); a finger that
 * moves (a scroll) or lifts early is a scroll or a tap. Links, buttons, fields and media keep the
 * browser's own long press (open, copy or save them).
 *
 * Android's Chrome fires `contextmenu` for a long press: that is the press, at once, and the
 * browser's own menu and text selection are prevented. iOS Safari fires none: the timer does it.
 * The click some browsers send when the finger lifts after a press is swallowed, so it lands
 * nowhere (in particular, it does not close what the press opened).
 */
export const LONG_PRESS_MS = 500
/** How far a finger may tremble and still be holding still. */
const SLOP_PX = 10
/** What keeps the browser's own long press. */
const OWN_GESTURES = 'a[href], button, input, textarea, select, label, img, video, audio, [role="button"], [role="menuitem"], [contenteditable]'

export function onLongPress(element: HTMLElement, onPress: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let start: { x: number; y: number; id: number } | null = null
  /** The last pointer down was a finger on the element itself (not on a link, a button…). */
  let finger = false
  /** A press fired for this touch: the click that may follow is swallowed, a late contextmenu too. */
  let pressed = false

  const ours = (target: EventTarget | null) => !(target instanceof Element && target.closest(OWN_GESTURES))
  const cancel = () => {
    clearTimeout(timer)
    timer = undefined
    start = null
  }
  const fire = () => {
    cancel()
    pressed = true
    onPress()
  }

  const down = (event: PointerEvent) => {
    cancel()
    pressed = false
    finger = event.pointerType === 'touch' && event.isPrimary && ours(event.target)
    if (!finger) return
    start = { x: event.clientX, y: event.clientY, id: event.pointerId }
    timer = setTimeout(fire, LONG_PRESS_MS)
  }
  const move = (event: PointerEvent) => {
    if (start && event.pointerId === start.id && Math.hypot(event.clientX - start.x, event.clientY - start.y) > SLOP_PX) cancel()
  }
  const end = (event: PointerEvent) => {
    if (start && event.pointerId === start.id) cancel()
  }
  const contextMenu = (event: MouseEvent) => {
    if (!finger || !ours(event.target)) return
    event.preventDefault()
    if (!pressed) fire()
  }
  const click = (event: MouseEvent) => {
    if (!pressed) return
    pressed = false
    event.preventDefault()
    event.stopPropagation()
  }

  element.addEventListener('pointerdown', down)
  element.addEventListener('pointermove', move)
  element.addEventListener('pointerup', end)
  element.addEventListener('pointercancel', end)
  element.addEventListener('contextmenu', contextMenu)
  element.addEventListener('click', click, true)
  return () => {
    cancel()
    element.removeEventListener('pointerdown', down)
    element.removeEventListener('pointermove', move)
    element.removeEventListener('pointerup', end)
    element.removeEventListener('pointercancel', end)
    element.removeEventListener('contextmenu', contextMenu)
    element.removeEventListener('click', click, true)
  }
}
