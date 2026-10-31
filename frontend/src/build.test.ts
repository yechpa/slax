// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, resolveConfig } from 'vite'
import { afterAll, describe, expect, it } from 'vitest'
import { precacheManifest } from '../plugins/service-worker.ts'

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
  // One production build for the two tests below (builds are slow, and Vitest runs files in parallel).
  let production: Promise<string> | undefined
  const productionBuild = () => (production ??= buildInto())

  it('ships the app but not the design-system kitchen sink', async () => {
    const out = await productionBuild()
    expect(existsSync(join(out, 'index.html'))).toBe(true)
    expect(existsSync(join(out, 'design-system.html'))).toBe(false)
    expect(existsSync(join(out, 'app-preview.html'))).toBe(false)
    expect(existsSync(join(out, 'fonts', 'OFL.txt'))).toBe(true)
  }, 60_000)

  it('ships the service worker at /sw.js: a classic script carrying its versioned precache list', async () => {
    const out = await productionBuild()
    const sw = readFileSync(join(out, 'sw.js'), 'utf8')
    // A classic script (registered without type: 'module', for every browser): no import/export.
    expect(sw).not.toMatch(/^\s*(import|export)\b/m)
    const { files, version } = precacheManifest(out)
    expect(files).toContain('/index.html')
    expect(files).toContain('/favicon.svg')
    expect(files).toContain('/manifest.webmanifest')
    expect(files.filter((file) => file.startsWith('/assets/') && file.endsWith('.js')).length).toBeGreaterThan(0)
    expect(files.filter((file) => file.startsWith('/fonts/') && file.endsWith('.woff2')).length).toBe(6)
    // Not the worker itself, nor what the page never loads.
    expect(files).not.toContain('/sw.js')
    expect(files.filter((file) => /\.(map|txt|png)$/.test(file))).toEqual([])
    const quoted = (text: string) => new RegExp(`[\`"']${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\`"']`)
    for (const file of files) expect(sw).toMatch(quoted(file))
    expect(sw).toMatch(quoted(version))
  }, 60_000)

  it('refuses VITE_E2E in any build but the end-to-end one, so production can never carry it', async () => {
    process.env.VITE_E2E = 'true'
    try {
      await expect(buildInto()).rejects.toThrow(/VITE_E2E is reserved for the end-to-end build/)
      await expect(buildInto('design-system')).rejects.toThrow(/VITE_E2E is reserved/)
    } finally {
      delete process.env.VITE_E2E
    }
  }, 60_000)

  it('refuses VITE_E2E from the .env files Vite reads, wherever the build runs from', async () => {
    // The env files are read from envDir (the root by default), not from the working directory.
    const envDir = mkdtempSync(join(tmpdir(), 'slax-env-'))
    outDirs.push(envDir)
    writeFileSync(join(envDir, '.env.production.local'), 'VITE_E2E=true\n')
    const outDir = mkdtempSync(join(tmpdir(), 'slax-build-'))
    outDirs.push(outDir)
    await expect(build({ root, envDir, logLevel: 'silent', build: { outDir, emptyOutDir: true } })).rejects.toThrow(/VITE_E2E is reserved/)
  }, 60_000)

  it('builds the end-to-end app (make e2e) into its own directory, never dist', async () => {
    const config = await resolveConfig({ root, mode: 'e2e', logLevel: 'silent' }, 'build')
    expect(config.build.outDir).toMatch(/dist-e2e$/)
    expect(config.define?.['import.meta.env.VITE_E2E']).toBe('"true"')
    const production = await resolveConfig({ root, logLevel: 'silent' }, 'build')
    expect(production.define?.['import.meta.env.VITE_E2E']).toBeUndefined()
  }, 60_000)

  it('builds the kitchen sink only in the design-system mode (used by make screenshots)', async () => {
    const out = await buildInto('design-system')
    expect(existsSync(join(out, 'design-system.html'))).toBe(true)
    expect(existsSync(join(out, 'app-preview.html'))).toBe(true)
    // No service worker for the screenshots' build.
    expect(existsSync(join(out, 'sw.js'))).toBe(false)
  }, 60_000)
})
