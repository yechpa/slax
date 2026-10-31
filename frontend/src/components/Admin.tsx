/**
 * Administration (/admin), for administrators only: the server refuses every admin call to
 * anyone else (403), and this page shows nothing to them either.
 *
 * Four tabs (a tablist: arrows move between them, in reading order in either direction):
 *  - Status: each service ok or degraded, with its probe's time;
 *  - Audit: the audit log, newest first, a page at a time;
 *  - Moderation: ban someone picked from the people directory (confirmed first), lift a
 *    ban, lock or unlock a channel. Deleting a message or a file as a moderator is in the
 *    message's own menu;
 *  - Accounts: who signs in, most recently seen first; a relative is made a member (their
 *    content survives the nightly demo reset) or a demo account again, confirmed first.
 *
 * Errors are shown translated, never as raw codes. Each part follows a change of language
 * (useLocale): components without props are not re-rendered by their parent otherwise.
 */
import type { Ref } from 'preact'
import { useEffect, useId, useRef, useState } from 'preact/hooks'
import { isApiError } from '../api/client.ts'
import { api } from '../api/endpoints.ts'
import type { AdminAccount, AdminChannel, AdminStatus, AuditPage, ModeratedUser, UserSummary } from '../api/types.ts'
import { formatDay, formatTime } from '../i18n/format.ts'
import { t } from '../i18n/index.ts'
import { useLocale } from '../i18n/useLocale.ts'
import { channelById, upsertChannel } from '../store/channels.ts'
import { me } from '../store/session.ts'
import { showToast } from '../store/ui.ts'
import { Button } from './ui/Button.tsx'
import { ChannelName } from './ui/ChannelName.tsx'
import { Dialog } from './ui/Dialog.tsx'
import { EmptyState } from './ui/EmptyState.tsx'
import { NavToggle } from './NavToggle.tsx'
import { PeoplePicker } from './PeoplePicker.tsx'

type Tab = 'status' | 'audit' | 'moderation' | 'accounts'
const TABS: readonly Tab[] = ['status', 'audit', 'moderation', 'accounts']

type Props = {
  navOpen: boolean
  onToggleNav: () => void
  toggleRef: Ref<HTMLButtonElement>
}

export function Admin({ navOpen, onToggleNav, toggleRef }: Props) {
  const allowed = me.value?.is_admin === true

  useEffect(() => {
    document.title = `${t('admin.title')} · slax`
  }, [])

  return (
    <>
      <header class="channel-header">
        <NavToggle open={navOpen} onToggle={onToggleNav} buttonRef={toggleRef} />
        <div class="channel-header__title">
          <h2 class="channel-header__name" id="channel-title">
            {t('admin.title')}
          </h2>
        </div>
      </header>
      {allowed ? (
        <AdminTabs />
      ) : (
        <div class="message-pane message-pane--empty" id="messages" tabIndex={-1}>
          <EmptyState>{t('admin.forbidden')}</EmptyState>
        </div>
      )}
      <div />
    </>
  )
}

function AdminTabs() {
  // Prop-less: re-rendered by a change of language only through this.
  useLocale()
  const [tab, setTab] = useState<Tab>('status')
  const base = useId()
  const list = useRef<HTMLDivElement>(null)
  const tabId = (name: Tab) => `${base}-tab-${name}`
  const panelId = (name: Tab) => `${base}-panel-${name}`

  const onKeyDown = (event: KeyboardEvent) => {
    const rtl = list.current ? getComputedStyle(list.current).direction === 'rtl' : false
    const index = TABS.indexOf(tab)
    let next: number | null = null
    if (event.key === (rtl ? 'ArrowLeft' : 'ArrowRight')) next = (index + 1) % TABS.length
    else if (event.key === (rtl ? 'ArrowRight' : 'ArrowLeft')) next = (index - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = TABS.length - 1
    if (next === null) return
    event.preventDefault()
    setTab(TABS[next])
    list.current?.querySelector<HTMLElement>(`#${CSS.escape(tabId(TABS[next]))}`)?.focus()
  }

  return (
    <div class="admin" id="messages" tabIndex={-1}>
      <div class="admin__tabs" role="tablist" aria-label={t('admin.sections')} ref={list} onKeyDown={onKeyDown}>
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={tabId(name)}
            class="admin__tab"
            aria-selected={tab === name}
            // Only the selected tab's panel is rendered.
            aria-controls={tab === name ? panelId(name) : undefined}
            tabIndex={tab === name ? 0 : -1}
            onClick={() => setTab(name)}
          >
            {t(`admin.tab.${name}`)}
          </button>
        ))}
      </div>
      <div class="admin__panel" role="tabpanel" id={panelId(tab)} aria-labelledby={tabId(tab)} tabIndex={0}>
        {tab === 'status' && <StatusPanel />}
        {tab === 'audit' && <AuditPanel />}
        {tab === 'moderation' && <ModerationPanel />}
        {tab === 'accounts' && <AccountsPanel />}
      </div>
    </div>
  )
}

