import { render } from 'preact'
import './styles/index.css'
import { App } from './app.tsx'
import { initLocale } from './i18n/index.ts'
import { listenToHistory } from './router.ts'
import { boot, installClientEvents } from './session.ts'
import { initTheme } from './theme.ts'

// Before the first render: <html> gets its theme, lang and dir.
initTheme()
initLocale()
installClientEvents()
listenToHistory()
void boot()

render(<App />, document.getElementById('app')!)
