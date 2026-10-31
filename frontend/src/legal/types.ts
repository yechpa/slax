/**
 * The two public legal pages (/privacy, /terms), one document per language. Kept out of the
 * flat i18n dictionaries: they are long, and what matters is that the three languages say the
 * same things in the same order (legal.test.ts compares their shape).
 */
export type Block = string | string[] // a paragraph, or a bullet list

export interface Section {
  /** The anchor (`#id`) and what the test pairs the languages by. */
  id: string
  heading: string
  blocks: Block[]
}

export interface LegalDocument {
  title: string
  /** The last change, as YYYY-MM-DD. */
  updated: string
  intro: string
  sections: Section[]
}

export type LegalPage = 'privacy' | 'terms'
export type LegalText = Record<LegalPage, LegalDocument>

/** Where a person reaches whoever runs Slax: the public profile of its maintainer. */
export const CONTACT_URL = 'https://github.com/yechpa'
