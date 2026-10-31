import type { ComponentChildren } from 'preact'
import { useState } from 'preact/hooks'
import { Avatar } from '../components/ui/Avatar.tsx'
import { Brand } from '../components/ui/Brand.tsx'
import { Button } from '../components/ui/Button.tsx'
import { Composer } from '../components/ui/Composer.tsx'
import { EmptyState } from '../components/ui/EmptyState.tsx'
import { FileChip } from '../components/ui/FileChip.tsx'
import { LocaleSwitcher } from '../components/ui/LocaleSwitcher.tsx'
import { Mention } from '../components/ui/Mention.tsx'
import { Message } from '../components/ui/Message.tsx'
import { NavItem } from '../components/ui/NavItem.tsx'
import { PresenceDot } from '../components/ui/PresenceDot.tsx'
import { ReactionChip } from '../components/ui/ReactionChip.tsx'
import { SearchField } from '../components/ui/SearchField.tsx'
import { TextField } from '../components/ui/TextField.tsx'
import { ThemeSwitcher } from '../components/ui/ThemeSwitcher.tsx'
import { ThreadLink } from '../components/ui/ThreadLink.tsx'
import { Toast } from '../components/ui/Toast.tsx'
import { Tombstone } from '../components/ui/Tombstone.tsx'
import { TypingIndicator } from '../components/ui/TypingIndicator.tsx'
import { t } from '../i18n/index.ts'
import { useLocale } from '../i18n/useLocale.ts'
import { useTheme } from '../useTheme.ts'
import { ShellDemo } from './ShellDemo.tsx'
import { GRAFANA_URL, people, time } from './sample.ts'
import { Scales, Swatches } from './Tokens.tsx'

const FONT_TEST = 'שלום hello 123 — k3s נבדק'

const TYPE_SCALE = [
  ['2xl', 36],
  ['xl', 26],
  ['lg', 20],
  ['md', 16],
  ['base', 14],
  ['sm', 13],
  ['xs', 12],
  ['2xs', 11],
] as const

function Section({ id, title, wide = false, children }: { id: string; title: string; wide?: boolean; children: ComponentChildren }) {
  return (
    <section class={wide ? 'ds-section ds-section--wide' : 'ds-section'} aria-labelledby={id}>
      <h2 class="ds-section__title" id={id}>
        {title}
      </h2>
      {children}
    </section>
  )
}

function Caption({ children }: { children: ComponentChildren }) {
  return <code class="ds-caption">{children}</code>
}

