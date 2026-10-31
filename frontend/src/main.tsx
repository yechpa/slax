import { render } from 'preact'
import './styles/index.css'
import { App } from './app.tsx'
import { initLocale } from './i18n/index.ts'
import { followVisualViewport } from './lib/viewport.ts'
import { listenForInstall } from './pwa/install.ts'
import { listenForNotificationClicks } from './pwa/push.ts'
import { registerServiceWorker } from './pwa/register.ts'
import { listenToHistory } from './router.ts'
import { boot, installClientEvents } from './session.ts'
import { initTheme } from './theme.ts'

// Before the first render: <html> gets its theme, lang and dir.
initTheme()
initLocale()
installClientEvents()
listenToHistory()
// The on-screen keyboard: the app keeps to what it leaves visible (iOS Safari).
followVisualViewport()
void boot()
// Production and e2e builds only: offline shell, installability, update banner.
void registerServiceWorker()
listenForInstall()
// A tapped notification brings the open app to its conversation.
listenForNotificationClicks()

render(<App />, document.getElementById('app')!)
