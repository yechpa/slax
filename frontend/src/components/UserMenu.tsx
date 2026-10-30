/**
 * The account menu at the foot of the sidebar: who is signed in, language and theme
 * (applied at once, remembered on this device and saved to the account), administration
 * (administrators only), sign out.
 * A disclosure: the button toggles the panel above it; Escape or a click elsewhere
 * closes it and focus returns to the button.
 */
import { useEffect, useId, useRef, useState } from 'preact/hooks'
import { isApiError } from '../api/client.ts'
import { api } from '../api/endpoints.ts'
import { t } from '../i18n/index.ts'
import { useLocale } from '../i18n/useLocale.ts'
import { ADMIN_PATH } from '../router.ts'
import { endSession } from '../session.ts'
import { me } from '../store/session.ts'
import { navOpen, showToast } from '../store/ui.ts'
import { Avatar } from './ui/Avatar.tsx'
import { Button } from './ui/Button.tsx'
import { userHue } from './ui/hue.ts'
import { LocaleSwitcher } from './ui/LocaleSwitcher.tsx'
import { ThemeSwitcher } from './ui/ThemeSwitcher.tsx'

/** Saved to the account in the background; the choice already applies locally. */
function save(changes: Parameters<typeof api.updateMe>[0]): void {
  api.updateMe(changes).catch(() => undefined)
}

/** Prop-less: re-rendered on a change of language by useLocale only (see Workspace). */
export function UserMenu() {
  useLocale()
  const user = me.value
  const [open, setOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const panelId = useId()
  const root = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (restoreFocus: boolean) => {
      setOpen(false)
      if (restoreFocus) toggle.current?.focus()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close(true)
      }
    }
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close(false)
    }
    root.current?.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer)
    return () => {
      root.current?.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer)
    }
  }, [open])

  if (!user) return null

  const signOut = async () => {
    setLeaving(true)
    try {
      await api.logout()
    } catch (error) {
      if (!isApiError(error, 'unauthenticated')) {
        setLeaving(false)
        showToast({ tone: 'error', text: t('error.signOutFailed'), key: 'sign-out' })
        return
      }
    }
    endSession(null)
  }

  return (
    <div class="user-menu" ref={root}>
      {/* Always rendered (hidden when closed), so aria-controls points at it. */}
      <div class="user-menu__panel" id={panelId} hidden={!open}>
        <p class="user-menu__who">
          {t('user.signedInAs', { name: user.name })}
          <bdi class="user-menu__email">{user.email}</bdi>
        </p>
        <LocaleSwitcher onChange={(locale) => save({ locale })} />
        <ThemeSwitcher onChange={(theme) => save({ theme })} />
        {user.is_admin && (
          <a
            class="user-menu__admin"
            href={ADMIN_PATH}
            onClick={() => {
              // Closes the menu, and the channel drawer it sits in on small screens.
              setOpen(false)
              navOpen.value = false
            }}
          >
            {t('admin.open')}
          </a>
        )}
        <Button variant="secondary" size="sm" class="user-menu__signout" onClick={() => void signOut()} disabled={leaving}>
          {t('action.signOut')}
        </Button>
      </div>
      <button
        ref={toggle}
        type="button"
        class="user-menu__toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
      >
        <Avatar name={user.name} hue={userHue(String(user.id))} size="sm" />
        <bdi class="user-menu__name">{user.name}</bdi>
        <span class="sr-only">{t('user.menu')}</span>
        <span class="user-menu__caret" aria-hidden="true">
          {open ? '[-]' : '[+]'}
        </span>
      </button>
    </div>
  )
}