export function KitchenSink() {
  // Re-render everything (strings, number and time formats) when either preference changes.
  useLocale()
  useTheme()
  const [draft, setDraft] = useState('')
  const { dana, noam, lea, yael, omer, maya } = people

  return (
    <>
      <a class="skip-link" href="#messages">
        {t('a11y.skipToContent')}
      </a>
      <header class="ds-topbar">
        <Brand cursor />
        <span class="ds-topbar__title">{t('ds.title')}</span>
        <div class="ds-topbar__controls">
          <LocaleSwitcher />
          <ThemeSwitcher />
        </div>
      </header>

      <main class="ds-main">
        <div class="ds-intro">
          <h1>{t('ds.title')}</h1>
          <p class="dim">{t('ds.intro')}</p>
        </div>

        <Section id="ds-shell" title={t('ds.shell')} wide>
          <ShellDemo />
        </Section>

        <div class="ds-grid">
          <Section id="ds-type" title={t('ds.type')}>
            <div class="ds-type">
              {TYPE_SCALE.map(([name, px]) => (
                <div class="ds-type__row" key={name}>
                  <Caption>
                    {name} {px}
                  </Caption>
                  <span class="ds-type__sample" style={{ fontSize: `var(--text-${name})` }}>
                    {t('ds.typeSample')}
                  </span>
                </div>
              ))}
            </div>
            <div class="ds-specimen">
              <p dir="auto" lang="he" class="ds-specimen__line">
                {FONT_TEST}
              </p>
              <p dir="auto" lang="he" class="ds-specimen__line ds-specimen__line--strong">
                {FONT_TEST}
              </p>
              <Caption>Cascadia Mono 300 / 700 · OFL</Caption>
            </div>
          </Section>

          <Section id="ds-colors" title={t('ds.colors')}>
            <Swatches />
            <Scales />
          </Section>

          <Section id="ds-buttons" title={t('ds.buttons')}>
            <div class="ds-rows">
              <div class="cluster">
                <Button variant="primary">{t('action.send')}</Button>
                <Button variant="secondary">{t('action.join')}</Button>
                <Button variant="quiet">{t('action.cancel')}</Button>
                <Button variant="danger">{t('action.delete')}</Button>
              </div>
              <div class="cluster">
                <Button variant="primary" size="sm">
                  {t('action.save')}
                </Button>
                <Button variant="secondary" size="sm">
                  {t('action.leave')}
                </Button>
                <Button variant="quiet" size="sm">
                  {t('action.edit')}
                </Button>
                <Button variant="secondary" size="sm" icon aria-label={t('action.upload')} title={t('action.upload')}>
                  +
                </Button>
                <Button variant="primary" size="sm" disabled>
                  {t('action.upload')}
                </Button>
              </div>
              <Caption>.btn--primary · --secondary · --quiet · --danger · --sm · :disabled</Caption>
            </div>
          </Section>

          <Section id="ds-inputs" title={t('ds.inputs')}>
            <div class="ds-rows">
              <TextField label={t('ds.input.name')} hint={t('ds.input.nameHint')} defaultValue="dana" />
              <TextField label={t('ds.input.channel')} error={t('ds.input.channelError')} defaultValue="Release Notes" />
              <SearchField />
            </div>
          </Section>

          <Section id="ds-sidebar" title={t('ds.sidebar')}>
            <div class="ds-sidebar-sample">
              <NavItem name="general" href="#" selected />
              <NavItem name="engineering" href="#" unread={3} />
              <NavItem name="security" href="#" />
              <NavItem name="random" href="#" muted unread={12} />
              <NavItem name={dana.name} href="#" presence="online" />
              <NavItem name={noam.name} lang={noam.lang} href="#" presence="away" unread={2} />
              <NavItem name={omer.name} href="#" presence="offline" />
            </div>
            <Caption>[aria-current=page] · --unread · --muted · presence</Caption>
          </Section>

          <Section id="ds-presence" title={t('ds.presence')}>
            <div class="ds-rows">
              <div class="cluster ds-gap-6">
                <PresenceDot status="online" labelled />
                <PresenceDot status="away" labelled />
                <PresenceDot status="offline" labelled />
              </div>
              <div class="cluster ds-gap-4">
                {[dana, noam, maya, lea, yael, omer].map((p) => (
                  <span key={p.name} lang={p.lang}>
                    <Avatar name={p.name} hue={p.hue} presence={p.presence} />
                  </span>
                ))}
              </div>
            </div>
          </Section>

          <Section id="ds-messages" title={t('ds.messages')} wide>
            <div class="ds-messages">
              <Message
                author={dana.name}
                hue={dana.hue}
                time={time(14, 5)}
                edited
                lang="en"
                footer={
                  <>
                    <div class="message__reactions">
                      <ReactionChip emoji="✅" count={2} mine />
                      <ReactionChip emoji="🔥" count={5} />
                    </div>
                    <ThreadLink href="#" replies={2} lastReply={time(14, 20).label} />
                  </>
                }
              >
                Backups restored on staging in 4 min. Runbook updated.
              </Message>
              <Message
                author={yael.name}
                authorLang={yael.lang}
                hue={yael.hue}
                time={time(14, 7)}
                lang="he"
                footer={<ThreadLink href="#" replies={1} />}
              >
                הגיבוי עלה ב־staging, אפשר לבדוק את ה־dashboard כאן:{' '}
                <a href={GRAFANA_URL} dir="ltr">
                  {GRAFANA_URL}
                </a>{' '}
                👍
              </Message>
              <Tombstone time={time(14, 9)} />
            </div>
          </Section>

          <Section id="ds-bidi" title={t('ds.bidi')}>
            <p class="dim ds-note">{t('ds.bidiNote')}</p>
            <div class="ds-messages">
              <Message author={noam.name} authorLang={noam.lang} hue={noam.hue} time={time(15, 1)} lang="he">
                שלחתי PR חדש ל־<code>slax-api</code>, מי שיכול לעשות review לפני 17:00?
              </Message>
              <Message author={omer.name} hue={omer.hue} time={time(15, 2)} lang="en">
                On it. Looks like <Mention name={noam.name} lang={noam.lang} /> fixed the RTL bug (#42).
              </Message>
            </div>
          </Section>

          <Section id="ds-composer" title={t('ds.composer')}>
            <div class="ds-rows">
              <Composer channel="#engineering" value={draft} onInput={setDraft} onSend={() => setDraft('')} onAttach={() => undefined} maxLength={4000} />
              <Composer
                channel="#עיצוב"
                value="מצרפת את הקבצים של ה־mockups"
                onInput={() => undefined}
                onAttach={() => undefined}
                files={
                  <>
                    <FileChip name="mockup-listing.pdf" bytes={1_240_000} onRemove={() => undefined} />
                    <FileChip name="סקיצה-ראשונה.png" bytes={387_000} onRemove={() => undefined} />
                  </>
                }
              />
            </div>
          </Section>

          <Section id="ds-feedback" title={t('ds.feedback')}>
            <div class="ds-rows">
              <Toast tone="success" onClose={() => undefined}>
                {t('toast.saved')}
              </Toast>
              <Toast
                tone="error"
                action={
                  <Button variant="secondary" size="sm">
                    {t('action.retry')}
                  </Button>
                }
                onClose={() => undefined}
              >
                {t('error.sendFailed')}
              </Toast>
              <Toast tone="info">{t('error.network')}</Toast>
              <div class="cluster">
                <FileChip name="k3s-cluster-runbook.md" bytes={18_400} />
                <FileChip name="backup-2026-10-30.tar.gz" bytes={48_200_000} state="scanning" />
                <FileChip name="invoice.exe" bytes={2_100_000} state="error" onRemove={() => undefined} />
              </div>
              <div class="ds-typing">
                <TypingIndicator names={[dana.name]} />
                <TypingIndicator names={[dana.name, noam.name]} />
                <TypingIndicator names={[dana.name, noam.name, lea.name]} />
              </div>
            </div>
          </Section>

          <Section id="ds-empty" title={t('ds.empty')}>
            <EmptyState>{t('empty.channel', { channel: '#security' })}</EmptyState>
          </Section>

          <Section id="ds-switchers" title={t('ds.switchers')}>
            <div class="ds-rows">
              <LocaleSwitcher />
              <ThemeSwitcher />
              <p class="muted ds-note">
                {t('theme.console')}: {t('theme.console.hint')} · {t('theme.listing')}: {t('theme.listing.hint')}
              </p>
            </div>
          </Section>
        </div>
      </main>
    </>
  )
}
