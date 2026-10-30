import { useRef } from 'preact/hooks'

/**
 * Enter that confirms an IME composition (Japanese, Chinese, Korean input) must neither
 * send nor save. Browsers say so differently: `isComposing`, keyCode 229 (Safari), or
 * only through compositionstart/compositionend. Spread `handlers` on the field and ask
 * `composing(event)` in its keydown.
 */
export function useIme() {
  const active = useRef(false)
  return {
    handlers: {
      onCompositionStart: () => {
        active.current = true
      },
      onCompositionEnd: () => {
        active.current = false
      },
    },
    composing: (event: KeyboardEvent) => event.isComposing || active.current || event.keyCode === 229,
  }
}
