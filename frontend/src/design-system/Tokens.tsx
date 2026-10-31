import { useLayoutEffect, useState } from 'preact/hooks'
import { contrastRatio } from '../lib/contrast.ts'
import { useTheme } from '../useTheme.ts'

const GROUPS: [string, string[]][] = [
  ['surface', ['--color-bg', '--color-band-b', '--color-surface', '--color-raised', '--color-hover', '--color-selected-bg']],
  ['ink', ['--color-text', '--color-text-dim', '--color-muted', '--color-accent', '--color-warn', '--color-danger']],
  ['users', ['--user-1', '--user-2', '--user-3', '--user-4', '--user-5', '--user-6']],
  ['rules', ['--color-border', '--color-border-strong', '--color-control-border', '--color-focus']],
]

const SPACES = ['1', '2', '3', '4', '6', '8', '12', '16']
const SURFACES = new Set(GROUPS[0][1])

/** Reads the live token values, so the swatches always show the active theme. */
function useTokenValues(theme: string): Record<string, string> {
  const [values, setValues] = useState<Record<string, string>>({})
  useLayoutEffect(() => {
    const style = getComputedStyle(document.documentElement)
    setValues(Object.fromEntries(GROUPS.flatMap(([, names]) => names).map((n) => [n, style.getPropertyValue(n).trim()])))
  }, [theme])
  return values
}

function ratio(fg: string, bg: string) {
  try {
    return contrastRatio(fg, bg).toFixed(1)
  } catch {
    return '–'
  }
}

export function Swatches() {
  const theme = useTheme()
  const values = useTokenValues(theme)
  const bg = values['--color-bg'] ?? '#000000'
  return (
    <div class="ds-swatches">
      {GROUPS.map(([group, names]) => (
        <div class="ds-swatch-group" key={group}>
          {names.map((name) => (
            <div class="ds-swatch" key={name}>
              <span class="ds-swatch__chip" style={{ background: `var(${name})` }} />
              <code class="ds-swatch__name">{name.replace('--color-', '').replace('--', '')}</code>
              <code class="ds-swatch__value">{values[name]}</code>
              {!SURFACES.has(name) && values[name] && (
                <span class="ds-swatch__ratio" title="contrast on --color-bg">
                  {ratio(values[name], bg)}:1
                </span>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

export function Scales() {
  return (
    <div class="ds-scales">
      <div class="ds-spaces">
        {SPACES.map((s) => (
          <div class="ds-space" key={s}>
            <code>space-{s}</code>
            <span class="ds-space__bar" style={{ inlineSize: `var(--space-${s})` }} />
          </div>
        ))}
      </div>
      <div class="ds-radii">
        {['0', '1', '2'].map((r) => (
          <div class="ds-radius" key={r} style={{ borderRadius: `var(--radius-${r})` }}>
            <code>radius-{r}</code>
          </div>
        ))}
      </div>
    </div>
  )
}
