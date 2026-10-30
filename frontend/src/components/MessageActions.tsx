/**
 * What can be done to a message: react, reply in its thread, (its author) edit or
 * delete, and (an administrator, on someone else's) delete it or one of its files as a
 * moderator. The quick buttons show on hover or keyboard focus; the "more" button opens a
 * menu with every action, and it stays visible on touch screens (no hover there), so
 * nothing depends on hovering. The server decides in the end; errors come back as toasts.
 */
import { useEffect, useRef, useState } from 'preact/hooks'
import { t } from '../i18n/index.ts'
import { EmojiPicker } from './ui/EmojiPicker.tsx'
import { Popover } from './ui/Popover.tsx'

type Props = {
  /** Member of the channel: may react and reply. */
  canPost: boolean
  /** The current user wrote it: may edit (while a member) and delete. */
  mine: boolean
  /** Absent in a thread (replies have no thread of their own). */
  onReply?: () => void
  onReact: (emoji: string) => void
  onEdit: () => void
  onDelete: () => void
  /** An administrator, on someone else's message: moderation items (each confirmed first). */
  moderation?: {
    files: readonly { id: number; name: string }[]
    onDeleteMessage: () => void
    onDeleteFile: (fileId: number) => void
  }
  /** A menu or the picker is open: the toolbar stays shown. */
  onOpenChange?: (open: boolean) => void
}

type Open = null | 'menu' | 'picker' | 'picker-from-menu'

export function MessageActions({ canPost, mine, onReply, onReact, onEdit, onDelete, moderation, onOpenChange }: Props) {
  const [open, setOpen] = useState<Open>(null)
  const reactButton = useRef<HTMLButtonElement>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const report = useRef(onOpenChange)
  report.current = onOpenChange

  useEffect(() => report.current?.(open !== null), [open])

  const items: Item[] = []
  if (canPost && onReply) items.push({ label: t('action.reply'), run: onReply })
  // The picker takes the menu's place, at the same spot.
  if (canPost) items.push({ label: t('action.react'), run: () => setOpen('picker-from-menu'), replacesMenu: true })
  if (mine && canPost) items.push({ label: t('action.edit'), run: onEdit })
  if (mine) items.push({ label: t('action.delete'), run: onDelete, danger: true })
  if (moderation && !mine) {
    items.push({ label: t('moderation.deleteMessage'), run: moderation.onDeleteMessage, danger: true })
    for (const file of moderation.files) {
      items.push({ key: `file-${file.id}`, label: t('moderation.deleteFile', { name: file.name }), run: () => moderation.onDeleteFile(file.id), danger: true })
    }
  }
  if (items.length === 0) return null

  const close = (restoreFocus: boolean, anchor = moreButton) => {
    setOpen(null)
    if (restoreFocus) anchor.current?.focus()
  }

  return (
    <>
      {canPost && (
        <button
          ref={reactButton}
          type="button"
          class="message-actions__btn message-actions__quick"
          aria-label={t('action.react')}
          title={t('action.react')}
          aria-expanded={open === 'picker'}
          onClick={() => setOpen(open === 'picker' ? null : 'picker')}
        >
          :)
        </button>
      )}
      {canPost && onReply && (
        <button type="button" class="message-actions__btn message-actions__quick" aria-label={t('action.reply')} title={t('action.reply')} onClick={onReply}>
          -&gt;
        </button>
      )}
      <button
        ref={moreButton}
        type="button"
        class="message-actions__btn message-actions__more"
        aria-label={t('message.more')}
        title={t('message.more')}
        aria-haspopup="menu"
        aria-expanded={open === 'menu'}
        onClick={() => setOpen(open === 'menu' ? null : 'menu')}
      >
        ···
      </button>
      {open === 'menu' && (
        <Popover anchor={moreButton} onClose={(restore) => close(restore)}>
          <Menu
            items={items}
            onDone={(item) => {
              if (!item.replacesMenu) setOpen(null)
              item.run()
            }}
            onTab={() => setOpen(null)}
          />
        </Popover>
      )}
      {(open === 'picker' || open === 'picker-from-menu') && (
        <Popover anchor={open === 'picker' ? reactButton : moreButton} onClose={(restore) => close(restore, open === 'picker' ? reactButton : moreButton)}>
          <EmojiPicker
            onPick={(emoji) => {
              close(true, open === 'picker' ? reactButton : moreButton)
              onReact(emoji)
            }}
          />
        </Popover>
      )}
    </>
  )
}

type Item = { label: string; run: () => void; danger?: boolean; replacesMenu?: boolean; key?: string }

/** A menu: focus on its first item, arrows move, Home/End, Tab leaves (and closes it). */
export function Menu({ items, onDone, onTab }: { items: Item[]; onDone: (item: Item) => void; onTab: () => void }) {
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [])
  const onKeyDown = (event: KeyboardEvent) => {
    const all = [...(list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const index = all.indexOf(document.activeElement as HTMLElement)
    let next: number | null = null
    if (event.key === 'ArrowDown') next = (index + 1) % all.length
    else if (event.key === 'ArrowUp') next = (index - 1 + all.length) % all.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = all.length - 1
    else if (event.key === 'Tab') onTab()
    if (next === null) return
    event.preventDefault()
    all[next]?.focus()
  }
  return (
    <div class="menu" role="menu" ref={list} onKeyDown={onKeyDown}>
      {items.map((item) => (
        <button
          key={item.key ?? item.label}
          type="button"
          role="menuitem"
          tabIndex={-1}
          class={item.danger ? 'menu__item menu__item--danger' : 'menu__item'}
          onClick={() => onDone(item)}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
