import { describe, expect, it } from 'vitest'
import { parseRoute } from '../router.ts'
import { legalTexts } from './index.ts'
import { CONTACT_URL, type Block, type LegalPage } from './types.ts'

const PAGES: LegalPage[] = ['privacy', 'terms']
const shape = (block: Block) => (typeof block === 'string' ? 'p' : `ul${block.length}`)

describe('legal routes', () => {
  it('legal_paths_are_routes_with_or_without_a_trailing_slash', () => {
    expect(parseRoute('/privacy')).toEqual({ name: 'legal', page: 'privacy' })
    expect(parseRoute('/terms/')).toEqual({ name: 'legal', page: 'terms' })
    expect(parseRoute('/privacy/x').name).toBe('unknown')
    expect(parseRoute('/Privacy').name).toBe('unknown')
  })
})

describe('legal texts', () => {
  it.each(PAGES)('%s_says_the_same_things_in_the_same_order_in_en_he_fr', (page) => {
    const reference = legalTexts.en[page]
    for (const locale of ['he', 'fr'] as const) {
      const other = legalTexts[locale][page]
      expect(other.updated, locale).toBe(reference.updated)
      expect(other.sections.map((s) => s.id), locale).toEqual(reference.sections.map((s) => s.id))
      other.sections.forEach((section, i) => {
        expect(section.blocks.map(shape), `${locale} ${section.id}`).toEqual(reference.sections[i].blocks.map(shape))
      })
    }
  })

  it.each(PAGES)('%s_has_no_empty_text_and_a_valid_date', (page) => {
    for (const locale of ['en', 'he', 'fr'] as const) {
      const doc = legalTexts[locale][page]
      expect(doc.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(doc.title.trim()).not.toBe('')
      expect(doc.intro.trim()).not.toBe('')
      for (const section of doc.sections) {
        expect(section.heading.trim()).not.toBe('')
        for (const block of section.blocks) {
          for (const text of typeof block === 'string' ? [block] : block) expect(text.trim(), `${locale} ${section.id}`).not.toBe('')
        }
      }
    }
  })

  it('privacy_names_the_facts_a_person_can_check', () => {
    // The numbers come from the chart and the scheduler: if one changes, this text must too.
    const text = JSON.stringify(legalTexts.en.privacy)
    expect(text).toContain('03:00 UTC')
    expect(text).toContain('35 days') // bucket lifecycle rule, deploy/aws/provision.sh
    expect(text).toContain('180 days') // SLAX_AUDIT_RETENTION_DAYS
    expect(text).toContain('14 days') // session.lifetimeMinutes
    expect(legalTexts.he.privacy.sections.find((s) => s.id === 'demo')?.blocks[0]).toContain('03:00 UTC')
    expect(legalTexts.fr.privacy.sections.find((s) => s.id === 'demo')?.blocks[0]).toContain('03:00 UTC')
  })

  it('contact_is_a_public_https_address', () => {
    expect(CONTACT_URL).toBe('https://github.com/yechpa')
  })
})
