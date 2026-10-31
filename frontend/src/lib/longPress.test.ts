import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LONG_PRESS_MS, onLongPress } from './longPress.ts'

let host: HTMLElement
let body: HTMLElement
let link: HTMLAnchorElement
let pressed: number
let stop: () => void

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  host.innerHTML = '<p class="body">some words <a href="https://example.test/">a link</a></p><button type="button">more</button>'
  document.body.append(host)
  body = host.querySelector('.body')!
  link = host.querySelector('a')!
  pressed = 0
  stop = onLongPress(host, () => (pressed += 1))
})

afterEach(() => {
  stop()
  host.remove()
  vi.useRealTimers()
})

const pointer = (target: Element, type: string, init: PointerEventInit = {}) => {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 3, isPrimary: true, clientX: 10, clientY: 10, ...init })
  target.dispatchEvent(event)
  return event
}

const contextMenu = (target: Element) => {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

const click = (target: Element) => {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

describe('long press', () => {
  it('a finger held still fires once, after the delay, and the click on release is swallowed', () => {
    const outside = vi.fn()
    document.addEventListener('click', outside)
    pointer(body, 'pointerdown')
    vi.advanceTimersByTime(LONG_PRESS_MS - 1)
    expect(pressed).toBe(0)
    vi.advanceTimersByTime(1)
    expect(pressed).toBe(1)
    pointer(body, 'pointerup')
    expect(click(body).defaultPrevented).toBe(true)
    expect(outside).not.toHaveBeenCalled()
    // Only that one click: the next tap is a tap.
    pointer(body, 'pointerdown')
    pointer(body, 'pointerup')
    expect(click(body).defaultPrevented).toBe(false)
    expect(outside).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(LONG_PRESS_MS * 2)
    expect(pressed).toBe(1)
    document.removeEventListener('click', outside)
  })

  it('a tap, a scroll (the finger moves) or a cancelled touch is not a press', () => {
    pointer(body, 'pointerdown')
    pointer(body, 'pointerup')
    vi.advanceTimersByTime(LONG_PRESS_MS)
    pointer(body, 'pointerdown')
    pointer(body, 'pointermove', { clientX: 10, clientY: 30 })
    vi.advanceTimersByTime(LONG_PRESS_MS)
    pointer(body, 'pointerdown')
    pointer(body, 'pointercancel')
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(pressed).toBe(0)
    // A tremble within a few pixels is still holding still.
    pointer(body, 'pointerdown')
    pointer(body, 'pointermove', { clientX: 13, clientY: 14 })
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(pressed).toBe(1)
  })

  it('leaves a mouse alone: no press, and its right click keeps the browser menu', () => {
    pointer(body, 'pointerdown', { pointerType: 'mouse' })
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(contextMenu(body).defaultPrevented).toBe(false)
    expect(pressed).toBe(0)
  })

  it('leaves links and buttons their own long press', () => {
    pointer(link, 'pointerdown')
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(contextMenu(link).defaultPrevented).toBe(false)
    pointer(host.querySelector('button')!, 'pointerdown')
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(pressed).toBe(0)
  })

  it('Android: a touch context menu is the press at once, and the browser does not show its own', () => {
    pointer(body, 'pointerdown')
    expect(contextMenu(body).defaultPrevented).toBe(true)
    expect(pressed).toBe(1)
    // The timer that was running does not fire it a second time, nor does a late context menu.
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(contextMenu(body).defaultPrevented).toBe(true)
    expect(pressed).toBe(1)
  })

  it('stops listening when disposed', () => {
    stop()
    pointer(body, 'pointerdown')
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(contextMenu(body).defaultPrevented).toBe(false)
    expect(pressed).toBe(0)
  })
})
