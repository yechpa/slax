# Slax design system

The look of an old monitor, built with modern CSS. Two themes, three languages (one of them right to left), one monospace typeface.

- **Kitchen sink:** `frontend/design-system.html` (dev server: `/design-system.html`; `?theme=listing&lang=he` picks a combination). It is a second Vite entry and the app never links to it.
- **Review screenshots:** `make screenshots` builds the frontend and captures `docs/design/` with headless Chromium in the official Playwright image. Playwright is installed inside that container only, so it is not an app dependency. You get six 1280×900 shots (`{console,listing}-{en,he,fr}.png`), their full-page versions under `docs/design/full/`, and `mobile-console-fr.png` at 390×844.
- **Code:** tokens and styles are in `frontend/src/styles/`, reusable components in `frontend/src/components/ui/`, i18n in `frontend/src/i18n/`, and the theme logic in `frontend/src/theme.ts`.

> Status: first version, submitted for yechpa's review before Task 9. The Hebrew strings in particular are a proposal, not final.

## Principles

1. **A terminal, not a costume.** The UI is dense, monospace, 1px rules, 0–4px radii and ASCII affordances: `> slax_`, `[channels]`, `#general`, `[🚀 3]`, `-> 3 replies`, `$` at the composer prompt, and a block cursor. It uses no gradients-on-glass, no blur and no soft shadows. The only shadow is a hard 4px one under toasts.
2. **Effects stay subtle.** The console gets a faint phosphor glow on accent text and static scanlines over the application frame. The listing gets paper bands and tractor-feed holes. Every effect stays behind the text and keeps WCAG AA.
3. **Logical by construction.** Only `inline`/`block` and `start`/`end` are used, never `left` or `right`, so Hebrew is a mirror and not a special case.
4. **Text is data.** Translations are plain text. User content is never translated and is never trusted for direction.

## Themes and palettes

`setTheme('console' | 'listing')` sets `data-theme` on `<html>` and persists the choice in `localStorage` as `slax.theme`. Until the user chooses, the theme follows `prefers-color-scheme` live: dark gives `console` and light gives `listing`. Storage that throws on read or write is tolerated: the choice then lasts for the page only. Each theme sets `color-scheme`, so native controls and scrollbars match.

| Token | Console (dark) | Listing (light) | Use |
|---|---|---|---|
| `--color-bg` | `#0b0f0d` | `#f6f9ef` | page, message list |
| `--color-band-a` / `--color-band-b` | `#0b0f0d` / `#0b0f0d` | `#f6f9ef` / `#e3efd6` | paper bands (42px, two text lines) |
| `--color-surface` | `#0e1411` | `#eef4e5` | sidebar, headers |
| `--color-raised` | `#111a15` | `#fbfdf7` | inputs, composer, toasts, chips |
| `--color-hover` | `#0f1814` | `#e6efdb` | hovered rows |
| `--color-selected-bg` / `-fg` | `#12201a` / `#4ade80` | `#2d5a1b` / `#f6f9ef` | current channel |
| `--color-text` | `#d7e3dc` | `#1a2a14` | body text |
| `--color-text-dim` | `#8fa89a` | `#34502a` | secondary text, sidebar |
| `--color-muted` | `#6f8c7c` | `#4d6a3b` | timestamps, hints, labels |
| `--color-accent` (`-strong`, `-ink`) | `#4ade80` (`#86efac`, `#04140a`) | `#2d5a1b` (`#1f4512`, `#f6f9ef`) | brand, links, primary button |
| `--color-warn` | `#facc15` | `#7a4f00` | reactions, away |
| `--color-danger` (`-ink`) | `#f87171` (`#1a0505`) | `#a3221a` (`#fff8f5`) | errors, destructive actions, "new messages" rule |
| `--color-mention-bg` / `-fg` | `#14281c` / `#86efac` | `#d3e6c1` / `#1f4512` | `@mentions` |
| `--color-border` / `-strong` | `#1b2a23` / `#2a4034` | `#6b8a55` / `#4d6a3b` | decorative rules |
| `--color-control-border` | `#557565` | `#5a7a45` | input, button and chip outlines (≥ 3:1) |
| `--color-focus` | `#4ade80` | `#2d5a1b` | focus ring |
| `--user-1` … `--user-6` | `#7dd3fc` `#f0abfc` `#fdba74` `#a5b4fc` `#5eead4` `#fca5a5` | `#075985` `#86198f` `#9a3412` `#3730a3` `#115e59` `#9f1239` | usernames and avatars (`userHue(id)`) |
| `--rule-style` | `solid` | `dashed` | every rule follows the theme |
| `--glow`, `--glow-soft` | green text-shadow | `none` | brand, current channel, focused composer |
| `--scanlines` | 1px line every 3px, 16% black | `none` | over the application frame only |
| `--paper`, `--paper-holes` | `none` | bands, sprocket holes | message list |

