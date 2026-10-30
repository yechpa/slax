import { useState } from 'preact/hooks'
import { Brand } from '../components/ui/Brand.tsx'
import { Button } from '../components/ui/Button.tsx'
import { ChannelName } from '../components/ui/ChannelName.tsx'
import { Composer } from '../components/ui/Composer.tsx'
import { Divider } from '../components/ui/Divider.tsx'
import { Mention } from '../components/ui/Mention.tsx'
import { Message } from '../components/ui/Message.tsx'
import { NavItem } from '../components/ui/NavItem.tsx'
import { ReactionChip } from '../components/ui/ReactionChip.tsx'
import { SearchField } from '../components/ui/SearchField.tsx'
import { ThreadLink } from '../components/ui/ThreadLink.tsx'
import { Tombstone } from '../components/ui/Tombstone.tsx'
import { TypingIndicator } from '../components/ui/TypingIndicator.tsx'
import { plural, t } from '../i18n/index.ts'
import { GRAFANA_URL, channels, directMessages, people, time } from './sample.ts'

const { dana, noam, maya, lea } = people

function MessageActions() {
  return (
    <>
      <Button variant="quiet" size="sm" aria-label={t('action.react')} title={t('action.react')}>
        <span dir="ltr">+:)</span>
      </Button>
      <Button variant="quiet" size="sm">
        {t('action.reply')}
      </Button>
      <Button variant="quiet" size="sm">
        {t('action.edit')}
      </Button>
    </>
  )
}

/** The whole application frame: sidebar, channel header, message list, typing line, composer. */
export function ShellDemo() {
  const [navOpen, setNavOpen] = useState(false)
  const [draft, setDraft] = useState('')
  return (
    <div class={navOpen ? 'shell shell--nav-open ds-shell' : 'shell ds-shell'}>
      <nav class="sidebar" aria-label={t('nav.label')}>
        <div class="sidebar__brand">
          <Brand />
        </div>
        <h3 class="sidebar__heading">
          <span class="sidebar__heading-label">{t('nav.channels')}</span>
          <Button variant="quiet" size="sm" icon aria-label={t('nav.newChannel')} title={t('nav.newChannel')}>
            +
          </Button>
        </h3>
        {channels.map((c) => (
          <NavItem
            key={c.name}
            name={c.name}
            lang={c.lang}
            href="#"
            selected={c.selected}
            unread={c.unread}
            muted={c.muted}
          />
        ))}
        <h3 class="sidebar__heading">
          <span class="sidebar__heading-label">{t('nav.directMessages')}</span>
        </h3>
        {directMessages.map(({ key, unread }) => (
          <NavItem
            key={key}
            name={people[key].name}
            lang={people[key].lang}
            href="#"
            presence={people[key].presence}
            unread={unread}
          />
        ))}
      </nav>

      <section class="shell__main" aria-labelledby="ds-channel-name">
        <header class="channel-header">
          <Button
            class="channel-header__nav"
            variant="quiet"
            size="sm"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(!navOpen)}
          >
            {t(navOpen ? 'nav.close' : 'nav.open')}
          </Button>
          <div class="channel-header__title">
            <h2 class="channel-header__name" id="ds-channel-name">
              <ChannelName name="general" />
            </h2>
            <span class="channel-header__meta">{plural('channel.members', 12)}</span>
          </div>
          <SearchField class="channel-header__search" />
        </header>

        <div class="message-list" id="messages" tabIndex={0} role="log" aria-label={t('message.list', { channel: '#general' })}>
          <div class="message-list__paper">
            <Divider label={t('time.today')} />
            <Message author={maya.name} hue={maya.hue} time={time(9, 38)} lang="en">
              Morning! Release notes for v1.4 are in the shared doc.
            </Message>
            <Message
              author={dana.name}
              hue={dana.hue}
              time={time(9, 41)}
              lang="en"
              footer={
                <>
                  <div class="message__reactions">
                    <ReactionChip emoji="🚀" count={3} mine />
                    <ReactionChip emoji="👀" count={1} />
                  </div>
                  <ThreadLink href="#" replies={3} lastReply={time(10, 2).label} />
                </>
              }
              actions={<MessageActions />}
            >
              k3s deploy went through, everything is green.
            </Message>
            <Message author={noam.name} authorLang={noam.lang} hue={noam.hue} time={time(9, 43)} edited lang="he">
              מעולה. אני בודק את ה־metrics ב־Grafana:{' '}
              <a href={GRAFANA_URL} dir="ltr">
                {GRAFANA_URL}
              </a>
            </Message>
            <Message author={lea.name} hue={lea.hue} time={time(9, 44)} mentioned lang="fr">
              Je regarde les logs de <Mention name={dana.name} />, rien d’anormal.
            </Message>
            <Tombstone time={time(9, 45)} />
            <Divider label={t('divider.unread')} tone="new" />
            <Message author={maya.name} hue={maya.hue} time={time(9, 46)} lang="en">
              Can someone review PR #128 before lunch? <code>make test</code> passes locally.
            </Message>
          </div>
        </div>

        <footer class="shell__footer">
          {/* t() wraps each name in Unicode isolates (FSI…PDI), the plain-text <bdi>. */}
          <TypingIndicator names={[noam.name]} />
          <Composer channel="#general" value={draft} onInput={setDraft} onSend={() => setDraft('')} />
        </footer>
      </section>
    </div>
  )
}
