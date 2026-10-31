/**
 * The on-screen keyboard. iOS Safari (and Chrome on Android when a page does not ask to be
 * resized, see the viewport meta in index.html) keeps the layout viewport as it is and lays the
 * keyboard over its bottom: an app 100dvh tall then has its composer under the keyboard, and
 * Safari pans the page to show the focused field, pushing the header out of sight.
 *
 * The visual viewport says what is actually visible. While it is clearly shorter than the window
 * (a keyboard, not toolbars moving, and not a pinch zoom), <html> gets `data-keyboard` and three
 * custom properties, set through the CSSOM (no inline style attribute, for the CSP):
 * --visible-block-size (its height), --visible-top (its top in the window, for fixed boxes such as
 * dialogs) and --visible-page-top (its top in the page, for the app in the flow). app.css sizes and
 * places the app with them, so the composer sits right above the keyboard and the header stays.
 */
export const KEYBOARD_MIN_PX = 120

const PROPERTIES = ['--visible-block-size', '--visible-top', '--visible-page-top'] as const

export function followVisualViewport(win: Window = window): () => void {
  const viewport = win.visualViewport
  if (!viewport) return () => undefined
  const root = win.document.documentElement

  const update = () => {
    const keyboard = win.innerHeight - viewport.height >= KEYBOARD_MIN_PX && Math.abs(viewport.scale - 1) < 0.01
    if (keyboard) {
      root.style.setProperty('--visible-block-size', `${viewport.height}px`)
      root.style.setProperty('--visible-top', `${viewport.offsetTop}px`)
      root.style.setProperty('--visible-page-top', `${viewport.pageTop}px`)
      root.setAttribute('data-keyboard', '')
    } else if (root.hasAttribute('data-keyboard')) {
      root.removeAttribute('data-keyboard')
      for (const property of PROPERTIES) root.style.removeProperty(property)
    }
  }

  viewport.addEventListener('resize', update)
  viewport.addEventListener('scroll', update)
  win.addEventListener('resize', update)
  update()
  return () => {
    viewport.removeEventListener('resize', update)
    viewport.removeEventListener('scroll', update)
    win.removeEventListener('resize', update)
  }
}