The values come from the approved mockups (`visual-direction.html` card C, `light-theme.html` card 2). There are three deliberate departures:

- The console's muted grey `#5f7a6c` measured 4.12:1 on the background, so it was lifted to `#6f8c7c`.
- The listing's mockup grey `#6b8a55` is too light for text (3.3:1 on a green band). It stays for the dashed rules, and text uses `#4d6a3b`.
- The mockup's pale usernames do not work on paper, so the listing uses darker inks of the same six hues.

### Contrast (WCAG 2.2)

`src/styles/contrast.test.ts` parses `tokens.css` and checks every pair below for both themes. Text pairs need at least 4.5:1 (AA). UI boundaries (control borders, focus ring) need at least 3:1. Changing a token so that a pair drops below its minimum fails the build. The kitchen sink also prints each ink token's live ratio against `--color-bg`.

| Pair | Console | Listing |
|---|---|---|
| text on bg | 14.62 | 14.23 |
| text on band-b (darker band) | 14.62 | 12.69 |
| text-dim on surface | 7.31 | 8.04 |
| muted on bg / band-b / raised | 5.25 / 5.25 / 4.84 | 5.73 / 5.11 / 5.96 |
| accent on bg | 11.07 | 7.61 |
| accent-ink on accent (primary button) | 10.86 | 7.61 |
| selected-fg on selected-bg | 9.66 | 7.61 |
| warn on band-b | 12.60 | 5.97 |
| danger on band-b | 6.98 | 6.28 |
| lowest username hue on any background | 9.35 | 6.12 |
| control-border on raised (3:1) | 3.48 | 4.76 |
| focus on surface (3:1) | 10.69 | 7.22 |

Body text reaches at least 12.7:1 on **both** paper bands. The bands are a texture and never compromise reading.

## Type

**Font: Cascadia Mono** (Microsoft, SIL Open Font License 1.1), self-hosted from `frontend/public/fonts/` with the licence in `OFL.txt`. The files are the unmodified WOFF2 subsets from `@fontsource/cascadia-mono` 5.3.0. No request goes to a third-party CDN, which matters for privacy and for a strict CSP later.

Why this font, after rendering `שלום hello 123 — k3s נבדק` side by side:

| Candidate | Hebrew | Verdict |
|---|---|---|
| **Cascadia Mono** | Native, **true monospace** (Hebrew letters on the same 1200-unit advance as Latin) | Chosen. It is one design, so Hebrew and Latin share stroke, height and rhythm, and the grid holds in mixed lines. It is modern and very legible. |
| IBM Plex Mono + IBM Plex Sans Hebrew | The Hebrew is proportional (narrow `י`, wide `ש`) | Harmonious strokes, but mixed lines lose the monospace grid. It also means two families to keep in step. |
| DejaVu Sans Mono | **No Hebrew** (falls back to another font) | Rejected. |
| Liberation Mono | Has Hebrew | A Courier New metric clone. Looks dated and plain next to Cascadia. |

