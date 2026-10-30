/**
 * The real application on fixtures, for review screenshots (`make screenshots`):
 * ?screen=signed-out|app, ?theme=console|listing, ?lang=en|he|fr, and
 * ?auth_error=<code> on the sign-in screen.
 */
import { render } from 'preact'
import '../styles/index.css'
import { App } from '../app.tsx'
import { initLocale, isLocale, setLocale } from '../i18n/index.ts'
import { listenToHistory } from '../router.ts'
import { boot, installClientEvents } from '../session.ts'
import { initTheme, isTheme, setTheme } from '../theme.ts'
import { fixtureRealtime, installFixtureServer } from './app-fixtures.ts'

initTheme()
initLocale()
const params = new URLSearchParams(location.search)
const theme = params.get('theme')
const lang = params.get('lang')
if (isTheme(theme)) setTheme(theme)
if (isLocale(lang)) setLocale(lang)

installFixtureServer({ signedIn: params.get('screen') !== 'signed-out' })
installClientEvents()
listenToHistory()
void boot()

const neverAsked = { token: () => new Promise<string>(() => undefined) }
render(<App connect={async () => fixtureRealtime} turnstile={neverAsked} />, document.getElementById('app')!)
