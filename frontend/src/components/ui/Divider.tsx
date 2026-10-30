/** "──── today ────" between days, or the red "new messages" rule. */
export function Divider({ label, tone }: { label: string; tone?: 'new' }) {
  return (
    <div class={tone === 'new' ? 'divider divider--new' : 'divider'} role="separator">
      {label}
    </div>
  )
}
