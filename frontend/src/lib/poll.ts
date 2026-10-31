/**
 * Something refetched on a timer (the channel list: new conversations and invitations are
 * not pushed), but only while someone can see it: a hidden tab asks the server nothing. When
 * the tab is shown again after more than `staleAfterMs` without a refresh, it refreshes once,
 * at once. Returns the function that stops it.
 */
export function pollWhileVisible(refresh: () => void, { everyMs, staleAfterMs }: { everyMs: number; staleAfterMs: number }): () => void {
  let last = Date.now()
  const run = () => {
    last = Date.now()
    refresh()
  }
  const timer = setInterval(() => {
    if (document.visibilityState !== 'hidden') run()
  }, everyMs)
  const onVisibility = () => {
    if (document.visibilityState === 'visible' && Date.now() - last > staleAfterMs) run()
  }
  document.addEventListener('visibilitychange', onVisibility)
  return () => {
    clearInterval(timer)
    document.removeEventListener('visibilitychange', onVisibility)
  }
}
