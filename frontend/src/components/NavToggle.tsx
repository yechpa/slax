import type { Ref } from 'preact'
import { t } from '../i18n/index.ts'
import { SIDEBAR_ID } from './Sidebar.tsx'
import { Button } from './ui/Button.tsx'

/** Small screens only (CSS): shows or hides the channel list over the conversation. */
export function NavToggle({ open, onToggle, buttonRef }: { open: boolean; onToggle: () => void; buttonRef: Ref<HTMLButtonElement> }) {
  return (
    <Button ref={buttonRef} class="channel-header__nav" variant="quiet" size="sm" aria-expanded={open} aria-controls={SIDEBAR_ID} onClick={onToggle}>
      {t(open ? 'nav.close' : 'nav.open')}
    </Button>
  )
}
