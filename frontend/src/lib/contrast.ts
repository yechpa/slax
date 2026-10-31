/**
 * WCAG 2.x contrast ratio between two opaque sRGB colours written as hex.
 * https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio
 */

function channels(hex: string): [number, number, number] {
  const m = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(hex.trim())
  if (!m) throw new Error(`not an opaque hex colour: ${hex}`)
  const digits = m[1].length === 3 ? [...m[1]].map((d) => d + d).join('') : m[1]
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16) / 255) as [number, number, number]
}

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)

export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map(linear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
