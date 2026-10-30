import { createRef, render } from 'preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flush } from '../../test/fakes.ts'
import { Popover } from './Popover.tsx'

/** The page around the popover (anchors, a scrolling list), and where the popover renders. */
let page: HTMLElement
let host: HTMLElement

beforeEach(() => {
  page = document.createElement('div')
  host = document.createElement('div')
  document.body.append(page, host)
})

afterEach(() => {
  render(null, host)
  page.remove()
  host.remove()
})

const rect = (top: number, height = 24, left = 400, width = 24) =>
  ({ top, bottom: top + height, left, right: left + width, width, height, x: left, y: top, toJSON: () => ({}) }) as DOMRect

/** A button whose place on screen the test sets. */
function button(parent: HTMLElement, top: () => number): HTMLButtonElement {
  const el = document.createElement('button')
  el.getBoundingClientRect = () => rect(top())
  parent.append(el)
  return el
}

describe('Popover', () => {
  it('is placed against its current anchor when the anchor changes', async () => {
    const first = createRef<HTMLElement>()
    const second = createRef<HTMLElement>()
    first.current = button(page, () => 100)
    second.current = button(page, () => 300)
    const onClose = vi.fn()
    render(<Popover anchor={first} onClose={onClose}>menu</Popover>, host)
    const panel = host.querySelector<HTMLElement>('.popover')!
    expect(panel.style.getPropertyValue('--pop-block')).toBe(`${100 + 24 + 4}px`)

    await flush()
    render(<Popover anchor={second} onClose={onClose}>menu</Popover>, host)
    await flush()
    expect(panel.style.getPropertyValue('--pop-block')).toBe(`${300 + 24 + 4}px`)
    // And it follows that one, not the first, when something scrolls.
    document.dispatchEvent(new Event('scroll'))
    expect(panel.style.getPropertyValue('--pop-block')).toBe(`${300 + 24 + 4}px`)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes once its anchor is scrolled out of its own list, even if still inside the window', async () => {
    // A message list from 100 to 500 px, under a header and above a composer.
    const list = document.createElement('div')
    list.style.overflowY = 'auto'
    list.getBoundingClientRect = () => rect(100, 400, 0, 1000)
    page.append(list)
    let top = 300
    const anchor = createRef<HTMLElement>()
    anchor.current = button(list, () => top)
    const onClose = vi.fn()
    render(<Popover anchor={anchor} onClose={onClose}>menu</Popover>, host)
    await flush()

    top = 120
    list.dispatchEvent(new Event('scroll'))
    expect(onClose).not.toHaveBeenCalled()

    // Under the header now (the window still shows that spot): nothing left to point at.
    top = 40
    list.dispatchEvent(new Event('scroll'))
    expect(onClose).toHaveBeenCalledWith(false)
  })

  it('stays open, re-placed, when only the height of the window changes (Android opening its keyboard)', async () => {
    const width = innerWidth
    const height = innerHeight
    let top = 500
    const anchor = createRef<HTMLElement>()
    anchor.current = button(page, () => top)
    const onClose = vi.fn()
    render(<Popover anchor={anchor} onClose={onClose}>menu</Popover>, host)
    await flush()
    const panel = host.querySelector<HTMLElement>('.popover')!
    try {
      // The keyboard opens: the page is resized shorter (interactive-widget=resizes-content), the anchor moves up.
      ;(window as { innerHeight: number }).innerHeight = height - 300
      top = 200
      dispatchEvent(new Event('resize'))
      expect(onClose).not.toHaveBeenCalled()
      expect(panel.style.getPropertyValue('--pop-block')).toBe(`${200 + 24 + 4}px`)

      // A rotation (or any change of width): closed, as before.
      ;(window as { innerWidth: number }).innerWidth = width + 200
      dispatchEvent(new Event('resize'))
      expect(onClose).toHaveBeenCalledWith(false)
    } finally {
      ;(window as { innerWidth: number }).innerWidth = width
      ;(window as { innerHeight: number }).innerHeight = height
    }
  })
})
