/**
 * The public legal pages (/privacy, /terms): the same document for everyone, signed in or
 * not, in the current language (the switchers are on the page). The text is in src/legal.
 */
import { useEffect } from 'preact/hooks'
import { getLocale, t } from '../i18n/index.ts'
import { useLocale } from '../i18n/useLocale.ts'
import { legalDocument } from '../legal/index.ts'
import type { Block, LegalPage } from '../legal/types.ts'
import { Brand } from './ui/Brand.tsx'
import { LocaleSwitcher } from './ui/LocaleSwitcher.tsx'
import { ThemeSwitcher } from './ui/ThemeSwitcher.tsx'

const formatUpdated = (iso: string) =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`))

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block) =>
        typeof block === 'string' ? (
          <p key={block}>{block}</p>
        ) : (
          <ul key={block[0]}>
            {block.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ),
      )}
    </>
  )
}

export function Legal({ page }: { page: LegalPage }) {
  // Not driven by props: re-rendered when the language changes.
  useLocale()
  const doc = legalDocument(page, getLocale())

  useEffect(() => {
    document.title = `${doc.title} · slax`
    return () => {
      document.title = 'slax'
    }
  }, [doc.title])

  const other: LegalPage = page === 'privacy' ? 'terms' : 'privacy'
  return (
    <div class="legal">
      <div class="signin__prefs">
        <LocaleSwitcher />
        <ThemeSwitcher />
      </div>
      <main class="legal__main" id="main">
        <p class="legal__brand">
          <a href="/" aria-label={t('legal.back')}>
            <Brand />
          </a>
        </p>
        <article class="legal__doc">
          <h1 class="legal__title">{doc.title}</h1>
          <p class="legal__updated">{t('legal.updated', { date: formatUpdated(doc.updated) })}</p>
          <p>{doc.intro}</p>
          {doc.sections.map((section) => (
            <section key={section.id} id={section.id} aria-labelledby={`${page}-${section.id}`}>
              <h2 id={`${page}-${section.id}`}>{section.heading}</h2>
              <Blocks blocks={section.blocks} />
            </section>
          ))}
        </article>
        <nav class="legal__nav" aria-label={t('legal.nav')}>
          <a href="/">{t('legal.back')}</a>
          <a href={`/${other}`}>{t(`legal.${other}`)}</a>
        </nav>
      </main>
    </div>
  )
}