- **Weights:** 300 for text and 700 for emphasis. Cascadia's Regular (400) has heavy stems that look bold on screen, while its Light (300) matches the weight of a classic terminal font. Only two weights are shipped. `font-synthesis: none` avoids fake bolds, and the design uses no italics: `em` is rendered as a dotted underline.
- **Payload:** six files, **90,480 bytes in total**:

  | Subset | 300 | 700 |
  |---|---|---|
  | Latin | 16,704 | 17,076 |
  | Latin-Ext | 20,704 | 20,660 |
  | Hebrew | 7,572 | 7,764 |

  Thanks to `unicode-range`, a browser downloads only what is on screen. An English or French page needs Latin only (33.8 KB; French accents are in Latin-1). A Hebrew page adds 15.3 KB. The two Latin files are `<link rel=preload>`ed, and every face uses `font-display: swap`.
- **Fallback stack:** `'Cascadia Mono', ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', 'DejaVu Sans Mono', monospace`.

### Scale (rem; 1rem = 16px)

| Token | Size | Use |
|---|---|---|
| `--text-2xs` | 11px | badges, key caps, composer hint |
| `--text-xs` | 12px | timestamps, section labels, captions, reactions |
| `--text-sm` | 13px | sidebar, buttons, inputs |
| `--text-base` | 14px | message bodies (default) |
| `--text-md` | 16px | channel title, `h2` |
| `--text-lg` | 20px | specimens |
| `--text-xl` | 26px | `h1` |
| `--text-2xl` | 36px | page titles only |

Line height is 1.5 (`--leading`) and 1.25 for headings (`--leading-tight`). Ligatures are off: `->` stays two characters.

## Spacing, shape, sizes

- **Spacing** uses a 4px base: `--space-0-5` (2px), `-1` (4), `-2` (8), `-3` (12), `-4` (16), `-5` (20), `-6` (24), `-8` (32), `-10` (40), `-12` (48), `-16` (64).
- **Radii:** `--radius-0` 0, `--radius-1` 2px (controls, chips), `--radius-2` 4px (maximum). Presence dots are the only circles.
- **Borders:** 1px everywhere (`--border-width`). Rules are solid in the console and dashed in the listing (`--rule-style`). The current channel gets a 2px `border-inline-start`, and toasts get a 3px tone bar on the inline start.
- **Sizes:** `--control-height` 32px, `--control-height-sm` 24px, `--avatar-size` 32px, `--sidebar-size` 15.5rem.

## Focus

Every interactive element shows `:focus-visible` as a 2px solid `--color-focus` outline with a 2px offset. Inputs use offset 0, and the focused composer gets a 2px ring plus a soft glow in the console. Mouse focus shows no ring. The language and theme choices are native radio groups drawn as segmented buttons, so they take one Tab stop and arrow keys move between options. A skip link ("Skip to messages") appears on the first Tab.

## Motion

- **Motion is opt-in.** Every animation is declared inside `@media (prefers-reduced-motion: no-preference)`. A global reduced-motion rule in `base.css` is the safety net.
- **What moves:**
  - the composer's block cursor (a `steps(1)` blink, 1.06s)
  - the typing dots (stepped pulse)
  - the "scanning" tick on a file chip
  - 120ms colour and border transitions on hover
- **What stays still:** scanlines are static, nothing flickers, nothing slides in, and there is no parallax.
- **With reduced motion:** the cursor stays a solid block and the dots stay dim.

## Right to left

