import { render } from 'preact'
import './styles/index.css'
import { App } from './app.tsx'
import { initLocale } from './i18n/index.ts'
import { listenForInstall } from './pwa/install.ts'
import { registerServiceWorker } from './pwa/register.ts'
import { listenToHistory } from './router.ts'
import { boot, installClientEvents } from './session.ts'
import { initTheme } from './theme.ts'

// Before the first render: <html> gets its theme, lang and dir.
initTheme()
initLocale()
installClientEvents()
listenToHistory()
void boot()
// Production and e2e builds only: offline shell, installability, update banner.
void registerServiceWorker()
listenForInstall()

render(<App />, document.getElementById('app')!)