/** A translated sentence for a failed admin call (429 already has its own toast). */
export function adminError(error: unknown): string {
  const code = isApiError(error) ? error.code : 'generic'
  const key = `admin.error.${code}`
  return t(key) === key ? t('admin.error.generic') : t(key)
}

/** The error is kept as is and put in words when shown, so it follows a change of language. */
type Load<T> = { status: 'loading' } | { status: 'error'; error: unknown } | { status: 'ready'; data: T }

/** Loads on mount and on `reload()`; a late answer for an earlier call is dropped. */
function useLoad<T>(fetcher: (signal: AbortSignal) => Promise<T>, deps: unknown[]): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>({ status: 'loading' })
  const [round, setRound] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setState({ status: 'loading' })
    fetcher(controller.signal).then(
      (data) => !controller.signal.aborted && setState({ status: 'ready', data }),
      (error) => !controller.signal.aborted && setState({ status: 'error', error }),
    )
    return () => controller.abort()
    // The caller lists what the fetch depends on.
  }, [...deps, round])
  return [state, () => setRound((n) => n + 1)]
}

function Failure({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <p class="admin__error" role="alert">
      {adminError(error)}{' '}
      <Button variant="quiet" size="sm" onClick={onRetry}>
        {t('action.retry')}
      </Button>
    </p>
  )
}

const when = (iso: string) => {
  const date = new Date(iso)
  return `${formatDay(date)} ${formatTime(date)}`
}

function StatusPanel() {
  useLocale()
  const [state, reload] = useLoad<AdminStatus>((signal) => api.admin.status(signal), [])

  return (
    <section class="admin__section" aria-labelledby="admin-status-title">
      <div class="admin__bar">
        <h3 class="admin__heading" id="admin-status-title">
          {t('admin.status.title')}
        </h3>
        <Button variant="secondary" size="sm" onClick={reload} disabled={state.status === 'loading'}>
          {t('admin.status.refresh')}
        </Button>
      </div>
      {state.status === 'loading' && <p class="admin__note" aria-busy="true">{t('admin.loading')}</p>}
      {state.status === 'error' && <Failure error={state.error} onRetry={reload} />}
      {state.status === 'ready' && (
        <>
          <ul class="admin-status">
            {state.data.services.map((service) => (
              <li key={service.name} class={`admin-status__row admin-status__row--${service.status}`}>
                <span class="admin-status__name">{t(`admin.service.${service.name}`)}</span>
                <span class="admin-status__state">
                  <span class="admin-status__mark" aria-hidden="true">
                    {service.status === 'ok' ? '[ok]' : '[!!]'}
                  </span>{' '}
                  {t(`admin.status.${service.status}`)}
                </span>
                <span class="admin-status__latency">{t('admin.status.latency', { ms: service.latency_ms })}</span>
              </li>
            ))}
          </ul>
          <p class="admin__note">{t('admin.status.checked', { env: state.data.environment, time: when(state.data.checked_at) })}</p>
        </>
      )}
    </section>
  )
}

/** "user.banned" → its sentence; a failed sign-in says why in words, never as a code. */
function actionLabel(action: string): string {
  const key = `admin.action.${action}`
  if (t(key) !== key) return t(key)
  const failed = 'auth.sign_in_failed.'
  if (action.startsWith(failed)) {
    const reasonKey = `admin.reason.${action.slice(failed.length)}`
    return t('admin.action.auth.sign_in_failed', { reason: t(reasonKey) === reasonKey ? t('admin.reason.other') : t(reasonKey) })
  }
  return t('admin.action.other')
}

