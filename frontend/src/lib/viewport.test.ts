import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KEYBOARD_MIN_PX, followVisualViewport } from './viewport.ts'

/** A window whose visual viewport the test moves (as the on-screen keyboard and Safari's panning do). */
class FakeViewport extends EventTarget {
  height = 800
  width = 390
  offsetTop = 0
  offsetLeft = 0
  pageTop = 0
  pageLeft = 0
  scale = 1
}

let viewport: FakeViewport
let win: Window
let stop: () => void
const root = document.documentElement

beforeEach(() => {
  viewport = new FakeViewport()
  const events = new EventTarget()
  win = Object.assign(events, { visualViewport: viewport, innerHeight: 800, document }) as unknown as Window
  stop = followVisualViewport(win)
})

afterEach(() => {
  stop()
  root.removeAttribute('data-keyboard')
  root.style.removeProperty('--visible-block-size')
  root.style.removeProperty('--visible-top')
  root.style.removeProperty('--visible-page-top')
})

const move = (change: Partial<FakeViewport>, type = 'resize') => {
  Object.assign(viewport, change)
  viewport.dispatchEvent(new Event(type))
}

describe('the visible part of the window (on-screen keyboard)', () => {
  it('says nothing while the whole window is visible', () => {
    expect(root.hasAttribute('data-keyboard')).toBe(false)
    expect(root.style.getPropertyValue('--visible-block-size')).toBe('')
  })

  it('gives the app the height and position of what the keyboard leaves visible', () => {
    move({ height: 500 })
    expect(root.hasAttribute('data-keyboard')).toBe(true)
    expect(root.style.getPropertyValue('--visible-block-size')).toBe('500px')
    expect(root.style.getPropertyValue('--visible-top')).toBe('0px')
    // Safari pans the page up to the focused field: the app follows (viewport and page coordinates).
    move({ offsetTop: 120, pageTop: 150 }, 'scroll')
    expect(root.style.getPropertyValue('--visible-top')).toBe('120px')
    expect(root.style.getPropertyValue('--visible-page-top')).toBe('150px')
    // Closed: back to the dynamic viewport.
    move({ height: 800, offsetTop: 0, pageTop: 0 })
    expect(root.hasAttribute('data-keyboard')).toBe(false)
    expect(root.style.getPropertyValue('--visible-block-size')).toBe('')
    expect(root.style.getPropertyValue('--visible-top')).toBe('')
  })

  it('ignores toolbars moving (less than a keyboard) and pinch zoom', () => {
    move({ height: 800 - KEYBOARD_MIN_PX + 1 })
    expect(root.hasAttribute('data-keyboard')).toBe(false)
    move({ height: 400, scale: 2 })
    expect(root.hasAttribute('data-keyboard')).toBe(false)
  })

  it('follows a resized window too (rotation, Android resizing the page)', () => {
    move({ height: 500 })
    expect(root.hasAttribute('data-keyboard')).toBe(true)
    Object.assign(win, { innerHeight: 500 })
    win.dispatchEvent(new Event('resize'))
    expect(root.hasAttribute('data-keyboard')).toBe(false)
  })

  it('does nothing without a visual viewport, and stops when disposed', () => {
    const none = followVisualViewport(Object.assign(new EventTarget(), { visualViewport: null, innerHeight: 800, document }) as unknown as Window)
    none()
    stop()
    move({ height: 400 })
    expect(root.hasAttribute('data-keyboard')).toBe(false)
  })
})
