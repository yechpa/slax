/**
 * Installing Slax as an app. Chromium (Android, desktop) fires `beforeinstallprompt` when the
 * site is installable: the event is kept (no mini-infobar) and Settings offers an Install
 * button that replays it. iOS has no such prompt: Settings explains Add to Home Screen
 * instead. Once running installed (display-mode standalone), nothing is offered.
 */
import { signal } from '@preact/signals'

/** Chromium's event (not in the DOM typings). */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

/** The browser's install offer, kept until used (it can be used once) or the app is installed. */
export const installPrompt = signal<BeforeInstallPromptEvent | null>(null)

/** From start-up (main.tsx): the event can fire before Settings is ever opened. Returns the cleanup. */
export function listenForInstall(target: Window = window): () => void {
  const onPrompt = (event: Event) => {
    event.preventDefault()
    installPrompt.value = event as BeforeInstallPromptEvent
  }
  const onInstalled = () => {
    installPrompt.value = null
  }
  target.addEventListener('beforeinstallprompt', onPrompt)
  target.addEventListener('appinstalled', onInstalled)
  return () => {
    target.removeEventListener('beforeinstallprompt', onPrompt)
    target.removeEventListener('appinstalled', onInstalled)
  }
}

export type InstallVariant = 'none' | 'prompt' | 'ios'

export function installVariant({ standalone, ios, canPrompt }: { standalone: boolean; ios: boolean; canPrompt: boolean }): InstallVariant {
  if (standalone) return 'none'
  if (canPrompt) return 'prompt'
  return ios ? 'ios' : 'none'
}

/** Opened from the home screen / as an installed app. */
export function isStandalone(): boolean {
  if (globalThis.matchMedia?.('(display-mode: standalone)').matches) return true
  return (globalThis.navigator as { standalone?: boolean } | undefined)?.standalone === true
}

/** iPhone, iPod, iPad (an iPad asking for desktop sites says Macintosh, but has a touch screen). */
export function isIos(): boolean {
  const nav = globalThis.navigator
  if (!nav) return false
  return /iPhone|iPad|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
}

/** Shows the browser's install dialog (the event is spent, whatever the answer). */
export async function install(): Promise<void> {
  const event = installPrompt.value
  if (!event) return
  installPrompt.value = null
  await event.prompt()
  await event.userChoice.catch(() => undefined)
}
