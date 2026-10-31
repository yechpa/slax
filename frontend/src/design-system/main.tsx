import { render } from 'preact'
import '../styles/index.css'
import './design-system.css'
import { initLocale, isLocale, setLocale } from '../i18n/index.ts'
import { initTheme, isTheme, setTheme } from '../theme.ts'
import { KitchenSink } from './KitchenSink.tsx'

initTheme()
initLocale()

// ?theme=listing&lang=he: lets a screenshot run (or a reviewer) pick a combination directly.
const params = new URLSearchParams(location.search)
const theme = params.get('theme')
const lang = params.get('lang')
if (isTheme(theme)) setTheme(theme)
if (isLocale(lang)) setLocale(lang)

render(<KitchenSink />, document.getElementById('app')!)
