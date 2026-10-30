import { render } from 'preact'
import './styles/index.css'
import { App } from './app.tsx'
import { initLocale } from './i18n/index.ts'
import { initTheme } from './theme.ts'

// Before the first render: <html> gets its theme, lang and dir.
initTheme()
initLocale()

render(<App />, document.getElementById('app')!)