- `setLocale('he')` sets `<html lang="he" dir="rtl">`, and `en` and `fr` set `dir="ltr"`. The layout mirrors with no extra CSS: the sidebar moves to the right, the current-channel bar moves to the right edge, and toasts anchor bottom-left.
- **Logical properties only.** Use `margin-inline-start`, `padding-block`, `inset-inline-end`, `border-inline-start`, `text-align: start`, `float: inline-start`. `src/styles/styles.test.ts` fails on any physical `left`/`right` property, positioning, `float`, `clear` or `text-align` anywhere under `src/` (the test checks that its detector catches each form). Vertical shadows and gradients (`to bottom`) are direction-neutral and allowed. Symmetric backgrounds (holes on both paper edges) are too.
- **Logical properties resolve against the element's own direction.** Never force `direction: ltr` on something you position with `inset-inline-*`: in Hebrew it lands on the wrong side. This happened to the search key cap; `kbd` is now isolated without forcing a direction.
- **Every message body is `dir="auto"`**, so its direction comes from its first strong letter. The body box is shrink-wrapped (`inline-size: fit-content`, capped at 76ch), so an English message in the Hebrew UI, or the reverse, still sits beside its author.
- **Usernames, channel names, file names and file sizes are in `<bdi>`.** Without it, `1.2 MB` prints as `MB 1.2` in a Hebrew line.
- **Links in a message are `dir="ltr"`**, which also isolates them.
- **Code is `direction: ltr`.**
- **Interpolated values are isolated too.** `t()` wraps them in FSI/PDI (U+2068/U+2069), the plain-text `<bdi>`. That keeps `"נעם is typing…"` or `"dana מקליד/ה…"` in order even in a `title` or `aria-label`.
- **Directional glyphs:** `>`, `->`, `[ ]` and `( )` are Unicode *Bidi_Mirrored* characters. Write them once, in logical order, and the browser draws the mirror in RTL: `> slax_` becomes `slax_ <` and `-> 3 replies` becomes `3 תשובות <-`. Never swap them by hand, or they flip twice. Use a `:dir(rtl)` rule only for glyphs that are not mirrored, such as arrows like `→`. None are used yet.
- **The composer's textarea** follows the page direction while empty, so the caret and the drawn placeholder start on the same side. Once text is typed, it is `dir="auto"`.

## i18n

- `t(key, params?)` returns plain text. Values are inserted verbatim and never parsed as HTML (there is no `innerHTML` anywhere), and placeholders inside values are not re-expanded.
- `plural(key, n, params?)` picks a CLDR form with `Intl.PluralRules`. Plural entries are objects: Hebrew has `one`/`two`/`other`, while English and French have `one`/`other`. French treats 0 as singular, and an absent form (French `many` for millions) falls back to `other`.
- A missing key falls back to English, then to the key itself.
- The initial locale is a stored choice (`slax.locale`), otherwise the first of `navigator.languages` among `he` (or legacy `iw`), `fr` and `en`.
- The three JSON files must have identical key sets, the same placeholders, and no empty strings. All of this is tested.
- Numbers and times are formatted for the locale (`formatTime` is always 24-hour, `formatBytes` gives localised units).

## Components (`frontend/src/components/ui/`)

All components are presentational Preact components, one job each, for Task 9 to compose:

- `Brand`
- `Cursor`
- `Button` (`primary`, `secondary`, `quiet` = `[ bracketed ]`, `danger`; `sm`; `icon`)
- `TextField` (label, hint, error with `aria-invalid` and `aria-describedby`)
- `SearchField` (key cap)
- `Segmented`, `LocaleSwitcher`, `ThemeSwitcher`
- `PresenceDot`: online is filled, away is half-filled and offline is hollow, so the state never relies on colour alone
- `Avatar`
- `NavItem`: current, unread with badge, muted, DM with presence
- `Message`: avatar, `<bdi>` author, `<time>`, edited marker, `dir="auto"` body, footer, hover/focus toolbar
- `ReactionChip`: `aria-pressed` when mine
- `ThreadLink`
- `Tombstone`
- `Divider` (day, unread)
- `TypingIndicator`: keeps its line, so nothing jumps
- `FileChip`: ready, scanning, error
- `Toast`: errors use `role=alert`, others `role=status`
- `Composer`
- `EmptyState`

Layout classes: `.shell` collapses below 44rem *of its own width* (a container query): the sidebar becomes an overlay opened from the channel header.
