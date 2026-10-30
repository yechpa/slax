// @vitest-environment node
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { afterAll, describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDirs: string[] = []

async function buildInto(mode?: string): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), 'slax-build-'))
  outDirs.push(outDir)
  await build({ root, mode, logLevel: 'silent', build: { outDir, emptyOutDir: true } })
  return outDir
}

afterAll(() => outDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })))

describe('production build', () => {
  it('ships the app but not the design-system kitchen sink', async () => {
    const out = await buildInto()
    expect(existsSync(join(out, 'index.html'))).toBe(true)
    expect(existsSync(join(out, 'design-system.html'))).toBe(false)
    expect(existsSync(join(out, 'app-preview.html'))).toBe(false)
    expect(existsSync(join(out, 'fonts', 'OFL.txt'))).toBe(true)
  }, 60_000)

  it('builds the kitchen sink only in the design-system mode (used by make screenshots)', async () => {
    const out = await buildInto('design-system')
    expect(existsSync(join(out, 'design-system.html'))).toBe(true)
    expect(existsSync(join(out, 'app-preview.html'))).toBe(true)
  }, 60_000)
})
