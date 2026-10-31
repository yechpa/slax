import type { Locale } from '../i18n/index.ts'
import { en } from './en.ts'
import { fr } from './fr.ts'
import { he } from './he.ts'
import type { LegalDocument, LegalPage, LegalText } from './types.ts'

const texts: Record<Locale, LegalText> = { en, he, fr }

export const legalDocument = (page: LegalPage, locale: Locale): LegalDocument => texts[locale][page]
export { texts as legalTexts }