function AuditPanel() {
  useLocale()
  const [page, setPage] = useState(1)
  const [state, reload] = useLoad<AuditPage>((signal) => api.admin.audit(page, signal), [page])
  const data = state.status === 'ready' ? state.data : null

  return (
    <section class="admin__section" aria-labelledby="admin-audit-title">
      <div class="admin__bar">
        <h3 class="admin__heading" id="admin-audit-title">
          {t('admin.audit.title')}
        </h3>
        <span class="admin__note">{t('admin.audit.page', { page })}</span>
      </div>
      {state.status === 'loading' && <p class="admin__note" aria-busy="true">{t('admin.loading')}</p>}
      {state.status === 'error' && <Failure error={state.error} onRetry={reload} />}
      {data && data.data.length === 0 && <p class="admin__note">{t('admin.audit.empty')}</p>}
      {data && data.data.length > 0 && (
        <div class="admin-table__scroll">
          <table class="admin-table">
            <thead>
              <tr>
                <th scope="col">{t('admin.audit.when')}</th>
                <th scope="col">{t('admin.audit.what')}</th>
                <th scope="col">{t('admin.audit.who')}</th>
                <th scope="col">{t('admin.audit.target')}</th>
                <th scope="col">{t('admin.audit.ip')}</th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((entry) => (
                <tr key={entry.id}>
                  <td class="admin-table__time">{when(entry.created_at)}</td>
                  <td>{actionLabel(entry.action)}</td>
                  <td>{entry.actor ? <bdi>{entry.actor.name}</bdi> : <span class="admin__muted">{t('admin.audit.system')}</span>}</td>
                  <td>
                    {entry.target && (
                      <>
                        <span class="admin__muted">{t(`admin.target.${entry.target.type}`)}</span>{' '}
                        {entry.target.type === 'channel' && entry.target.label ? (
                          <ChannelName name={entry.target.label} />
                        ) : (
                          <bdi>{entry.target.label ?? `#${entry.target.id}`}</bdi>
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    <bdi dir="ltr" class="admin-table__ip">
                      {entry.ip ?? '—'}
                    </bdi>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div class="admin__pager">
        <Button variant="secondary" size="sm" onClick={() => setPage(page - 1)} disabled={page <= 1 || state.status === 'loading'}>
          {t('admin.audit.newer')}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setPage(page + 1)} disabled={!data?.has_more || state.status === 'loading'}>
          {t('admin.audit.older')}
        </Button>
      </div>
    </section>
  )
}

function ModerationPanel() {
  useLocale()
  return (
    <>
      <BanSection />
      <LockSection />
      <p class="admin__note">{t('admin.moderation.messagesHint')}</p>
    </>
  )
}

function BanSection() {
  useLocale()
  const [picked, setPicked] = useState<UserSummary | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [banned, reload] = useLoad<{ data: ModeratedUser[] }>((signal) => api.admin.banned(signal), [])
  const [list, setList] = useState<ModeratedUser[] | null>(null)
  const [lifting, setLifting] = useState<number | null>(null)
  const people = list ?? (banned.status === 'ready' ? banned.data.data : [])

  useEffect(() => {
    if (banned.status === 'ready') setList(banned.data.data)
  }, [banned])

  const ban = async () => {
    if (!picked) return
    setBusy(true)
    setError(null)
    try {
      const user = await api.admin.ban(picked.id, true)
      setList([user, ...people.filter((p) => p.id !== user.id)])
      showToast({ tone: 'success', text: t('admin.ban.done', { name: user.name }), key: 'admin-ban' })
      setPicked(null)
    } catch (failure) {
      if (!isApiError(failure, 'rate_limited')) setError(failure)
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  const lift = async (person: ModeratedUser) => {
    setError(null)
    setLifting(person.id)
    try {
      await api.admin.ban(person.id, false)
      setList(people.filter((p) => p.id !== person.id))
      showToast({ tone: 'success', text: t('admin.ban.lifted', { name: person.name }), key: 'admin-ban' })
    } catch (failure) {
      if (!isApiError(failure, 'rate_limited')) setError(failure)
    } finally {
      setLifting(null)
    }
  }

  return (
    <section class="admin__section" aria-labelledby="admin-ban-title">
      <h3 class="admin__heading" id="admin-ban-title">
        {t('admin.ban.title')}
      </h3>
      <div class="admin__ban">
        <PeoplePicker
          label={t('admin.ban.who')}
          placeholder={t('people.placeholder')}
          hint={t('admin.ban.hint')}
          selected={picked ? [picked] : []}
          onSelect={(person) => {
            setPicked(person)
            setError(null)
          }}
          onRemove={() => setPicked(null)}
          full={picked !== null}
          fullText={t('admin.ban.one')}
        />
        <Button variant="danger" onClick={() => setConfirming(true)} disabled={!picked || busy}>
          {t('admin.ban.submit')}
        </Button>
      </div>
      {error !== null && (
        <p class="admin__error" role="alert">
          {adminError(error)}
        </p>
      )}

      <h4 class="admin__subheading">{t('admin.ban.list')}</h4>
      {banned.status === 'loading' && <p class="admin__note" aria-busy="true">{t('admin.loading')}</p>}
      {banned.status === 'error' && <Failure error={banned.error} onRetry={reload} />}
      {banned.status === 'ready' && people.length === 0 && <p class="admin__note">{t('admin.ban.none')}</p>}
      {people.length > 0 && (
        <ul class="admin-list">
          {people.map((person) => (
            <li key={person.id} class="admin-list__row">
              <bdi class="admin-list__name">{person.name}</bdi>
              {person.banned_at && <span class="admin__muted">{t('admin.ban.since', { time: when(person.banned_at) })}</span>}
              <Button variant="secondary" size="sm" onClick={() => void lift(person)} disabled={lifting === person.id}>
                {t('admin.ban.lift')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {confirming && picked && (
        <Dialog
          role="alertdialog"
          title={t('admin.ban.confirmTitle', { name: picked.name })}
          description={t('admin.ban.confirmBody')}
          onClose={() => !busy && setConfirming(false)}
          footer={
            <>
              <Button variant="secondary" data-autofocus onClick={() => setConfirming(false)} disabled={busy}>
                {t('action.cancel')}
              </Button>
              <Button variant="danger" onClick={() => void ban()} disabled={busy}>
                {t('admin.ban.submit')}
              </Button>
            </>
          }
        />
      )}
    </section>
  )
}

function LockSection() {
  useLocale()
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<unknown>(null)
  // Every room, from the admin API: private ones the administrator is not in included.
  const [loaded, reload] = useLoad<{ data: AdminChannel[] }>((signal) => api.admin.channels(signal), [])
  const [list, setList] = useState<AdminChannel[]>([])

  useEffect(() => {
    if (loaded.status === 'ready') setList(loaded.data.data)
  }, [loaded])

  const toggle = async (channel: AdminChannel) => {
    setBusy(channel.id)
    setError(null)
    try {
      const result = await api.admin.lock(channel.id, !channel.locked)
      setList((current) => current.map((c) => (c.id === channel.id ? { ...c, locked: result.locked } : c)))
      // The sidebar's copy, when the administrator has this channel there.
      const known = channelById.peek().get(channel.id)
      if (known) upsertChannel({ ...known, locked: result.locked })
      showToast({ tone: 'success', text: t(result.locked ? 'admin.lock.done' : 'admin.lock.lifted', { channel: `#${channel.name}` }), key: 'admin-lock' })
    } catch (failure) {
      if (!isApiError(failure, 'rate_limited')) setError(failure)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section class="admin__section" aria-labelledby="admin-lock-title">
      <h3 class="admin__heading" id="admin-lock-title">
        {t('admin.lock.title')}
      </h3>
      <p class="admin__note">{t('admin.lock.hint')}</p>
      {error !== null && (
        <p class="admin__error" role="alert">
          {adminError(error)}
        </p>
      )}
      {loaded.status === 'loading' && <p class="admin__note" aria-busy="true">{t('admin.loading')}</p>}
      {loaded.status === 'error' && <Failure error={loaded.error} onRetry={reload} />}
      <ul class="admin-list">
        {list.map((channel) => (
          <li key={channel.id} class="admin-list__row">
            <ChannelName name={channel.name} />
            {channel.kind === 'private' && <span class="admin__muted">{t('channel.private')}</span>}
            <span class={channel.locked ? 'admin__badge admin__badge--locked' : 'admin__badge'}>
              {t(channel.locked ? 'admin.lock.locked' : 'admin.lock.open')}
            </span>
            <Button variant="secondary" size="sm" onClick={() => void toggle(channel)} disabled={busy === channel.id}>
              {t(channel.locked ? 'admin.lock.unlock' : 'admin.lock.lock')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Members and demo accounts. Everyone who signs up is a demo account (deleted with their
 * content by the nightly reset of the public demo); a relative is made a member so that what
 * they write stays. Either change is confirmed first, saying what it means.
 */
function AccountsPanel() {
  useLocale()
  const [loaded, reload] = useLoad<{ data: AdminAccount[] }>((signal) => api.admin.accounts(signal), [])
  const [list, setList] = useState<AdminAccount[]>([])
  const [confirming, setConfirming] = useState<AdminAccount | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    if (loaded.status === 'ready') setList(loaded.data.data)
  }, [loaded])

  const target = confirming?.account_type === 'member' ? 'demo' : 'member'

  const change = async () => {
    if (!confirming) return
    setBusy(true)
    setError(null)
    try {
      const account = await api.admin.setAccountType(confirming.id, target)
      setList((current) => current.map((a) => (a.id === account.id ? account : a)))
      showToast({
        tone: 'success',
        text: t(account.account_type === 'member' ? 'admin.accounts.madeMember' : 'admin.accounts.madeDemo', { name: account.name }),
        key: 'admin-account',
      })
    } catch (failure) {
      if (!isApiError(failure, 'rate_limited')) setError(failure)
      // What the server holds now, not what this page thought (another administrator, a race).
      reload()
    } finally {
      setBusy(false)
      setConfirming(null)
    }
  }

  return (
    <section class="admin__section" aria-labelledby="admin-accounts-title">
      <h3 class="admin__heading" id="admin-accounts-title">
        {t('admin.accounts.title')}
      </h3>
      <p class="admin__note">{t('admin.accounts.hint')}</p>
      {error !== null && (
        <p class="admin__error" role="alert">
          {adminError(error)}
        </p>
      )}
      {loaded.status === 'loading' && <p class="admin__note" aria-busy="true">{t('admin.loading')}</p>}
      {loaded.status === 'error' && <Failure error={loaded.error} onRetry={reload} />}
      {loaded.status === 'ready' && list.length === 0 && <p class="admin__note">{t('admin.accounts.none')}</p>}
      <ul class="admin-list">
        {list.map((account) => (
          <li key={account.id} class="admin-list__row">
            <bdi class="admin-list__name">{account.name}</bdi>
            <span class={account.administrator || account.account_type === 'member' ? 'admin__badge admin__badge--member' : 'admin__badge'}>
              {t(account.administrator ? 'admin.accounts.admin' : account.account_type === 'member' ? 'admin.accounts.member' : 'admin.accounts.demo')}
            </span>
            {account.banned && <span class="admin__muted">{t('admin.accounts.banned')}</span>}
            <span class="admin__muted">
              {account.last_seen_at ? t('admin.accounts.seen', { time: when(account.last_seen_at) }) : t('admin.accounts.never')}
            </span>
            {!account.administrator && (
              <Button variant="secondary" size="sm" onClick={() => setConfirming(account)} disabled={busy}>
                {t(account.account_type === 'member' ? 'admin.accounts.makeDemo' : 'admin.accounts.makeMember')}
              </Button>
            )}
          </li>
        ))}
      </ul>

      {confirming && (
        <Dialog
          role="alertdialog"
          title={t(target === 'member' ? 'admin.accounts.memberTitle' : 'admin.accounts.demoTitle', { name: confirming.name })}
          description={t(target === 'member' ? 'admin.accounts.memberBody' : 'admin.accounts.demoBody')}
          onClose={() => !busy && setConfirming(null)}
          footer={
            <>
              <Button variant="secondary" data-autofocus onClick={() => setConfirming(null)} disabled={busy}>
                {t('action.cancel')}
              </Button>
              <Button variant={target === 'member' ? 'primary' : 'danger'} onClick={() => void change()} disabled={busy}>
                {t(target === 'member' ? 'admin.accounts.makeMember' : 'admin.accounts.makeDemo')}
              </Button>
            </>
          }
        />
      )}
    </section>
  )
}
