// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { precacheManifest } from '../../plugins/service-worker.ts'

let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function tree(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), 'slax-precache-'))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  return dir
}

const BUILD = {
  'index.html': '<html></html>',
  'assets/index-abc.js': 'js',
  'assets/index-abc.js.map': '{}',
  'assets/index-def.css': 'css',
  'fonts/cascadia.woff2': 'font',
  'fonts/OFL.txt': 'licence',
  'icons/icon-192.png': 'png',
  'favicon.svg': '<svg/>',
  'manifest.webmanifest': '{}',
  'sw.js': 'old worker',
  'design-system.html': '<html></html>',
  '.vite/manifest.json': '{}',
}

describe('precacheManifest', () => {
  it('lists what the page loads, sorted, as absolute paths', () => {
    expect(precacheManifest(tree(BUILD)).files).toEqual([
      '/assets/index-abc.js',
      '/assets/index-def.css',
      '/favicon.svg',
      '/fonts/cascadia.woff2',
      '/index.html',
      '/manifest.webmanifest',
    ])
  })

  it('gives the same version for the same files', () => {
    const first = precacheManifest(tree(BUILD)).version
    rmSync(dir, { recursive: true })
    expect(precacheManifest(tree(BUILD)).version).toBe(first)
    expect(first).toMatch(/^[0-9a-f]{16}$/)
  })

  it('changes the version when any precached file changes, and only then', () => {
    const base = precacheManifest(tree(BUILD)).version
    rmSync(dir, { recursive: true })
    expect(precacheManifest(tree({ ...BUILD, 'index.html': '<html>v2</html>' })).version).not.toBe(base)
    rmSync(dir, { recursive: true })
    expect(precacheManifest(tree({ ...BUILD, 'fonts/OFL.txt': 'other licence', 'sw.js': 'x' })).version).toBe(base)
  })
})
